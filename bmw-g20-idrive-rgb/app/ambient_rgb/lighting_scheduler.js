'use strict';
/**
 * lighting_scheduler.js - the write queue between "what the lights should show" and the diagnostic transport.
 *
 * Why it exists (measured and read, PROTOCOL_FINDINGS.md): the BDC answers a write in ~14 ms over ENET; the head
 * unit's TASU gateway takes ONE request at a time (kit/diag.js: a second request while one is in flight is turned
 * away with APP_REQUEST_TEMPORARILY_NOT_ACCEPTED); and a positive reply to 2E DA5E is "6E DA 5E" with no NAD in it, so
 * two writes to the same DID in flight at once could not be told apart anyway. So the scheduler sends one write at a
 * time by default (maxInFlight 1), keeps a queue per module key with the NEWEST target winning, and spends its
 * cleverness on not sending what need not be sent:
 *
 *   - set(key, slave, params, prio): one module's next target; a later set() for the same key replaces it (coalescing)
 *   - frame(targets, id): an animation frame: replaces every queued 'frame' item at once, so a frame the transport
 *     could not keep up with is dropped whole, never half-written late (obsolete frames)
 *   - priorities: 'release' (hand modules back) > 'apply' (a confirmed configuration) > 'frame' (animation)
 *   - unchanged targets are skipped unless `force` (the keep-alive forces a refresh before ZEIT lapses)
 *   - BUSY (NRC 21 from the BDC, or the transport turning the request away before it was sent): the item goes back
 *     on the queue after a growing pause, at most maxBusyRetries times (0 = never); a refusal is counted and reported
 *   - NO REPLY is never a reason to send again. A write that got no answer may well have been taken, so it is
 *     recorded as 'unanswered' (last.unanswered) and counted as written for the purpose of not repeating it: the
 *     module is next written when its target changes or when its keep-alive is due anyway. Whether it took is for
 *     the controller's read-back to say.
 *   - maxCommandMs: no single write is waited for longer than this, whatever the transport does (it then counts as
 *     unanswered), so one stuck request cannot hold the queue
 *   - pause()/resume() for a lost transport; clear() drops everything queued; drain() resolves when nothing is
 *     queued or in flight (restoreOem waits for it, so "released" is only reported once it is true)
 *   - stats for the diagnostics page: writes, accepted, rejected, busy, timeouts, dropped, latency, writes per second
 *
 * maxInFlight > 1 is allowed for experiments (per-bus queues keep ordering within a bus); it is NOT the default and
 * the TASU evidence says it would only produce busy verdicts. Benchmarks: tests/node/test_scheduler.js.
 */
const EventEmitter = require('events');

const PRIO = Object.freeze({ release: 0, apply: 1, frame: 2 });

class WriteScheduler extends EventEmitter {
    /**
     * opts.writer(slave, params) -> Promise<{ ok, nrc?, reason?, bytes? }>   the transport (kit/diag.js physical() behind it)
     * opts.maxInFlight (1), opts.minGapMs (0), opts.busyBackoffMs (200), opts.maxBusyRetries (3; 0 = no retry), opts.maxCommandMs (5000)
     * opts.now / setTimeout / clearTimeout for tests
     */
    constructor(opts) {
        super();
        const o = opts || {};
        if (typeof o.writer !== 'function') throw new Error('scheduler needs a writer');
        this.writer = o.writer;
        this.maxInFlight = Math.max(1, o.maxInFlight || 1);
        this.minGapMs = o.minGapMs || 0;
        this.busyBackoffMs = o.busyBackoffMs == null ? 200 : o.busyBackoffMs;
        this.maxBusyRetries = o.maxBusyRetries == null ? 3 : Math.max(0, Math.min(10, Number(o.maxBusyRetries) || 0));
        this.maxCommandMs = Math.max(250, o.maxCommandMs || 5000);
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this._setTimeout = o.setTimeout || setTimeout;
        this._clearTimeout = o.clearTimeout || clearTimeout;
        this._now = o.now || Date.now;
        this.queue = new Map();            // key -> item { key, slave, params, prio, seq, force, frameId, retries }
        this.inFlight = new Map();         // key -> item
        this.last = new Map();             // key -> { params, at, ok }   what was last written (accepted or not)
        this.paused = false;
        this.frameId = 0;
        this._seq = 0;
        this._timer = null;
        this._drains = [];
        this._lastSendAt = null;
        this.stats = { writes: 0, accepted: 0, rejected: 0, busy: 0, busyGivenUp: 0, timeouts: 0, dropped: 0, skipped: 0, latencyMs: null, avgLatencyMs: null, writesPerSec: 0 };
        this._window = [];                 // send times of the last few seconds, for writes per second
    }

    /* ---------- enqueue ---------- */
    _same(a, b) { return !!a && !!b && a.active === b.active && a.r === b.r && a.g === b.g && a.b === b.b && a.brightness === b.brightness; }
    _put(key, slave, params, prio, force, frameId) {
        const existing = this.queue.get(key);
        if (existing) {
            // newest target wins; the module keeps its place in the queue (a module that keeps changing cannot starve the rest)
            // and the higher of the two priorities
            existing.params = params; existing.slave = slave; existing.force = existing.force || !!force; existing.frameId = frameId || existing.frameId;
            if (PRIO[prio] < PRIO[existing.prio]) existing.prio = prio;
            return;
        }
        this.queue.set(key, { key, slave, params, prio, seq: ++this._seq, force: !!force, frameId: frameId || 0, retries: 0 });
    }
    /** One module's next target. prio: 'release' | 'apply' | 'frame'. force: write even if unchanged (keep-alive). */
    set(key, slave, params, prio, force) {
        const l = this.last.get(key) || {};
        if (!this._same(params, l.params) || force || !(l.ok || l.unanswered)) this._put(key, slave, params, prio || 'apply', force);
        else this.stats.skipped++;
        this._pump();
    }
    /**
     * An animation frame: targets = [{ key, slave, params }]. Queued 'frame' items of older frames are dropped (an
     * obsolete frame is never sent late); unchanged modules are skipped unless listed in `forceKeys`.
     */
    frame(targets, forceKeys) {
        const id = ++this.frameId;
        let dropped = 0;
        this.queue.forEach((it, k) => { if (it.prio === 'frame') { this.queue.delete(k); dropped++; } });
        this.stats.dropped += dropped;
        const force = new Set(forceKeys || []);
        targets.forEach((t) => {
            const lastOk = (this.last.get(t.key) || {});
            if (force.has(t.key) || !(lastOk.ok || lastOk.unanswered) || !this._same(t.params, lastOk.params)) this._put(t.key, t.slave, t.params, 'frame', force.has(t.key), id);
            else this.stats.skipped++;
        });
        this._pump();
        return { id, queued: this.queue.size, dropped };
    }
    /** Hand modules back to OEM: ZUSTAND 0, ZEIT 0, ahead of everything else. */
    release(slaves) {
        slaves.forEach((s) => this._put(s.bus + ':' + s.nad, s, { active: false, r: 0, g: 0, b: 0, brightness: 0, seconds: 0 }, 'release', true));
        this._pump();
    }

    /* ---------- control ---------- */
    pause() { this.paused = true; this._stopTimer(); }
    resume() { this.paused = false; this._pump(); }
    /** Drop everything queued (not what is in flight). */
    clear(prio) {
        let n = 0;
        this.queue.forEach((it, k) => { if (!prio || it.prio === prio) { this.queue.delete(k); n++; } });
        this.stats.dropped += n;
        this._settleDrains();
        return n;
    }
    /** Resolves once nothing is queued and nothing is in flight. */
    drain() {
        if (!this.queue.size && !this.inFlight.size) return Promise.resolve();
        return new Promise((resolve) => this._drains.push(resolve));
    }
    forget(key) { this.last.delete(key); }
    _settleDrains() { if (!this.queue.size && !this.inFlight.size) { const d = this._drains; this._drains = []; d.forEach((r) => r()); } }
    _stopTimer() { if (this._timer) { this._clearTimeout(this._timer); this._timer = null; } }

    /* ---------- sending ---------- */
    _next() {
        let best = null;
        this.queue.forEach((it) => {
            if (this.inFlight.has(it.key)) return;                       // one write per module at a time
            if (it.notBefore && it.notBefore > this._now()) return;        // busy backoff
            if (this.maxInFlight > 1 && it.slave && Array.from(this.inFlight.values()).some((f) => f.slave && f.slave.bus === it.slave.bus)) return;   // per-bus ordering
            if (!best || PRIO[it.prio] < PRIO[best.prio] || (PRIO[it.prio] === PRIO[best.prio] && it.seq < best.seq)) best = it;
        });
        return best;
    }
    _pump() {
        if (this.paused) return;
        while (this.inFlight.size < this.maxInFlight) {
            const gap = this._lastSendAt == null ? Infinity : this._now() - this._lastSendAt;
            if (gap < this.minGapMs) { this._arm(this.minGapMs - gap); return; }
            const it = this._next();
            if (!it) { this._armBackoff(); return; }
            this.queue.delete(it.key);
            this.inFlight.set(it.key, it);
            this._send(it);
        }
    }
    _arm(ms) { if (this._timer) return; this._timer = this._setTimeout(() => { this._timer = null; this._pump(); }, ms); }
    _armBackoff() {
        let soonest = null;
        this.queue.forEach((it) => { if (it.notBefore && (soonest == null || it.notBefore < soonest)) soonest = it.notBefore; });
        if (soonest != null) this._arm(Math.max(1, soonest - this._now()));
    }
    async _send(it) {
        const t0 = this._now();
        this._lastSendAt = t0;
        this.stats.writes++;
        this._window.push(t0);
        while (this._window.length && this._window[0] < t0 - 5000) this._window.shift();
        this.stats.writesPerSec = Math.round(this._window.length / 5 * 10) / 10;
        let r;
        // (the safe maximum duration of one command: past it the write counts as unanswered and the queue moves on)
        let watchdog = null;
        const late = new Promise((resolve) => { watchdog = this._setTimeout(() => { watchdog = null; resolve({ ok: false, reason: 'timeout', late: true }); }, this.maxCommandMs); });
        try { r = await Promise.race([Promise.resolve().then(() => this.writer(it.slave, it.params)), late]); } catch (e) { r = { ok: false, reason: String(e && e.message || e) }; }
        if (watchdog) this._clearTimeout(watchdog);
        const dt = this._now() - t0;
        this.stats.latencyMs = dt;
        this.stats.avgLatencyMs = this.stats.avgLatencyMs == null ? dt : Math.round(this.stats.avgLatencyMs * 0.8 + dt * 0.2);
        this.inFlight.delete(it.key);
        if (r && r.ok) {
            this.stats.accepted++;
            this.last.set(it.key, { params: it.params, at: this._now(), ok: true });
            this.emit('written', it.key, it.params, r);
        } else if (r && (r.nrc === 0x21 || r.busy) && it.retries < this.maxBusyRetries) {
            this.stats.busy++;
            it.retries++;
            it.notBefore = this._now() + this.busyBackoffMs * it.retries;
            if (!this.queue.has(it.key)) this.queue.set(it.key, it);        // a newer target meanwhile wins
            this.emit('busy', it.key, it.retries);
        } else if (r && (r.reason === 'timeout' || r.reason === 'no reply')) {
            // no answer: NOT sent again. It may have been taken; the keep-alive (or a changed target) writes it next.
            this.stats.timeouts++;
            this.last.set(it.key, { params: it.params, at: this._now(), ok: false, unanswered: true, reason: 'timeout' });
            this.emit('unanswered', it.key, it.params, r);
        } else {
            if (r && (r.nrc === 0x21 || r.busy)) this.stats.busyGivenUp++;
            this.stats.rejected++;
            this.last.set(it.key, { params: it.params, at: this._now(), ok: false, nrc: r && r.nrc, reason: (r && r.reason) || (r && r.busy ? 'busy' : undefined) });
            this.emit('failed', it.key, it.params, r || { ok: false, reason: 'no result' });
        }
        this._settleDrains();
        this._pump();
    }

    /** Snapshot for the diagnostics page. */
    status() {
        return Object.assign({}, this.stats, { queued: this.queue.size, inFlight: this.inFlight.size, paused: this.paused, maxInFlight: this.maxInFlight, maxBusyRetries: this.maxBusyRetries, maxCommandMs: this.maxCommandMs, known: this.last.size });
    }
}

module.exports = { WriteScheduler, PRIO };

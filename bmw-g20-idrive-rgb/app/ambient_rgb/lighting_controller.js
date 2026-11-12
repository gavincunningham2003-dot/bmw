'use strict';
/**
 * lighting_controller.js - LightingController: what the UI talks to. One interface, three implementations:
 *
 *   lighting_mock.js      MockLightingController    a simulated BDC with the car's 19 modules; the whole app runs on it
 *   lighting_bdc_uds.js   BdcUdsLightingController  the real thing over the head unit's TASU diagnostic link
 *   lighting_someip.js    SomeIpLightingController  a probe for a native SOME/IP lighting service (none known yet)
 *
 * The controller knows only APPLIED state. Previews live in the UI: nothing here is called while the user browses,
 * and nothing reaches a module until apply(program) is called with a confirmed configuration.
 *
 *   program  = lighting_scene.js: { mode: 'solid' | 'dual' | 'zones' | 'rainbow' | 'fade' | 'breathing' | 'wave', ... }
 *   apply(program)     render the program to per-module targets, write them (scheduler, 'apply' priority), release the
 *                      modules it no longer covers, start the animation ticker for animated modes; resolves with what
 *                      was written and what failed
 *   restoreOem()       stop the ticker, drop queued frames, release every module this controller drove (ZUSTAND 0,
 *                      verified instant), wait for the transport, report exactly which releases were accepted
 *   keep-alive         static programs: a module is rewritten only when its last accepted write is older than
 *                      ZEIT * keepAliveFactor; animated programs: frames carry the refresh, and modules whose target
 *                      has not changed are forced in before they could lapse
 *
 * What the car established (PROTOCOL_FINDINGS.md 0.1): 2E DA5E / E3D1 drive one module for ZEIT seconds (~14 ms a
 * write over ENET), override the OEM lighting, hand back at once on ZUSTAND 0 and by themselves when ZEIT lapses.
 * The head unit's TASU path takes one request at a time (kit/diag.js), so the scheduler sends one write at a time.
 *
 * Operations are serialised (apply / restoreOem never interleave) and the timers / clock are injectable for tests.
 * Subclasses implement _probe(), _readSlaves(), _writeSlave(slave, params) and _available(), as before.
 */
const EventEmitter = require('events');
const S = require('./lighting_scene');
const { WriteScheduler } = require('./lighting_scheduler');
const PL = require('./lighting_plan');

const STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'error']);

class LightingController extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.kind = o.kind || 'base';
        this.refreshSeconds = Math.max(2, Math.min(254, o.refreshSeconds || 10));   // ZEIT sent with every write
        this.keepAliveFactor = o.keepAliveFactor || 0.5;                           // refresh a module once its write is this old
        this.frameMs = o.frameMs || 80;                                           // animation tick target; adapts to the measured round
        this.maxSlaveFailures = o.maxSlaveFailures || 3;
        this.maxRejects = o.maxRejects || 5;
        this.parkedPolicy = o.parkedPolicy || 'strict';                           // 'strict': no apply unless parked() === true
        this.parked = o.parked || null;                                          // fn() -> true | false | null (unknown)
        this.gate = o.gate || null;                                              // fn() -> null | why custom lighting must stay off (car left, factory lighting off, another controller)
        this.txMode = o.txMode === 'broadcast' ? 'broadcast' : 'individual';     // 'broadcast': NAD 0 where it saves writes (lighting_plan.js)
        this.broadcastOk = true;                                                 // false once the car refused a NAD 0 write
        this.deaf = new Set();                                                   // modules seen to miss a whole-bus write: written singly after it
        this.moveSeconds = Math.max(2, Math.min(30, o.moveSeconds || 10));       // ZEIT of a moving program's writes
        this.verify = !!o.verify;                                                // read both buses back after a still Apply
        this._setTimeout = o.setTimeout || setTimeout;
        this._clearTimeout = o.clearTimeout || clearTimeout;
        this._now = o.now || Date.now;
        this.scheduler = new WriteScheduler({
            writer: (slave, params) => this._writeSlave(slave, params), maxInFlight: o.maxInFlight || 1, minGapMs: o.minGapMs || 0,
            busyBackoffMs: o.busyBackoffMs, maxBusyRetries: o.maxBusyRetries, log: this.log,
            now: this._now, setTimeout: this._setTimeout, clearTimeout: this._clearTimeout,
        });
        this.scheduler.on('failed', (key, params, r) => this._onFailed(key, params, r));
        this.scheduler.on('written', (key, params) => this._onWritten(key, params));

        this.state = 'disconnected';
        this.program = null;               // the applied program (normalised), null = OEM
        this.scene = {};                   // the last rendered targets
        this.phase0 = 0;                   // animation time origin
        this.capabilities = null;
        this.slaves = [];
        this.byKey = new Map();
        this.driven = new Set();           // modules this controller has driven since the last restore
        this.failures = new Map();         // key -> count of refusals in a row
        this.lastError = null;
        this.stats = { applies: 0, restores: 0, frames: 0, framesDropped: 0, keepAlives: 0, lastApplyMs: null, lastRestore: null, rejectsInARow: 0, broadcasts: 0, verified: 0, confirmed: 0, missed: 0 };
        this._onceTimer = null;
        this.history = [];
        this._ticker = null;
        this._keepTimer = null;
        this._gen = 0;
        this._op = Promise.resolve();
        this._fpsWindow = [];
    }

    /* ---------- state ---------- */
    _setState(s, err) {
        if (STATES.indexOf(s) < 0) throw new Error('bad state ' + s);
        if (err !== undefined) this.lastError = err;
        if (this.state === s) return;
        this.state = s;
        this.log.info('lighting: ' + s + (err ? ' (' + err + ')' : ''));
        this.emit('state', s, err);
    }
    get connected() { return this.state === 'connected'; }
    get custom() { return !!this.program; }

    async connect() {
        this._setState('connecting');
        try {
            this.capabilities = await this._probe();
            this.slaves = ((this.capabilities && this.capabilities.slaves) || []).map((s) => Object.assign({}, s));
            this.byKey = new Map(this.slaves.map((s) => [S.key(s), s]));
            if (!this.capabilities || !this.capabilities.available) { this._setState('disconnected', (this.capabilities && this.capabilities.reason) || 'transport unavailable'); return this.capabilities; }
            this._setState('connected', null);
        } catch (e) {
            this.capabilities = { available: false, reason: String(e && e.message || e) };
            this._setState('error', this.capabilities.reason);
        }
        return this.capabilities;
    }
    async probe() { return this.connect(); }
    async readState() {
        try { const slaves = await this._readSlaves(); if (slaves) { this.slaves = slaves.map((s) => Object.assign({}, this.byKey.get(S.key(s)) || {}, s)); this.byKey = new Map(this.slaves.map((s) => [S.key(s), s])); } } catch (e) { this.log.warn('readSlaves: ' + e); }
        return { state: this.state, custom: this.custom, program: this.program, scene: Object.assign({}, this.scene), slaves: this.slaves.slice(), capabilities: this.capabilities, lastError: this.lastError };
    }

    /** Is a write even worth trying? Subclasses add their own gates (not armed, unknown variant). */
    canControl() {
        if (!this.connected) return { ok: false, reason: this.lastError || 'not connected' };
        if (!this.slaves.length) return { ok: false, reason: 'no RGB LIN modules known (read DA5F / E3D1 first)' };
        const rgb = this.capabilities && this.capabilities.rgbActuator;
        if (rgb === 'none' || rgb === 'unsupported') return { ok: false, reason: 'this body controller has no RGB layering actuator' };
        if (this.gate) { const why = this.gate(); if (why) return { ok: false, reason: why }; }
        if (this.parkedPolicy === 'strict' && this.kind !== 'mock') {
            const p = this.parked ? this.parked() : null;
            if (p !== true) return { ok: false, reason: p === false ? 'the car is moving: park to change the lighting' : 'parking state unknown: lighting changes are blocked (fail closed)' };
        }
        return { ok: true };
    }

    /* ---------- apply / restore ---------- */
    _serial(fn) { const p = this._op.then(fn, fn); this._op = p.catch(() => {}); return p; }

    /**
     * Apply a confirmed program. Resolves { ok, reason?, written, failed, released } once the transport has taken
     * every write of the first round (or refused it). Static programs then only get keep-alives; animated ones tick.
     */
    apply(program) {
        return this._serial(async () => {
            const can = this.canControl();
            if (!can.ok) { this.emit('refused', can.reason); return Object.assign({ ok: false, written: 0, failed: 0 }, can); }
            const p = S.normalise(program);
            const gen = ++this._gen;
            const t0 = this._now();
            this._stopTicker();
            this.scheduler.clear('frame');
            const wasAnimated = S.isAnimated(this.program);
            this.program = p;
            if (!wasAnimated || !S.isAnimated(p)) this.phase0 = this._now();
            const scene = S.render(p, this.slaves, this._now(), { phase0: this.phase0 });
            // modules driven before but not in this program: hand them back
            const stale = Array.from(this.driven).filter((k) => !scene[k]).map((k) => this.byKey.get(k)).filter(Boolean);
            if (stale.length) this._release(stale);
            const keys = Object.keys(scene);
            this._submit(scene, 'apply', { all: true });
            this.scene = scene;
            this.stats.applies++;
            this.emit('program', p);
            await this.scheduler.drain();
            if (gen !== this._gen) return { ok: false, reason: 'superseded', written: 0, failed: 0 };
            stale.forEach((s) => { const k = S.key(s); const l = this.scheduler.last.get(k); if (l && l.ok && !l.params.active) this.driven.delete(k); });
            let written = 0, failed = 0;
            keys.forEach((k) => { const l = this.scheduler.last.get(k); if (l && l.ok && this._same(l.params, this._params(scene[k]))) written++; else failed++; });
            this.stats.lastApplyMs = this._now() - t0;
            if (!written && keys.length) { this._fail('the BDC accepted none of the writes'); return { ok: false, reason: this.lastError, written, failed, released: stale.length }; }
            let check = null;
            if (S.isAnimated(p)) { this._startTicker(); this._armOnce(p, gen); } else {
                if ((this.verify || this._mode() === 'broadcast') && this._canVerify()) { check = await this.verifyApplied(); if (gen !== this._gen) return { ok: false, reason: 'superseded', written: 0, failed: 0 }; }
                this._armKeepAlive();
            }
            this.log.info('applied ' + S.describe(p, this.slaves) + ': ' + written + ' written, ' + failed + ' failed, ' + this.stats.lastApplyMs + ' ms' + (check ? ', read back: ' + check.confirmed + ' confirmed, ' + check.missed + ' missed' : ''));
            return Object.assign({ ok: true, written, failed, released: stale.length }, check ? { confirmed: check.confirmed, missed: check.missed } : {});
        });
    }

    /**
     * Back to OEM: stop everything, release every driven module and wait for the transport. Resolves
     * { ok, released, failed: [keys], pending } and never claims success for a module whose release was not accepted.
     */
    restoreOem() {
        return this._serial(async () => {
            this._gen++;
            this._stopTicker();
            this._stopKeepAlive();
            this.scheduler.clear();
            const had = !!this.program;
            this.program = null;
            this.scene = {};
            this.emit('program', null);
            const keys = Array.from(this.driven);
            const slaves = keys.map((k) => this.byKey.get(k)).filter(Boolean);
            if (slaves.length) {
                if (!this._available()) { this.stats.restores++; return { ok: false, reason: 'transport unavailable: ' + slaves.length + ' module(s) not released (they lapse by themselves within ' + this.refreshSeconds + ' s)', released: 0, failed: keys, pending: keys.length }; }
                this._release(slaves);
                await this.scheduler.drain();
            }
            const failed = [];
            keys.forEach((k) => { const l = this.scheduler.last.get(k); if (l && l.ok && l.params && l.params.active === false) this.driven.delete(k); else failed.push(k); });
            this.stats.restores++;
            this.stats.lastRestore = this._now();
            const ok = failed.length === 0;
            if (!ok) this.log.warn('restore: ' + failed.length + ' module(s) not released: ' + failed.join(' '));
            else if (had) this.log.info('restored OEM: ' + keys.length + ' module(s) released');
            return { ok, released: keys.length - failed.length, failed, pending: 0, reason: ok ? undefined : failed.length + ' release(s) refused or unanswered (they lapse by themselves within ' + this.refreshSeconds + ' s)' };
        });
    }
    async shutdown() { try { await this.restoreOem(); } catch (e) { /* best effort */ } this._stopTicker(); this._stopKeepAlive(); }

    /* ---------- the loops ---------- */
    /** ZEIT of the writes now: a still program holds refreshSeconds, a moving one moveSeconds at most. */
    holdSeconds() { return S.isAnimated(this.program) ? Math.min(this.refreshSeconds, this.moveSeconds) : this.refreshSeconds; }
    _params(t) { return { active: true, r: t.r, g: t.g, b: t.b, brightness: t.brightness, seconds: this.holdSeconds() }; }
    _mode() { return this.txMode === 'broadcast' && this.broadcastOk ? 'broadcast' : 'individual'; }
    /** The module keys a scheduler key reaches: its own, or every module of the bus for NAD 0. */
    _covers(key) { const m = /^(\d+):0$/.exec(key); return m ? this.slaves.filter((s) => s.bus === +m[1]).map(S.key) : [key]; }
    /** Queue the writes that put a scene on (lighting_plan.js decides between single and whole-bus writes). */
    _submit(scene, prio, o) {
        const items = PL.plan(scene, this.slaves, this.scheduler.last, { mode: this._mode(), params: (t) => this._params(t), force: new Set((o && o.force) || []), all: !!(o && o.all), deaf: this.deaf });
        if (prio === 'frame') return Object.assign(this.scheduler.frame(items.map((it) => ({ key: it.key, slave: it.slave, params: it.params })), items.filter((it) => it.force).map((it) => it.key)), { planned: items.length });
        items.forEach((it) => this.scheduler.set(it.key, it.slave, it.params, prio, true));
        return { planned: items.length };
    }
    _release(slaves) {
        PL.planRelease(slaves, this.slaves, { mode: this._mode() }).forEach((it) => this.scheduler.set(it.key, it.slave, it.params, 'release', true));
    }
    _onWritten(key, params) {
        if (PL.isBusKey(key)) {
            this.stats.broadcasts++;
            // the whole bus now shows this: what was last written to each of its modules is this write
            this._covers(key).forEach((k) => { this.scheduler.last.set(k, { params, at: this._now(), ok: true }); if (params.active) this.driven.add(k); this.failures.delete(k); });
            return;
        }
        this.driven.add(key); this.failures.delete(key);
    }
    /** One-time programs (welcome, pulse): after their time the follow-on program, or the car's own lighting. */
    _armOnce(p, gen) {
        const ms = S.onceMs(p);
        if (!ms) return;
        this._onceTimer = this._setTimeout(() => {
            this._onceTimer = null;
            if (gen !== this._gen) return;
            if (p.then) this.apply(p.then); else this.restoreOem();
        }, ms);
    }
    _canVerify() { return true; }
    /**
     * Read both buses back and compare with the applied still scene: a positive reply to a write does not prove the
     * module took it (Ambient Config's finding). A module that shows something else is written once more.
     * Resolves { confirmed, missed, unread }.
     */
    async verifyApplied() {
        const scene = this.scene, keys = Object.keys(scene);
        let read = null;
        try { read = await this._readSlaves(); } catch (e) { this.log.warn('read-back: ' + e); }
        this.stats.verified++;
        if (!read) return { confirmed: 0, missed: 0, unread: keys.length };
        const got = new Map(read.map((s) => [S.key(s), s]));
        const close = (a, b, d) => Math.abs(a - b) <= d;
        const missed = [];
        let confirmed = 0, unread = 0;
        keys.forEach((k) => {
            const m = got.get(k), t = scene[k];
            if (!m || m.r == null) { unread++; return; }
            if (close(m.r, t.r, 2) && close(m.g, t.g, 2) && close(m.b, t.b, 2) && close(m.brightness, t.brightness, 1)) confirmed++; else missed.push(k);
        });
        this.stats.confirmed += confirmed; this.stats.missed += missed.length;
        if (missed.length) {
            // with whole-bus writes on: a module that missed one is written on its own from now on
            if (this._mode() === 'broadcast') missed.forEach((k) => { if (!this.deaf.has(k)) { this.deaf.add(k); this.log.info('read-back: ' + k + ' missed a whole-bus write: single writes for it from now on'); } });
            this.log.info('read-back: ' + missed.length + ' module(s) missed their colour, writing them again: ' + missed.join(' '));
            missed.forEach((k) => this.scheduler.set(k, this.byKey.get(k), this._params(scene[k]), 'apply', true));
            await this.scheduler.drain();
        }
        return { confirmed, missed: missed.length, unread };
    }
    _same(a, b) { return !!a && !!b && a.active === b.active && a.r === b.r && a.g === b.g && a.b === b.b && a.brightness === b.brightness; }
    _staleKeys() {
        const limit = this._now() - this.holdSeconds() * 1000 * this.keepAliveFactor;
        return Object.keys(this.scene).filter((k) => { const l = this.scheduler.last.get(k); return !l || !l.ok || l.at <= limit; });
    }
    _stopKeepAlive() { if (this._keepTimer) { this._clearTimeout(this._keepTimer); this._keepTimer = null; } }
    _armKeepAlive() {
        this._stopKeepAlive();
        const gen = this._gen;
        const period = Math.max(250, this.refreshSeconds * 1000 * this.keepAliveFactor / 2);
        this._keepTimer = this._setTimeout(() => {
            this._keepTimer = null;
            if (gen !== this._gen || !this.program || S.isAnimated(this.program)) return;
            const stale = this._staleKeys();
            // (the gate: the car left or the factory lighting switched off stops the renewals; the colour lapses by itself)
            if (stale.length && !(this.gate && this.gate())) {
                this.stats.keepAlives++;
                this._submit(this.scene, 'apply', { force: stale });
            }
            this._armKeepAlive();
        }, period);
    }
    _stopTicker() { if (this._ticker) { this._clearTimeout(this._ticker); this._ticker = null; } if (this._onceTimer) { this._clearTimeout(this._onceTimer); this._onceTimer = null; } }
    _startTicker() {
        this._stopTicker();
        const gen = this._gen;
        const tick = () => {
            this._ticker = null;
            if (gen !== this._gen || !this.program || !S.isAnimated(this.program)) return;
            if (!this._available()) { this._lost('transport lost'); return; }
            const scene = S.render(this.program, this.slaves, this._now(), { phase0: this.phase0 });
            const targets = Object.keys(scene);
            const stale = this._staleKeys();
            this.scene = scene;
            const r = this._submit(scene, 'frame', { force: stale });
            this.stats.frames++;
            this.stats.framesDropped += r.dropped ? 1 : 0;
            const now = this._now();
            this._fpsWindow.push(now); while (this._fpsWindow.length && this._fpsWindow[0] < now - 3000) this._fpsWindow.shift();
            // pace to what the transport can take: a frame per (modules x latency), never faster than frameMs
            const lat = this.scheduler.stats.avgLatencyMs || 14;
            // (whole-bus writes: a frame is as many writes as were planned, not one a module)
            const per = this._mode() === 'broadcast' ? Math.max(2, Math.min(targets.length, r.planned || targets.length)) : Math.max(1, targets.length);
            const period = Math.max(this.frameMs, Math.round(lat * per * 1.1));
            this._ticker = this._setTimeout(tick, period);
        };
        tick();
    }
    /** Frames per second the animation is achieving (last 3 s). */
    fps() { return Math.round(this._fpsWindow.length / 3 * 10) / 10; }

    _onFailed(key, params, r) {
        const n = (this.failures.get(key) || 0) + 1;
        this.failures.set(key, n);
        this.history.push({ t: this._now(), key, nrc: r && r.nrc, reason: r && r.reason });
        if (this.history.length > 30) this.history.shift();
        if (r && r.reason === 'transport lost') { if (this.state === 'connected') this._lost('transport lost'); return; }
        if (PL.isBusKey(key)) {
            // the car did not take a whole-bus write: single writes from now on, starting with what this one was for
            this.broadcastOk = false;
            this.failures.delete(key);
            this.log.warn('lighting: the whole-bus write (NAD 0) was not taken (' + ((r && (r.reason || r.nrc)) || '?') + '): single writes from now on');
            const mine = this._covers(key);
            if (params && params.active) mine.forEach((k) => { if (this.scene[k]) this.scheduler.set(k, this.byKey.get(k), this._params(this.scene[k]), 'apply', true); });
            else this.scheduler.release(mine.filter((k) => this.driven.has(k)).map((k) => this.byKey.get(k)).filter(Boolean));
            return;
        }
        const allFailing = this.program && Object.keys(this.scene).length && Object.keys(this.scene).every((k) => (this.failures.get(k) || 0) >= this.maxSlaveFailures);
        if (allFailing) this._fail('the BDC refuses every module');
    }
    _fail(why) {
        this._gen++; this._stopTicker(); this._stopKeepAlive(); this.scheduler.clear();
        this.program = null; this.scene = {};
        this.lastError = why;
        this.emit('program', null);
        this.emit('failure', why);
        this.log.warn('lighting: custom control off: ' + why);
    }
    _lost(why) { this._fail(why); this.scheduler.pause(); this._setState('disconnected', why); }
    _availability(on) {
        if (on && this.state !== 'connected' && this.state !== 'connecting') { this.scheduler.resume(); this.connect(); }
        else if (!on && this.state === 'connected') this._lost('transport lost');
    }

    /** Snapshot for the diagnostics page. */
    status() {
        return {
            kind: this.kind, state: this.state, custom: this.custom, program: this.program, description: this.program ? S.describe(this.program, this.slaves) : 'OEM',
            animated: S.isAnimated(this.program), fps: this.fps(), refreshSeconds: this.refreshSeconds, holdSeconds: this.holdSeconds(), frameMs: this.frameMs, parkedPolicy: this.parkedPolicy,
            txMode: this.txMode, broadcastOk: this.broadcastOk, deaf: Array.from(this.deaf), verify: this.verify, gate: this.gate ? this.gate() : null,
            slaves: this.slaves.map((s) => Object.assign({}, s, { driven: this.driven.has(S.key(s)), failures: this.failures.get(S.key(s)) || 0 })),
            driven: this.driven.size, scene: Object.assign({}, this.scene), capabilities: this.capabilities,
            stats: Object.assign({}, this.stats), scheduler: this.scheduler.status(), lastError: this.lastError, history: this.history.slice(-12),
        };
    }

    /* ---------- to implement ---------- */
    async _probe() { return { available: false, reason: 'not implemented', transport: this.kind, slaves: [], rgbActuator: 'unknown' }; }
    async _readSlaves() { return this.slaves; }
    async _writeSlave() { return { ok: false, reason: 'not implemented' }; }
    _available() { return false; }
}

module.exports = { LightingController, STATES };

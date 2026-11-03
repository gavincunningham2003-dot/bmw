'use strict';
/**
 * controller.js - LightingController: what the UI talks to. One interface, three implementations:
 *
 *   mock.js      MockLightingController    a simulated BDC with LIN slaves; the whole app runs on it
 *   bdc_uds.js   BdcUdsLightingController  the real thing over the head unit's TASU diagnostic link
 *   someip.js    SomeIpLightingController  a probe for a native SOME/IP lighting service (none known yet)
 *
 * The base class owns the state machine and the "custom control" loop:
 *   - the BDC's layering actuator (DID DA5E / E3D1) drives a slave for ZEIT seconds and then lets go, so
 *     custom control = re-sending the current colour to every slave before ZEIT runs out (keep-alive);
 *   - colour changes coalesce: the newest colour wins, one write per slave at a time, at least minGapMs
 *     between rounds, so a finger sweeping the wheel does not flood the bus;
 *   - restoreOem() stops the loop and writes the slaves inactive; the BDC also falls back by itself once
 *     ZEIT lapses, which is what makes the whole scheme reversible after a crash or a head-unit restart;
 *   - after maxRejects refusals in a row, or a lost link, custom control switches itself off (event 'failure').
 *
 * Subclasses implement:
 *   _probe()                           -> capabilities (see probe())
 *   _readSlaves()                      -> [{ bus, nad, location, ... }]
 *   _writeSlave(slave, params)         -> { ok, nrc?, reason?, bytes? }   params = { active, r, g, b, brightness, seconds }
 *   _available()                       -> bool (transport up)
 * Timers and the clock are injectable (opts.setTimeout / clearTimeout / now) so tests run in fake time.
 */
const EventEmitter = require('events');

const STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'error']);

class LightingController extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.kind = o.kind || 'base';
        this.refreshSeconds = Math.max(2, Math.min(254, o.refreshSeconds || 10));   // ZEIT sent with every write
        this.keepAliveFactor = o.keepAliveFactor || 0.5;                           // resend at ZEIT * factor
        this.minGapMs = o.minGapMs == null ? 150 : o.minGapMs;                      // between two write rounds
        this.maxRejects = o.maxRejects || 5;
        this.maxSlaveFailures = o.maxSlaveFailures || 3;                           // a slave that refuses this often is skipped
        this.defaultBrightness = o.brightness == null ? 100 : o.brightness;        // % of "elektrische Helligkeit"
        this._setTimeout = o.setTimeout || setTimeout;
        this._clearTimeout = o.clearTimeout || clearTimeout;
        this._now = o.now || Date.now;

        this.state = 'disconnected';
        this.custom = false;
        this.colour = { r: 255, g: 255, b: 255 };
        this.brightness = this.defaultBrightness;
        this.capabilities = null;
        this.slaves = [];
        this.lastError = null;
        this.stats = { writes: 0, accepted: 0, rejected: 0, timeouts: 0, rounds: 0, rejectsInARow: 0, lastWriteAt: null, lastRoundMs: null };
        this.history = [];                 // last 30 exchanges for the diagnostics page
        this._timer = null;
        this._pending = null;              // colour waiting to go out
        this._busy = false;
        this._gen = 0;
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
    _record(entry) {
        this.history.push(Object.assign({ t: this._now() }, entry));
        if (this.history.length > 30) this.history.shift();
    }

    /** Bring the transport up and probe the BDC. Resolves with the capabilities; never throws. */
    async connect() {
        this._setState('connecting');
        try {
            this.capabilities = await this._probe();
            this.slaves = ((this.capabilities && this.capabilities.slaves) || []).map((s) => Object.assign({ failures: 0 }, s));
            if (!this.capabilities || !this.capabilities.available) { this._setState('disconnected', (this.capabilities && this.capabilities.reason) || 'transport unavailable'); return this.capabilities; }
            this._setState('connected', null);
        } catch (e) {
            this.capabilities = { available: false, reason: String(e && e.message || e) };
            this._setState('error', this.capabilities.reason);
        }
        return this.capabilities;
    }

    /** Probe again (after the link came back, or from the diagnostics page). */
    async probe() { return this.connect(); }

    /** What the lights do right now, as far as the controller knows (and the BDC says, where it can be read). */
    async readState() {
        try { const slaves = await this._readSlaves(); if (slaves) this.slaves = slaves.map((s) => Object.assign({ failures: 0 }, s)); } catch (e) { this.log.warn('readSlaves: ' + e); }
        return { state: this.state, custom: this.custom, colour: Object.assign({}, this.colour), brightness: this.brightness, slaves: this.slaves.slice(), capabilities: this.capabilities, lastError: this.lastError };
    }

    get connected() { return this.state === 'connected'; }

    /** Is a write even worth trying? Subclasses add their own gates (not armed, unknown variant). */
    canControl() {
        if (!this.connected) return { ok: false, reason: this.lastError || 'not connected' };
        if (!this.slaves.length) return { ok: false, reason: 'no RGB LIN slaves known (read DA5F / E3D1 first)' };
        const rgb = this.capabilities && this.capabilities.rgbActuator;
        if (rgb === 'none' || rgb === 'unsupported') return { ok: false, reason: 'this body controller has no RGB layering actuator' };
        return { ok: true };
    }

    /**
     * Set the colour. With custom control on it goes to the car right away (coalesced); otherwise it is
     * only remembered (the UI preview shows it) until enableCustom().
     */
    setColour(c, opts) {
        this.colour = { r: c.r & 255, g: c.g & 255, b: c.b & 255 };
        if (opts && opts.brightness != null) this.brightness = Math.max(0, Math.min(100, opts.brightness | 0));
        this.emit('colour', this.colour);
        if (this.custom) this._queue();
        return this.colour;
    }

    /** Start driving the lights with the current colour (keeps them driven until disableCustom / restoreOem). */
    async enableCustom() {
        const can = this.canControl();
        if (!can.ok) { this.emit('refused', can.reason); return can; }
        if (this.custom) return { ok: true };
        this.custom = true;
        this.stats.rejectsInARow = 0;
        this.emit('custom', true);
        await this._round();
        return { ok: this.custom, reason: this.custom ? undefined : this.lastError };
    }

    /** Stop driving: the slaves are written inactive once, then the loop stops (the BDC falls back by itself too). */
    async disableCustom() {
        if (!this.custom) return { ok: true };
        this.custom = false;
        this._gen++;
        this._stopTimer();
        this.emit('custom', false);
        const res = await this._round({ active: false, seconds: 0 });
        return { ok: true, released: res };
    }

    /** Back to OEM: disable custom control. (There is no other state to restore: nothing persistent was touched.) */
    async restoreOem() { return this.disableCustom(); }

    /** On app exit / MainApp shutdown: let go of the lights, best effort. */
    async shutdown() { try { await this.disableCustom(); } catch (e) { /* best effort */ } this._stopTimer(); }

    /* ---------- the loop ---------- */
    _stopTimer() { if (this._timer) { this._clearTimeout(this._timer); this._timer = null; } }
    _arm(ms) {
        this._stopTimer();
        const gen = this._gen;
        this._timer = this._setTimeout(() => { this._timer = null; if (gen === this._gen && this.custom) this._round(); }, ms);
    }
    _queue() {
        this._pending = Object.assign({}, this.colour);
        if (this._busy) return;                      // the running round picks it up at its end
        const since = this.stats.lastWriteAt == null ? Infinity : this._now() - this.stats.lastWriteAt;
        if (since >= this.minGapMs) this._round(); else this._arm(this.minGapMs - since);
    }

    /** One write round: every usable slave gets the current colour (or over = { active: false, seconds: 0 }). */
    async _round(over) {
        if (this._busy) return { skipped: true };
        this._busy = true;
        this._pending = null;
        const gen = this._gen, t0 = this._now();
        const params = Object.assign({ active: true, r: this.colour.r, g: this.colour.g, b: this.colour.b, brightness: this.brightness, seconds: this.refreshSeconds }, over || {});
        const results = [];
        let anyOk = false, lost = false;
        for (const s of this.slaves) {
            if (s.failures >= this.maxSlaveFailures && !over) { results.push({ nad: s.nad, bus: s.bus, skipped: true }); continue; }
            if (!this._available()) { lost = true; break; }
            let r;
            try { r = await this._writeSlave(s, params); } catch (e) { r = { ok: false, reason: String(e && e.message || e) }; }
            this.stats.writes++;
            this.stats.lastWriteAt = this._now();
            this._record({ bus: s.bus, nad: s.nad, ok: !!r.ok, nrc: r.nrc, reason: r.reason, bytes: r.bytes });
            if (r.ok) { anyOk = true; this.stats.accepted++; s.failures = 0; s.lastOk = this._now(); s.lastNrc = null; } else {
                if (r.reason === 'timeout' || r.reason === 'no reply') this.stats.timeouts++; else this.stats.rejected++;
                s.failures = (s.failures || 0) + 1; s.lastNrc = r.nrc == null ? r.reason : r.nrc;
            }
            results.push(Object.assign({ nad: s.nad, bus: s.bus }, r));
            if (gen !== this._gen && !over) break;    // disabled meanwhile
        }
        this.stats.rounds++;
        this.stats.lastRoundMs = this._now() - t0;
        this._busy = false;
        this.emit('round', results);
        if (over) return results;
        if (lost) { this._lost('transport lost'); return results; }
        if (anyOk) this.stats.rejectsInARow = 0; else if (results.some((x) => !x.skipped)) this.stats.rejectsInARow++;
        if (this.stats.rejectsInARow >= this.maxRejects) { this._fail('the BDC refused ' + this.stats.rejectsInARow + ' rounds in a row'); return results; }
        if (this.custom && gen === this._gen) {
            if (this._pending) {
                this._pending = null;
                const since = this._now() - this.stats.lastWriteAt;
                if (since >= this.minGapMs) this._round(); else this._arm(this.minGapMs - since);
            } else this._arm(Math.max(500, this.refreshSeconds * 1000 * this.keepAliveFactor));
        }
        return results;
    }
    _fail(why) {
        this.custom = false; this._gen++; this._stopTimer();
        this.lastError = why;
        this.emit('custom', false);
        this.emit('failure', why);
        this.log.warn('lighting: custom control off: ' + why);
    }
    _lost(why) {
        this._fail(why);
        this._setState('disconnected', why);
    }

    /** The transport came back or went (subclasses call this from their availability callbacks). */
    _availability(on) {
        if (on && this.state !== 'connected' && this.state !== 'connecting') this.connect();
        else if (!on && this.state === 'connected') this._lost('transport lost');
    }

    /** Snapshot for the diagnostics page. */
    status() {
        return {
            kind: this.kind, state: this.state, custom: this.custom, colour: Object.assign({}, this.colour), brightness: this.brightness,
            refreshSeconds: this.refreshSeconds, slaves: this.slaves.map((s) => Object.assign({}, s)), capabilities: this.capabilities,
            stats: Object.assign({}, this.stats), lastError: this.lastError, history: this.history.slice(-12),
        };
    }

    /* ---------- to implement ---------- */
    async _probe() { return { available: false, reason: 'not implemented', transport: this.kind, slaves: [], rgbActuator: 'unknown' }; }
    async _readSlaves() { return this.slaves; }
    async _writeSlave() { return { ok: false, reason: 'not implemented' }; }
    _available() { return false; }
}

module.exports = { LightingController, STATES };

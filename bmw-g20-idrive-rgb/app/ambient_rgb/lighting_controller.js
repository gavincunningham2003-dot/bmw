'use strict';
/**
 * controller.js - LightingController: what the UI talks to. One interface, three implementations:
 *
 *   mock.js      MockLightingController    a simulated BDC with LIN slaves; the whole app runs on it
 *   bdc_uds.js   BdcUdsLightingController  the real thing over the head unit's TASU diagnostic link
 *   someip.js    SomeIpLightingController  a probe for a native SOME/IP lighting service (none known yet)
 *
 * What the car established (PROTOCOL_FINDINGS.md 0.1): the BDC's layering actuator (2E DA5E bus 1, 2E E3D1 bus 2)
 * drives one module with R, G, B at a brightness for ZEIT seconds, answers in ~14 ms, overrides the OEM lighting
 * on or off, hands the module back at once on ZUSTAND 0, and by itself when ZEIT lapses.
 *
 * The base class owns the state machine and the "custom control" loop:
 *   - custom control = rounds: every selected module gets the colour to show now, one write each, in order;
 *   - a colour change with a fade time is a transition: the rounds run back to back and each one writes the
 *     colour interpolated between where the lights were and the target (RGB, linear); rainbow mode is a
 *     transition that never ends (the hue turns at a set rate);
 *   - between rounds the loop sleeps until a keep-alive is due: ZEIT * keepAliveFactor minus the time the last
 *     round took, so a slow transport can never let a module fall back to OEM mid-session;
 *   - zones: modules outside the chosen zone are released once (ZUSTAND 0) and left to the OEM function;
 *   - disableCustom() / restoreOem() write every driven module inactive and stop; the BDC also falls back by
 *     itself once ZEIT lapses, which keeps the whole scheme reversible after a crash or a head-unit restart;
 *   - after maxRejects refusals in a row, or a lost link, custom control switches itself off (event 'failure').
 *
 * Subclasses implement:
 *   _probe()                           -> capabilities (see probe())
 *   _readSlaves()                      -> [{ bus, nad, location, locationId, ... }]
 *   _writeSlave(slave, params)         -> { ok, nrc?, reason?, bytes? }   params = { active, r, g, b, brightness, seconds }
 *   _available()                       -> bool (transport up)
 * Timers and the clock are injectable (opts.setTimeout / clearTimeout / now) so tests run in fake time.
 */
const EventEmitter = require('events');

const STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'error']);
const MODES = Object.freeze(['static', 'rainbow']);

const clampByte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
const lerp = (a, b, t) => a + (b - a) * t;
function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

class LightingController extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.kind = o.kind || 'base';
        this.refreshSeconds = Math.max(2, Math.min(254, o.refreshSeconds || 10));   // ZEIT sent with every write
        this.keepAliveFactor = o.keepAliveFactor || 0.5;                           // a keep-alive round is due at ZEIT * factor
        this.minGapMs = o.minGapMs == null ? 60 : o.minGapMs;                       // between two rounds of a transition
        this.maxRejects = o.maxRejects || 5;
        this.maxSlaveFailures = o.maxSlaveFailures || 3;                           // a module that refuses this often is skipped
        this.defaultBrightness = o.brightness == null ? 100 : o.brightness;        // "elektrische Helligkeit": 100 is what the OEM function uses
        this.fadeMs = o.fadeMs == null ? 600 : o.fadeMs;                            // default transition time for setColour
        this.rainbowPeriodS = o.rainbowPeriodS || 20;                              // seconds per full hue turn in rainbow mode
        this._setTimeout = o.setTimeout || setTimeout;
        this._clearTimeout = o.clearTimeout || clearTimeout;
        this._now = o.now || Date.now;

        this.state = 'disconnected';
        this.custom = false;
        this.mode = 'static';
        this.colour = { r: 255, g: 255, b: 255 };     // the target (what the user picked)
        this.driven = null;                            // what the lights were last told to show (null: nothing yet)
        this.brightness = this.defaultBrightness;
        this.zone = 'all';
        this.zoneFilter = null;                        // fn(slave) -> bool, or null for all
        this.capabilities = null;
        this.slaves = [];
        this.lastError = null;
        this.stats = { writes: 0, accepted: 0, rejected: 0, timeouts: 0, rounds: 0, rejectsInARow: 0, lastWriteAt: null, lastRoundMs: null, avgRoundMs: null };
        this.history = [];                 // last 30 exchanges for the diagnostics page
        this._timer = null;
        this._busy = false;
        this._gen = 0;
        this._fade = null;                 // { from, to, start, ms } while a transition runs
        this._hue = 0;                     // rainbow phase
        this._released = new Set();        // modules written inactive because of the zone
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
        try { const slaves = await this._readSlaves(); if (slaves) this.slaves = slaves.map((s) => Object.assign({ failures: 0 }, this.slaves.find((k) => k.nad === s.nad && k.bus === s.bus) || {}, s)); } catch (e) { this.log.warn('readSlaves: ' + e); }
        return { state: this.state, custom: this.custom, mode: this.mode, colour: Object.assign({}, this.colour), driven: this.driven && Object.assign({}, this.driven), brightness: this.brightness, zone: this.zone, slaves: this.slaves.slice(), capabilities: this.capabilities, lastError: this.lastError };
    }

    get connected() { return this.state === 'connected'; }

    /** The modules a round writes: the zone's. */
    selected() { return this.zoneFilter ? this.slaves.filter(this.zoneFilter) : this.slaves; }

    /** Is a write even worth trying? Subclasses add their own gates (not armed, unknown variant). */
    canControl() {
        if (!this.connected) return { ok: false, reason: this.lastError || 'not connected' };
        if (!this.slaves.length) return { ok: false, reason: 'no RGB LIN slaves known (read DA5F / E3D1 first)' };
        const rgb = this.capabilities && this.capabilities.rgbActuator;
        if (rgb === 'none' || rgb === 'unsupported') return { ok: false, reason: 'this body controller has no RGB layering actuator' };
        return { ok: true };
    }

    /* ---------- what to show ---------- */
    /**
     * Set the colour. opts.fadeMs (default this.fadeMs): the lights glide there over that time when custom control is
     * on; 0 jumps. Without custom control it is only remembered (the UI preview shows it) until enableCustom().
     */
    setColour(c, opts) {
        const o = opts || {};
        this.colour = { r: clampByte(c.r), g: clampByte(c.g), b: clampByte(c.b) };
        if (o.brightness != null) this.brightness = Math.max(0, Math.min(100, o.brightness | 0));
        this.emit('colour', this.colour);
        if (this.mode === 'rainbow' && !o.leaveMode) this.mode = 'static';
        if (this.custom) {
            const fadeMs = o.fadeMs == null ? this.fadeMs : o.fadeMs;
            const from = this.driven || this.colour;
            this._fade = fadeMs > 0 && !this._same(from, this.colour) ? { from: Object.assign({}, from), to: Object.assign({}, this.colour), start: this._now(), ms: fadeMs } : null;
            this._kick();
        }
        return this.colour;
    }
    /** 'static' or 'rainbow' (the hue turns once per rainbowPeriodS, at the current brightness and full saturation). */
    setMode(mode, opts) {
        if (MODES.indexOf(mode) < 0) throw new Error('bad mode ' + mode);
        this.mode = mode;
        if (opts && opts.periodS) this.rainbowPeriodS = Math.max(2, opts.periodS);
        this._fade = null;
        this.emit('mode', mode);
        if (this.custom) this._kick();
    }
    /** Which modules to drive: 'all' or a name from lighting_protocol ZONES (a filter function is accepted too). */
    setZone(zone, filter) {
        this.zone = typeof zone === 'string' ? zone : 'custom';
        this.zoneFilter = typeof zone === 'function' ? zone : (filter || null);
        this.emit('zone', this.zone);
        if (this.custom) this._kick();
    }
    _same(a, b) { return !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b; }

    /** The colour this round should write (the transition's or the rainbow's current value). */
    _current() {
        const now = this._now();
        if (this.mode === 'rainbow') {
            const h = ((now / 1000) / this.rainbowPeriodS * 360) % 360;
            this._hue = h;
            return hsvToRgb(h, 1, 1);
        }
        if (this._fade) {
            const t = Math.min(1, (now - this._fade.start) / this._fade.ms);
            const f = this._fade;
            const c = { r: clampByte(lerp(f.from.r, f.to.r, t)), g: clampByte(lerp(f.from.g, f.to.g, t)), b: clampByte(lerp(f.from.b, f.to.b, t)) };
            if (t >= 1) this._fade = null;
            return c;
        }
        return this.colour;
    }
    /** Something to write right now: a transition is running or the rainbow turns. */
    _animating() { return this.mode === 'rainbow' || !!this._fade; }

    /* ---------- on / off ---------- */
    /** Start driving the lights with the current colour (keeps them driven until disableCustom / restoreOem). */
    async enableCustom() {
        const can = this.canControl();
        if (!can.ok) { this.emit('refused', can.reason); return can; }
        if (this.custom) return { ok: true };
        this.custom = true;
        this.stats.rejectsInARow = 0;
        this._fade = null;
        this.driven = null;
        // nothing is driven yet: the modules outside the zone are OEM already, no release needed
        this._released = new Set(this.slaves.filter((s) => this.selected().indexOf(s) < 0).map((s) => this._key(s)));
        this.emit('custom', true);
        await this._round();
        return { ok: this.custom, reason: this.custom ? undefined : this.lastError };
    }

    /** Stop driving: every driven module is written inactive once (the BDC hands it back at once), then the loop stops. */
    async disableCustom() {
        if (!this.custom) return { ok: true };
        this.custom = false;
        this._gen++;
        this._stopTimer();
        this._fade = null;
        this.emit('custom', false);
        const res = await this._round({ active: false, seconds: 0 }, this.slaves.filter((s) => !this._released.has(this._key(s))));
        this.driven = null;
        this._released.clear();
        return { ok: true, released: res };
    }

    /** Back to OEM: disable custom control. (There is no other state to restore: nothing persistent was touched.) */
    async restoreOem() { return this.disableCustom(); }

    /** On app exit / MainApp shutdown: let go of the lights, best effort. */
    async shutdown() { try { await this.disableCustom(); } catch (e) { /* best effort */ } this._stopTimer(); }

    /* ---------- the loop ---------- */
    _key(s) { return s.bus + ':' + s.nad; }
    _stopTimer() { if (this._timer) { this._clearTimeout(this._timer); this._timer = null; } }
    _arm(ms) {
        this._stopTimer();
        const gen = this._gen;
        this._timer = this._setTimeout(() => { this._timer = null; if (gen === this._gen && this.custom) this._round(); }, ms);
    }
    /** A change arrived: run a round as soon as the gap allows (a running round picks it up at its end). */
    _kick() {
        if (this._busy) return;
        const since = this.stats.lastWriteAt == null ? Infinity : this._now() - this.stats.lastWriteAt;
        if (since >= this.minGapMs) this._round(); else this._arm(this.minGapMs - since);
    }

    /**
     * One round: every selected module gets the current colour (or `over`, e.g. { active: false, seconds: 0 } to a
     * given list). Modules the zone excludes are released once. Then the next round is scheduled: right after the gap
     * while animating, else at the keep-alive.
     */
    async _round(over, list) {
        if (this._busy) return { skipped: true };
        this._busy = true;
        const gen = this._gen, t0 = this._now();
        const colour = over ? null : this._current();
        const params = Object.assign({ active: true, r: colour ? colour.r : 0, g: colour ? colour.g : 0, b: colour ? colour.b : 0, brightness: this.brightness, seconds: this.refreshSeconds }, over || {});
        const results = [];
        let anyOk = false, lost = false;
        const targets = list || (over ? this.slaves : this.selected());
        // modules the zone no longer covers: hand them back once
        if (!over) {
            const sel = new Set(targets.map((s) => this._key(s)));
            for (const s of this.slaves) {
                if (sel.has(this._key(s)) || this._released.has(this._key(s))) continue;
                if (!this._available()) { lost = true; break; }
                try { await this._writeSlave(s, { active: false, r: 0, g: 0, b: 0, brightness: 0, seconds: 0 }); } catch (e) { /* best effort */ }
                this._released.add(this._key(s));
            }
            targets.forEach((s) => this._released.delete(this._key(s)));
        }
        for (const s of targets) {
            if (lost) break;
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
        if (!over && anyOk) this.driven = colour;
        this.stats.rounds++;
        this.stats.lastRoundMs = this._now() - t0;
        this.stats.avgRoundMs = this.stats.avgRoundMs == null ? this.stats.lastRoundMs : Math.round(this.stats.avgRoundMs * 0.8 + this.stats.lastRoundMs * 0.2);
        this._busy = false;
        this.emit('round', results, colour);
        if (over) return results;
        if (lost) { this._lost('transport lost'); return results; }
        if (anyOk) this.stats.rejectsInARow = 0; else if (results.some((x) => !x.skipped)) this.stats.rejectsInARow++;
        if (this.stats.rejectsInARow >= this.maxRejects) { this._fail('the BDC refused ' + this.stats.rejectsInARow + ' rounds in a row'); return results; }
        if (this.custom && gen === this._gen) {
            if (this._animating()) this._arm(this.minGapMs);
            else this._arm(Math.max(250, this.refreshSeconds * 1000 * this.keepAliveFactor - this.stats.lastRoundMs));
        }
        return results;
    }
    _fail(why) {
        this.custom = false; this._gen++; this._stopTimer(); this._fade = null;
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
            kind: this.kind, state: this.state, custom: this.custom, mode: this.mode, colour: Object.assign({}, this.colour), driven: this.driven && Object.assign({}, this.driven),
            brightness: this.brightness, zone: this.zone, fading: !!this._fade, refreshSeconds: this.refreshSeconds, fadeMs: this.fadeMs, rainbowPeriodS: this.rainbowPeriodS,
            slaves: this.slaves.map((s) => Object.assign({}, s)), selected: this.selected().length, capabilities: this.capabilities,
            stats: Object.assign({}, this.stats), lastError: this.lastError, history: this.history.slice(-12),
        };
    }

    /* ---------- to implement ---------- */
    async _probe() { return { available: false, reason: 'not implemented', transport: this.kind, slaves: [], rgbActuator: 'unknown' }; }
    async _readSlaves() { return this.slaves; }
    async _writeSlave() { return { ok: false, reason: 'not implemented' }; }
    _available() { return false; }
}

module.exports = { LightingController, STATES, MODES, hsvToRgb };

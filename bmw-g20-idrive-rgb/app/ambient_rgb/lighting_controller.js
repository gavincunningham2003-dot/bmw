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
 * THE UPDATE METHOD is the MGU App Kit's Ambient Config's (apps/ambient_config/lights.js, MIT, (c) its authors;
 * THIRD_PARTY.md), ported onto this controller's scheduler and gates. What is taken from it, by its own names:
 *
 *   _plan / _next   a frame is every light at the colour of ONE moment; per LIN bus the colour most lights want goes
 *                   out as one write to NAD 0 (the whole bus), then single writes for the lights that differ; lights
 *                   that already show their colour and are not due for renewal are skipped (lighting_plan.js). A
 *                   whole-cabin colour is 2 writes, not 19.
 *   frame by frame  the next frame is planned only when the last one is completely written, from the time it is
 *                   THEN (the ticker below awaits the scheduler). So there is never a queue of frames, and none is
 *                   ever sent late: a slow link gives fewer frames, each of them current.
 *   holds           a moving scene's writes hold MOVE_HOLD_S (5 s) and are renewed after MOVE_RENEW_MS (3 s)
 *   _check          a positive reply does not prove a light took its colour. After a still Apply the buses are read
 *                   back ONCE, checkMs (1.5 s) after the writes, in the background: Apply has long resolved and the
 *                   screen is free. A light that missed it is written again (and a second read confirms the repair).
 *   _giveBack       handing back is one NAD 0 release a bus (lighting_plan.planRelease), then one read-back; a light
 *                   that still shows our colour is released on its own.
 *   hold(key, on)   nothing is written while a read-back has the link (scheduler.hold()).
 *
 * What is NOT taken, because this project's rules are stricter: lights.js writes a light again when its write got
 * no reply (here that is never a reason to send again), pauses 10 s after four failures (here control stops and
 * says so), and holds a still colour for 60 s (here the driver's "Keep-alive" setting, 10 s by default, so the
 * factory lighting is back within that time whatever happens to the app).
 *
 * TWO SETTINGS FOR HOW WRITES GO OUT (0.6.0): txMode for the modes (the animations), txStill for the still colours
 * (Solid, Dual, zones). Each is 'broadcast' (NAD 0 where it saves writes) or 'individual' (one write a module);
 * _mode() picks by what is applied. The full handback (restoreOem) is one NAD 0 release a bus with either.
 *
 * AN OPEN DOOR (lighting_overlay.js), over a STILL colour only (a running mode keeps the door's line, _fx()): that
 * door's contour line has no target, so it is released with the factory handback (one release to that module,
 * never a whole-bus one) and then left alone: no single write, no keep-alive, and no NAD 0 write on its bus while the door is
 * open (the rest of that bus is written singly). When the door closes the module is in the scene again and gets
 * the colour of that moment.
 *
 * What the car established (PROTOCOL_FINDINGS.md 0.1): 2E DA5E / E3D1 drive one module for ZEIT seconds (~14 ms a
 * write over ENET), override the OEM lighting, hand back at once on ZUSTAND 0 and by themselves when ZEIT lapses.
 * The head unit's TASU path takes one request at a time (kit/diag.js), so the scheduler sends one write at a time.
 *
 * Signals (lighting_overlay.js): setEffects({ doors, turn, dim }) hands an open door's contour line back to BMW,
 * lays a turn indicator's green blink over whatever is applied (also over the car's own lighting, when nothing
 * is) and dims at night. The applied program and its time origin are not touched, so it carries on in step; a
 * module the program leaves to the car is handed back the moment its effect ends.
 *
 * No reply is never a reason to write again (lighting_scheduler.js): an unanswered write is counted, shown, and
 * left alone; a read-back, where one is possible, says whether the module took it; after maxUnanswered writes in
 * a row without an answer custom control stops and the lights lapse by themselves.
 *
 * The gate (opts.gate) is asked before every Apply, every keep-alive and every animation frame: when it gives a
 * reason, nothing more is written and 'gated' is emitted; the owner (lighting_service.js) then releases the
 * modules (restoreOem) or lets them lapse (lapse).
 *
 * Operations are serialised (apply / restoreOem never interleave) and the timers / clock are injectable for tests.
 * Subclasses implement _probe(), _readSlaves(), _writeSlave(slave, params) and _available(), as before.
 */
const EventEmitter = require('events');
const S = require('./lighting_scene');
const { WriteScheduler } = require('./lighting_scheduler');
const PL = require('./lighting_plan');
const O = require('./lighting_overlay');

const STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'error']);
// Ambient Config's lights.js: a moving scene's hold and renewal, the read-back's delay, the pause when nothing is due
const MOVE_HOLD_S = 5, MOVE_RENEW_MS = 3000, CHECK_MS = 1500, IDLE_FRAME_MS = 40, CHECKS = 2;

class LightingController extends EventEmitter {
    constructor(opts) {
        super();
        const o = opts || {};
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.kind = o.kind || 'base';
        this.refreshSeconds = Math.max(2, Math.min(254, o.refreshSeconds || 10));   // ZEIT sent with every write
        this.keepAliveFactor = o.keepAliveFactor || 0.5;                           // refresh a module once its write is this old
        this.frameMs = o.frameMs || IDLE_FRAME_MS;                                // the shortest time between two frames (a floor, not a pace: see _startTicker)
        this.checkMs = o.checkMs == null ? CHECK_MS : o.checkMs;                  // the background read-back, this long after the last write
        this.maxSlaveFailures = o.maxSlaveFailures || 3;
        this.maxRejects = o.maxRejects || 5;
        this.maxUnanswered = o.maxUnanswered || 3;                                // writes in a row without a reply before control stops
        this.parkedPolicy = o.parkedPolicy || 'strict';                           // 'strict': no apply unless parked() === true
        this.parked = o.parked || null;                                          // fn() -> true | false | null (unknown)
        this.gate = o.gate || null;                                              // fn() -> null | why custom lighting must stay off (car left, factory lighting off, another controller)
        this.txMode = o.txMode === 'broadcast' ? 'broadcast' : 'individual';     // how MODES (animations) are written. 'broadcast': NAD 0 where it saves writes (lighting_plan.js)
        this.txStill = o.txStill === 'broadcast' ? 'broadcast' : 'individual';   // how STILL colours (Solid, Dual, zones) are written: a setting of its own (0.6.0)
        this.broadcastOk = true;                                                 // false once the car refused a NAD 0 write
        this.deaf = new Set();                                                   // modules seen to miss a whole-bus write: written singly after it
        this.moveSeconds = Math.max(2, Math.min(30, o.moveSeconds || MOVE_HOLD_S));   // ZEIT of a moving program's writes
        this.verify = !!o.verify;                                                // read both buses back after a still Apply (always with whole-bus writes)
        this._setTimeout = o.setTimeout || setTimeout;
        this._clearTimeout = o.clearTimeout || clearTimeout;
        this._now = o.now || Date.now;
        this.scheduler = new WriteScheduler({
            writer: (slave, params) => this._writeSlave(slave, params), maxInFlight: o.maxInFlight || 1, minGapMs: o.minGapMs || 0,
            busyBackoffMs: o.busyBackoffMs, maxBusyRetries: o.maxBusyRetries, maxCommandMs: o.maxCommandMs, log: this.log,
            now: this._now, setTimeout: this._setTimeout, clearTimeout: this._clearTimeout,
        });
        this.scheduler.on('failed', (key, params, r) => this._onFailed(key, params, r));
        this.scheduler.on('written', (key, params) => this._onWritten(key, params));
        this.scheduler.on('unanswered', (key, params) => this._onUnanswered(key, params));
        this.effects = { doors: [], doorsSince: 0, turn: [], turnSince: 0, dim: 1 };   // lighting_overlay.js state
        this._viaBus = new Set();          // modules whose last write was a whole-bus one
        this._sent = new Map();            // key -> the colour last written to it (the read-back after handing back)
        this._verifyTimer = null;          // the background read-back
        this._tickRun = 0;                 // which ticker loop is the live one
        this._shortHold = false;           // frames (short ZEIT) were written since the last full still write
        this._unanswered = 0;              // writes in a row without a reply
        this._closed = false;

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
        this.stats = { applies: 0, restores: 0, frames: 0, framesWritten: 0, framesDropped: 0, keepAlives: 0, lastApplyMs: null, lastRestore: null, rejectsInARow: 0, broadcasts: 0, busReleases: 0, verified: 0, confirmed: 0, missed: 0, unanswered: 0, effectFrames: 0, lapses: 0, releaseRepairs: 0, doorReleases: 0 };
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
    canControl(o) {
        if (!this.connected) return { ok: false, reason: this.lastError || 'not connected' };
        if (!this.slaves.length) return { ok: false, reason: 'no RGB LIN modules known (read DA5F / E3D1 first)' };
        const rgb = this.capabilities && this.capabilities.rgbActuator;
        if (rgb === 'none' || rgb === 'unsupported') return { ok: false, reason: 'this body controller has no RGB layering actuator' };
        if (this.gate) { const why = this.gate(); if (why) return { ok: false, reason: why }; }
        // (o.parked === false: an effect over the lighting, a turn indicator's glow, is by its nature shown while driving)
        if (this.parkedPolicy === 'strict' && this.kind !== 'mock' && !(o && o.parked === false)) {
            const p = this.parked ? this.parked() : null;
            if (p !== true) return { ok: false, reason: p === false ? 'the car is moving: park to change the lighting' : 'parking state unknown: lighting changes are blocked (fail closed)' };
        }
        return { ok: true };
    }

    /* ---------- apply / restore ---------- */
    _serial(fn) { const p = this._op.then(fn, fn); this._op = p.catch(() => {}); return p; }

    /**
     * Apply a confirmed program. Resolves { ok, reason?, written, failed, released, verifying } once the transport has
     * taken every write of the first round (or refused it): it does NOT wait for a read-back. Static programs then
     * get keep-alives and, with whole-bus writes or the setting on, one read-back in the background ('verified' is
     * emitted with its result); animated ones tick.
     */
    apply(program) {
        return this._serial(async () => {
            const can = this.canControl();
            if (!can.ok) { this.emit('refused', can.reason); return Object.assign({ ok: false, written: 0, failed: 0 }, can); }
            const p = S.normalise(program);
            const gen = ++this._gen;
            const t0 = this._now();
            this._stopTicker(); this._stopOnce(); this._stopVerify();
            this.scheduler.clear('frame');
            const wasAnimated = S.isAnimated(this.program);
            this.program = p;
            if (!wasAnimated || !S.isAnimated(p)) this.phase0 = this._now();
            const scene = this._compose(this._now());
            // modules driven before but not in this program (or whose door is open): hand them back
            const stale = this._gone(scene);
            if (stale.length) this._release(stale, scene);
            const keys = Object.keys(scene);
            this._submit(scene, 'apply', { all: true });
            this.scene = scene;
            this._shortHold = this._moving();
            this.stats.applies++;
            this.emit('program', p);
            await this.scheduler.drain();
            if (gen !== this._gen) return { ok: false, reason: 'superseded', written: 0, failed: 0 };
            stale.forEach((s) => { const k = S.key(s); const l = this.scheduler.last.get(k); if (l && l.ok && !l.params.active) this.driven.delete(k); });
            // written: the BDC said yes; unanswered: no reply came and the write was NOT sent again; failed: refused
            let written = 0, failed = 0, unanswered = 0;
            keys.forEach((k) => { const l = this.scheduler.last.get(k), mine = l && this._same(l.params, this._params(scene[k])); if (mine && l.ok) written++; else if (mine && l.unanswered) unanswered++; else failed++; });
            this.stats.lastApplyMs = this._now() - t0;
            if (!this.program) return { ok: false, reason: this.lastError || 'custom control stopped', written, failed, unanswered, released: stale.length };   // (stopped meanwhile: unanswered writes)
            if (!written && keys.length) {
                this._fail(unanswered ? 'the body controller answered none of the writes (none was sent again)' : 'the BDC accepted none of the writes');
                return { ok: false, reason: this.lastError, written, failed, unanswered, released: stale.length };
            }
            let verifying = false;
            if (this._moving()) { this._startTicker(); this._armOnce(p, gen); } else {
                this._armKeepAlive();
                // a read-back settles what a missing reply or a whole-bus write left open: later, in the background
                verifying = this._armVerify(!!unanswered);
            }
            this.log.info('applied ' + S.describe(p, this.slaves) + ': ' + written + ' written, ' + failed + ' failed' + (unanswered ? ', ' + unanswered + ' unanswered (not resent)' : '') + ', ' + this.stats.lastApplyMs + ' ms' + (verifying ? ', read-back in ' + this.checkMs + ' ms' : ''));
            return { ok: true, written, failed, unanswered, released: stale.length, verifying };
        });
    }

    /**
     * Back to OEM: stop everything, release every driven module and wait for the transport. Resolves
     * { ok, released, failed: [keys], pending } and never claims success for a module whose release was not accepted.
     *
     * The release is Ambient Config's give-back: ONE write to NAD 0 for each LIN bus this controller drove, one
     * after the other (two writes for the whole cabin), whatever the setting for colour writes says; single
     * releases only once the car has refused a NAD 0 write. A release nobody answers is not sent again: the transport
     * gone or the body controller asleep means nothing more is sent and the modules lapse by themselves (ZEIT).
     * o.verify === false (the car was left, the app is stopping): no read-back afterwards.
     */
    restoreOem(o) {
        return this._serial(async () => {
            this._gen++;
            if (o && o.final) { this._closed = true; this.effects = Object.assign({}, this.effects, { doors: [], turn: [] }); }
            this._stopTicker(); this._stopOnce(); this._stopVerify();
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
                this._release(slaves, null);
                await this.scheduler.drain();
            }
            const failed = [];
            keys.forEach((k) => { const l = this.scheduler.last.get(k); if (l && l.ok && l.params && l.params.active === false) this.driven.delete(k); else failed.push(k); });
            this.stats.restores++;
            this.stats.lastRestore = this._now();
            const ok = failed.length === 0;
            // an effect still wanted (a door still open) goes on over the car's own lighting
            if (!this._closed && O.moving(this.effects, this.slaves) && this._available() && !(this.gate && this.gate())) this._startTicker();
            // (lights.js _check after a give-back: a light still showing our colour is released on its own; in the background)
            if (ok && slaves.length && !this._closed && !(o && (o.final || o.verify === false))) this._armReleaseCheck();
            if (!ok) this.log.warn('restore: ' + failed.length + ' module(s) not released: ' + failed.join(' '));
            else if (had) this.log.info('restored OEM: ' + keys.length + ' module(s) released');
            return { ok, released: keys.length - failed.length, failed, pending: 0, reason: ok ? undefined : failed.length + ' release(s) refused or unanswered (they lapse by themselves within ' + this.refreshSeconds + ' s)' };
        });
    }
    /** The end: no effect, no animation, no keep-alive; every driven module released if the transport still takes it. */
    async shutdown() { let r = null; try { r = await this.restoreOem({ final: true }); } catch (e) { /* best effort */ } this._stopTicker(); this._stopOnce(); this._stopKeepAlive(); this._stopVerify(); return r; }

    /**
     * Stop writing and let the lights lapse by themselves (ZEIT): for a car whose state is not known (asleep, a
     * signal gone), where even a release would be a write too many. Nothing is sent. Resolves { ok, lapsing }.
     */
    lapse(why) {
        return this._serial(async () => {
            this._gen++;
            this._stopTicker(); this._stopOnce(); this._stopKeepAlive(); this._stopVerify();
            this.scheduler.clear();
            const had = !!this.program || this.driven.size > 0;
            const lapsing = this.driven.size, within = this.holdSeconds();
            this.program = null; this.scene = {};
            this.driven.clear(); this._viaBus.clear(); this._sent.clear();
            this.scheduler.last.clear();                                // what the modules show is no longer known
            this.stats.lapses++;
            this.emit('program', null);
            if (had) { this.log.info('lighting: writes stopped, ' + lapsing + ' module(s) lapse by themselves within ' + within + ' s: ' + why); this.emit('lapsed', why); }
            return { ok: true, lapsing };
        });
    }

    /* ---------- effects over the lighting ---------- */
    /**
     * What the car's signals ask for now: { doors: [door...], turn: [side...], dim: 0..1 } (any subset;
     * lighting_overlay.js). doors: the open doors, whose contour lines are handed back to BMW and left alone until
     * they close. turn: the indicator glow. Resolves once the change is queued (not once it is written).
     */
    setEffects(e) {
        const next = Object.assign({}, this.effects), now = this._now();
        if (e && e.doors) { const d = e.doors.slice().sort(); if (d.length && !next.doors.length) next.doorsSince = now; if (d.some((x) => next.doors.indexOf(x) < 0)) this.stats.doorReleases++; next.doors = d; }
        if (e && e.turn) { const t = e.turn.slice().sort(); if (t.length && !next.turn.length) next.turnSince = now; next.turn = t; }
        if (e && e.dim != null) next.dim = Math.max(0, Math.min(1, Number(e.dim)));
        const changed = next.doors.join() !== this.effects.doors.join() || next.turn.join() !== this.effects.turn.join() || next.dim !== this.effects.dim;
        this.effects = next;
        if (!changed) return Promise.resolve({ ok: true, changed: false });
        return this._serial(() => this._refreshEffects());
    }
    _refreshEffects() {
        if (this._closed) return { ok: false, reason: 'closed' };
        const want = O.moving(this.effects, this.slaves);
        if (!this.program && !want && !this.driven.size) return { ok: true, changed: true };
        const can = this.canControl({ parked: false });
        if (!can.ok) { if (want) this.log.info('effect not shown: ' + can.reason); return Object.assign({ changed: true }, can); }
        if (this._moving()) { this._startTicker(); return { ok: true, changed: true }; }
        // still: a door's module handed back (its own release, nothing else on its bus touched), a closed door's
        // module given its colour again, the night's brightness. Only what changed is written; after frames (which
        // carried the short ZEIT) everything once, in full.
        this._stopTicker();
        this.scheduler.clear('frame');
        const scene = this._compose(this._now());
        const stale = this._gone(scene);
        if (stale.length) this._release(stale, scene);
        this._submit(scene, 'apply', { all: this._shortHold });
        this._shortHold = false;
        this.scene = scene;
        if (this.program) this._armKeepAlive();
        return { ok: true, changed: true };
    }
    /** What every module should show at now: the applied program (dimmed at night) with the effects over it. */
    _compose(now) {
        const base = this.program ? S.render(this.program, this.slaves, now, { phase0: this.phase0 }) : {};
        return O.compose(base, this.slaves, this._fx(), now);
    }
    /**
     * The modules to hand back: driven by this controller and without a target in the scene (the program leaves
     * them to the car, or their door is open). One whose release went out and got no reply is not asked again.
     */
    _gone(scene) {
        return Array.from(this.driven).filter((k) => !scene[k]).filter((k) => { const l = this.scheduler.last.get(k); return !(l && l.unanswered && l.params && l.params.active === false); }).map((k) => this.byKey.get(k)).filter(Boolean);
    }
    /** Is there anything that changes with time (so frames are needed)? */
    _moving() { return S.isAnimated(this.program) || O.moving(this._fx(), this.slaves); }

    /* ---------- the loops ---------- */
    /** ZEIT of the writes now: a still program holds refreshSeconds, a moving one moveSeconds (5 s) at most. */
    holdSeconds() { return this._moving() ? Math.min(this.refreshSeconds, this.moveSeconds) : this.refreshSeconds; }
    /** A module is written again once its last write is this old: a moving scene after 3 s of its 5 (lights.js), a still one at keepAliveFactor of its hold. */
    renewMs() { const hold = this.holdSeconds() * 1000; return this._moving() ? Math.min(MOVE_RENEW_MS, Math.round(hold * 0.6)) : hold * this.keepAliveFactor; }
    _params(t) { return { active: true, r: t.r, g: t.g, b: t.b, brightness: t.brightness, seconds: this.holdSeconds() }; }
    /** The write method now: a mode (animation) follows txMode; a still colour, and an effect over it or over the car's own lighting, txStill. */
    _mode() { return (S.isAnimated(this.program) ? this.txMode : this.txStill) === 'broadcast' && this.broadcastOk ? 'broadcast' : 'individual'; }
    /**
     * The effects that count now. An open door hands its line back to BMW only over a STILL colour: while a mode
     * (an animation) runs, the door's line stays in the animation and nothing is released (0.6.0).
     */
    _fx() { return S.isAnimated(this.program) && this.effects.doors.length ? Object.assign({}, this.effects, { doors: [] }) : this.effects; }
    /** The module keys a scheduler key reaches: its own, or every module of the bus for NAD 0. */
    _covers(key) { const m = /^(\d+):0$/.exec(key); return m ? this.slaves.filter((s) => s.bus === +m[1]).map(S.key) : [key]; }
    /** Queue the writes that put a scene on (lighting_plan.js decides between single and whole-bus writes). */
    _submit(scene, prio, o) {
        const items = PL.plan(scene, this.slaves, this.scheduler.last, { mode: this._mode(), params: (t) => this._params(t), force: new Set((o && o.force) || []), all: !!(o && o.all), deaf: this.deaf, order: (m) => S.lightOf(m).y });
        if (prio === 'frame') return Object.assign(this.scheduler.frame(items.map((it) => ({ key: it.key, slave: it.slave, params: it.params })), items.filter((it) => it.force).map((it) => it.key)), { planned: items.length });
        items.forEach((it) => this.scheduler.set(it.key, it.slave, it.params, prio, true));
        return { planned: items.length };
    }
    /**
     * Hand modules back. scene: a PARTIAL handback (an open door's line, a zone no longer lit): one release to each
     * module asked for and never a whole-bus one, whatever else is lit. null: the full handback, every bus goes back
     * with one NAD 0 write (lighting_plan.planRelease).
     */
    _release(slaves, scene) {
        PL.planRelease(slaves, this.slaves, { whole: this.broadcastOk && !scene, keep: new Set(Object.keys(scene || {})), deaf: this.deaf }).forEach((it) => this.scheduler.set(it.key, it.slave, it.params, 'release', true));
    }
    _onWritten(key, params) {
        const colour = { r: params.r, g: params.g, b: params.b };
        if (PL.isBusKey(key)) {
            if (params.active) this.stats.broadcasts++; else this.stats.busReleases++;
            // the whole bus now shows this: what was last written to each of its modules is this write
            this._covers(key).forEach((k) => { this.scheduler.last.set(k, { params, at: this._now(), ok: true }); if (params.active) { this.driven.add(k); this._viaBus.add(k); this._sent.set(k, colour); } else { this.driven.delete(k); this._viaBus.delete(k); } this.failures.delete(k); });
            this._unanswered = 0;
            return;
        }
        if (params.active) { this.driven.add(key); this._sent.set(key, colour); } else this.driven.delete(key);
        this._viaBus.delete(key); this.failures.delete(key);
        this._unanswered = 0;
    }
    /**
     * A write nobody answered. It is NOT sent again: the module may show it. It counts as driven (a later restore
     * releases it), its keep-alive runs from now, and after maxUnanswered in a row custom control stops.
     */
    _onUnanswered(key, params) {
        this.stats.unanswered++;
        this.history.push({ t: this._now(), key, reason: 'no reply (not resent)' });
        if (this.history.length > 30) this.history.shift();
        const keys = this._covers(key);
        if (PL.isBusKey(key)) keys.forEach((k) => { this.scheduler.last.set(k, { params, at: this._now(), ok: false, unanswered: true, reason: 'timeout' }); if (params.active) this._viaBus.add(k); });
        if (params.active) keys.forEach((k) => this.driven.add(k));
        if (++this._unanswered >= this.maxUnanswered && (this.program || this._moving())) this._fail('the body controller is not answering (' + this._unanswered + ' writes in a row without a reply; none was sent again)');
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
     * Both buses read, with the writes held meanwhile (the gateway takes one request at a time; a status read
     * answers "pending" and takes seconds on the car). null when neither bus answered.
     */
    async _readBack() {
        this.scheduler.hold();
        try { await this.scheduler.idle(); return await this._readSlaves(); } catch (e) { this.log.warn('read-back: ' + e); return null; } finally { this.scheduler.unhold(); }
    }
    _stopVerify() { if (this._verifyTimer) { this._clearTimeout(this._verifyTimer); this._verifyTimer = null; } }
    /**
     * The read-back after a still Apply, in the background (lights.js: "after a still colour the buses are read back
     * once and a light that missed it is written again"). Armed when whole-bus writes are on, the setting asks for
     * it, or a write went unanswered (force); checkMs after the writes; a second read only to confirm a repair.
     * Nothing waits for it: a new Apply, a restore or an animation simply cancels it. Returns whether it is armed.
     */
    _armVerify(force, left) {
        this._stopVerify();
        if (!(this.verify || this._mode() === 'broadcast' || force) || !this._canVerify()) return false;
        const gen = this._gen, n = left == null ? CHECKS : left;
        this._verifyTimer = this._setTimeout(() => {
            this._verifyTimer = null;
            if (gen !== this._gen || this._closed || !this.program || this._moving() || !this._available()) return;
            if (this.gate && this.gate()) return;                        // the car left, the factory lighting off: not one more request
            this.verifyApplied().then((r) => {
                if (gen !== this._gen || r.superseded) return;
                this.emit('verified', r);
                if (r.missed && n > 1) this._armVerify(true, n - 1);
            }).catch((e) => this.log.warn('read-back: ' + e));
        }, this.checkMs);
        return true;
    }
    /**
     * The read-back after handing back (lights.js _check with _checkOff): a module that still shows the colour last
     * written to it missed its release (as a module can miss a whole-bus write) and is released on its own, once.
     */
    _armReleaseCheck() {
        this._stopVerify();
        const sent = new Map(this._sent);
        this._sent.clear();
        if (!sent.size || !this._canVerify()) return false;
        const gen = this._gen;
        this._verifyTimer = this._setTimeout(() => {
            this._verifyTimer = null;
            if (gen !== this._gen || this._closed || this.program || !this._available()) return;
            this._readBack().then((read) => {
                this.stats.verified++;
                if (!read || gen !== this._gen || this.program || this._closed) return;
                const near = (a, b) => Math.abs(Math.min(254, a) - b) < 3;
                const ours = read.filter((m) => { const c = sent.get(S.key(m)); return !!c && m.r != null && near(c.r, m.r) && near(c.g, m.g) && near(c.b, m.b); }).map((m) => this.byKey.get(S.key(m))).filter(Boolean);
                if (ours.length) {
                    this.stats.releaseRepairs += ours.length;
                    this.log.info('read-back: ' + ours.map(S.key).join(' ') + ' still showed our colour: released singly');
                    this.scheduler.release(ours);
                }
                this.emit('released', { stillOurs: ours.length });
            }).catch((e) => this.log.warn('read-back: ' + e));
        }, this.checkMs);
        return true;
    }
    /**
     * Read both buses back and compare with the applied still scene: a positive reply to a write does not prove the
     * module took it (Ambient Config's finding). A module that shows something else is written once more.
     * Resolves { confirmed, missed, unread } ({ superseded: true } when the lighting changed during the read).
     */
    async verifyApplied() {
        const gen = this._gen;
        const read = await this._readBack();
        this.stats.verified++;
        if (gen !== this._gen) return { confirmed: 0, missed: 0, unread: 0, superseded: true };
        const scene = this.scene, keys = Object.keys(scene);
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
            if (this._mode() === 'broadcast') missed.forEach((k) => { if (this._viaBus.has(k) && !this.deaf.has(k)) { this.deaf.add(k); this.log.info('read-back: ' + k + ' missed a whole-bus write: single writes for it from now on'); } });
            this.log.info('read-back: ' + missed.length + ' module(s) missed their colour, writing them again: ' + missed.join(' '));
            missed.forEach((k) => this.scheduler.set(k, this.byKey.get(k), this._params(scene[k]), 'apply', true));
            await this.scheduler.drain();
        }
        return { confirmed, missed: missed.length, unread };
    }
    _same(a, b) { return !!a && !!b && a.active === b.active && a.r === b.r && a.g === b.g && a.b === b.b && a.brightness === b.brightness; }
    _staleKeys() {
        const limit = this._now() - this.renewMs();
        return Object.keys(this.scene).filter((k) => { const l = this.scheduler.last.get(k); return !l || !(l.ok || l.unanswered) || l.at <= limit; });
    }
    _stopKeepAlive() { if (this._keepTimer) { this._clearTimeout(this._keepTimer); this._keepTimer = null; } }
    _armKeepAlive() {
        this._stopKeepAlive();
        const gen = this._gen;
        const period = Math.max(250, this.refreshSeconds * 1000 * this.keepAliveFactor / 2);
        this._keepTimer = this._setTimeout(() => {
            this._keepTimer = null;
            if (gen !== this._gen || !this.program || this._moving()) return;
            const stale = this._staleKeys();
            // (the gate: the car left, its state unknown or the factory lighting off stops the renewals; the colour lapses by itself)
            const why = this.gate && this.gate();
            if (why) { this.emit('gated', why); return; }
            if (stale.length) {
                this.stats.keepAlives++;
                this._submit(this.scene, 'apply', { force: stale });
            }
            this._armKeepAlive();
        }, period);
    }
    _stopTicker() { this._tickRun++; if (this._ticker) { this._clearTimeout(this._ticker); this._ticker = null; } }
    _stopOnce() { if (this._onceTimer) { this._clearTimeout(this._onceTimer); this._onceTimer = null; } }
    /**
     * The frames of a moving scene, as Ambient Config's lights.js runs them (_run / _next): one frame = every light at
     * the colour of the same moment; the frame is written out completely (awaited); only then is the next one made,
     * from the time it is THEN. Nothing is queued ahead and nothing is paced by a clock, so a frame can never be
     * obsolete when it is sent and the animation is exactly as fast as the link: 2 writes a frame for Rainbow, Fade
     * and Wave with whole-bus writes. frameMs is only a floor (and the wait when a frame had nothing to write).
     */
    _startTicker() {
        this._stopTicker();
        this._stopKeepAlive();                                           // (frames carry the refresh while anything moves)
        this._stopVerify();
        this._shortHold = true;
        const gen = this._gen, run = this._tickRun;
        const live = () => gen === this._gen && run === this._tickRun && !this._closed;
        const tick = async () => {
            this._ticker = null;
            if (!live() || !this._moving()) return;
            if (!this._available()) { this._lost('transport lost'); return; }
            // the gate closed (the car left, the factory lighting off, a signal gone): not one more frame
            const why = this.gate && this.gate();
            if (why) { this.emit('gated', why); return; }
            const t0 = this._now();
            const scene = this._compose(t0);
            const stale = this._staleKeys();
            // a module the scene no longer has (its door opened, its effect ended over the car's own lighting): handed
            // back with its own release, the rest of its bus untouched
            const gone = this._gone(scene);
            if (gone.length) this._release(gone, scene);
            this.scene = scene;
            const r = this._submit(scene, 'frame', { force: stale });
            this.stats.frames++;
            if (!S.isAnimated(this.program)) this.stats.effectFrames++;
            this.stats.framesDropped += r.dropped ? 1 : 0;
            const wrote = (r.planned || 0) + gone.length > 0;
            if (wrote) { this.stats.framesWritten++; this._fpsWindow.push(t0); while (this._fpsWindow.length && this._fpsWindow[0] < t0 - 3000) this._fpsWindow.shift(); }
            // the whole frame out before the next is made: no frame is ever queued behind another
            await this.scheduler.drain();
            if (!live()) return;
            const spent = this._now() - t0;
            this._ticker = this._setTimeout(() => { tick().catch((e) => this.log.warn('frame: ' + e)); }, wrote ? Math.max(0, this.frameMs - spent) : Math.max(IDLE_FRAME_MS, this.frameMs));
        };
        tick().catch((e) => this.log.warn('frame: ' + e));
    }
    /** Whole frames per second the animation is achieving (last 3 s): frames that wrote something. */
    fps() { return Math.round(this._fpsWindow.length / 3 * 10) / 10; }

    _onFailed(key, params, r) {
        const n = (this.failures.get(key) || 0) + 1;
        this.failures.set(key, n);
        this.history.push({ t: this._now(), key, nrc: r && r.nrc, reason: r && r.reason });
        if (this.history.length > 30) this.history.shift();
        if (r && r.reason === 'transport lost') { if (this.state === 'connected') this._lost('transport lost'); return; }
        if (PL.isBusKey(key) && r && (r.busy || r.nrc === 0x21)) { this.failures.delete(key); return; }   // busy says nothing about NAD 0: the keep-alive writes it next
        if (PL.isBusKey(key)) {
            // the car REFUSED a whole-bus write (a negative reply): single writes from now on, starting with what this one was for
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
        this._gen++; this._stopTicker(); this._stopOnce(); this._stopKeepAlive(); this._stopVerify(); this.scheduler.clear();
        this.program = null; this.scene = {};
        this._unanswered = 0;
        this.effects = Object.assign({}, this.effects, { doors: [], turn: [] });   // (the effects stop with it; the next signal starts them again)
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
            animated: S.isAnimated(this.program), moving: this._moving(), effects: Object.assign({}, this.effects), released: O.releasedKeys(this._fx(), this.slaves), fps: this.fps(), refreshSeconds: this.refreshSeconds, holdSeconds: this.holdSeconds(), renewMs: this.renewMs(), frameMs: this.frameMs, checkMs: this.checkMs, verifying: !!this._verifyTimer, parkedPolicy: this.parkedPolicy,
            txMode: this.txMode, txStill: this.txStill, writeMode: this._mode(), broadcastOk: this.broadcastOk, deaf: Array.from(this.deaf), verify: this.verify, gate: this.gate ? this.gate() : null,
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

module.exports = { LightingController, STATES, MOVE_HOLD_S, MOVE_RENEW_MS, CHECK_MS, IDLE_FRAME_MS };

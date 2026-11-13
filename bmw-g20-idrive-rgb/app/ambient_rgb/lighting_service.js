'use strict';
/**
 * lighting_service.js - everything the app does WITHOUT its screen: the lighting link, the factory gate, the
 * car's signals (an open door's line handed back to BMW, the turn indicator's glow, night), the driving modes,
 * the last lighting at start, and the shutdown.
 *
 * One LightingService per process. main.js makes it in the kit's background start (app.json "autostart": the
 * platform starts the app by itself, kit/runtime/mgu.js impl.background) and the screen, when it is opened, only
 * talks to it: closing the screen stops nothing here. Without a background start (an older kit, the tests'
 * harness) the screen's start makes it, once.
 *
 * WHEN CUSTOM LIGHTING STOPS (the factory keeps priority). Three answers, asked on every signal that could change
 * them and every 1.5 s, and by the controller before every write:
 *
 *   release   a reason to hand every module back NOW: one release to NAD 0 on each LIN bus, one after the other
 *             (two writes for the whole cabin; Ambient Config's give-back, lighting_plan.planRelease), whatever the
 *             setting for colour writes is. No read-back follows when the car was left: nothing more is asked of
 *             a body controller that may be going to sleep.
 *               - the car is parked or in standby with nobody in it: VehicleCondition 1, 2 or 3
 *               - the factory ambient lighting was switched off in iDrive (oem_lighting.js factoryOn() === false),
 *                 unless the setting "Factory ambient lighting off" says to keep custom lighting
 *               - another ambient-light controller runs on this head unit (IterioDev Comfort)
 *   lapse     a reason to STOP WRITING and send nothing more, not even a release (the car may be going to sleep;
 *             every module returns to the factory lighting by itself when its ZEIT runs out):
 *               - the car's state is not known: VehicleCondition never arrived or its provider is gone, AND
 *                 nothing has shown the car in use for idleMs (it moved, or the app's screen was used)
 *               - whether the factory ambient lighting is on is not known (nothing received, "unfilled", provider
 *                 gone), with the same setting as above
 *             A missing signal is never read as "the car is in use" or "the factory lighting is on".
 *             (On the simulated BDC there is no car to keep awake: unknown does not stop it, known states do.)
 *   open      neither: lighting may be applied and renewed.
 *
 * Custom lighting comes back by itself after a release or a lapse only with the setting "resume" on; otherwise
 * the factory lighting stays until the driver applies something.
 *
 * SHUTDOWN (the platform stops the app, or the process is told to end): effects and animations stop, timers are
 * cleared, every subscription is closed and restoreOem() is attempted. The kit ends the process 200 ms after the
 * platform's request, so a release that did not get out in time is covered by ZEIT like everything else.
 */
const EventEmitter = require('events');
const fs = require('fs');
const S = require('./lighting_scene');
const { Favourites } = require('./favourites');
const { MockLightingController } = require('./lighting_mock');
const { BdcUdsLightingController } = require('./lighting_bdc_uds');
const { SomeIpLightingController } = require('./lighting_someip');
const { OemLighting } = require('./oem_lighting');
const { DrivingModes } = require('./driving_modes');
const { CarSignals, sidesOf } = require('./car_signals');

// another ambient-light controller on the same head unit (IterioDev's Comfort service): two writers would keep
// overwriting each other's colours (the check is Ambient Config's, others.js)
const COMFORT_SOCK = '/run/iteriodev-comfort/ctl.sock';
const IDLE_MS = 15 * 60000;            // the car's state unknown: this long without a sign of use = not in use
const NIGHT_DIM = 0.5;
const GATE_MS = 1500;
const LINK_KEYS = ['backend', 'arm', 'unknownVariant', 'inflight', 'parked', 'simLatency', 'txMode', 'verify', 'refresh', 'busyRetries'];
const still = (p) => (p && S.onceMs(p) ? p.then : p);

let instance = null;

class LightingService extends EventEmitter {
    /**
     * o.settings (get / set / onChange), o.signals (kit/signals), o.log, o.dataDir.
     * For tests: o.now, o.setInterval / clearInterval, o.setTimeout / clearTimeout, o.strict (true: unknown signals stop
     * the lighting whatever the backend), o.idleMs, o.comfortSock, o.parkedWatch(signals, log), o.controller(common).
     */
    constructor(o) {
        super();
        this.settings = o.settings; this.signals = o.signals; this.dataDir = o.dataDir;
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.now = o.now || Date.now;
        this._setInterval = o.setInterval || setInterval; this._clearInterval = o.clearInterval || clearInterval;
        this._setTimeout = o.setTimeout || setTimeout; this._clearTimeout = o.clearTimeout || clearTimeout;
        this.o = o;
        this.idleMs = o.idleMs || IDLE_MS;
        this.comfortSock = o.comfortSock || process.env.AMBIENT_RGB_COMFORT_SOCK || COMFORT_SOCK;
        this.favs = new Favourites(o.dataDir, this.log);
        this.ctl = null; this.oem = null; this.drive = null; this.car = null; this.parked = null;
        this.busy = false; this.probing = false;
        this.suspended = null; this.lastGate = null;
        this.started = false; this.stopped = false;
        this._gateOp = Promise.resolve();
        this._gateTimer = null; this._autoTimer = null;
        this._activeAt = this.now();
        this.stats = { releases: 0, lapses: 0, resumes: 0, starts: 0 };
    }

    say(text, ms) { this.emit('say', text, ms || 2500); }
    /** The screen was used (or anything else that shows someone is in the car). */
    touch() { this._activeAt = this.now(); }

    /* ---------- start / stop ---------- */
    async start() {
        if (this.started) return this;                       // one set of timers and listeners, whoever asks
        this.started = true; this.stats.starts++;
        const { settings, signals, log } = this;
        await this.makeController();
        try { this.parked = this.o.parkedWatch ? this.o.parkedWatch(signals, log) : require('./kit/parked').watch({ signals }, log); } catch (e) { log.warn('parked: ' + e); }
        // the factory lighting as the head unit knows it: subscribed and read, never written (oem_lighting.js)
        this.oem = new OemLighting(signals, log, { now: this.now });
        this.oem.on('change', () => this.gateTick().catch((e) => log.warn('gate: ' + e)));
        this.oem.start().catch((e) => log.warn('factory lighting read-out: ' + e));
        // the driving mode and whether the car is in use (read only), and a lighting choice per mode
        this.drive = new DrivingModes({ signals, log, dataDir: this.dataDir });
        this.drive.on('away', () => this.gateTick().catch((e) => log.warn('gate: ' + e)));
        this.drive.on('mode', (m, was) => this.followMode(m, was).catch((e) => log.warn('driving mode: ' + e)));
        this.drive.start().catch((e) => log.warn('driving modes: ' + e));
        // the doors, the turn indicators, day / night (read only)
        this.car = new CarSignals({ signals, log });
        ['doors', 'turn', 'night'].forEach((ev) => this.car.on(ev, () => { if (ev !== 'night') this.touch(); this.syncEffects(); }));
        this.car.start().catch((e) => log.warn('car signals: ' + e));

        this._linkKey = this._linkNow();
        settings.onChange((key) => this._onSetting(key).catch((e) => log.warn('settings: ' + e)));
        this._gateTimer = this._setInterval(() => this.gateTick().catch((e) => log.warn('gate: ' + e)), GATE_MS);
        if (this._gateTimer && this._gateTimer.unref) this._gateTimer.unref();
        this._autoApplyAtStart();
        return this;
    }

    /**
     * The end of the app: stop everything and try to give the lights back. Safe to call twice; resolves with the
     * restore's result (null when there was no link).
     */
    stop(why) {
        if (this.stopped) return Promise.resolve(null);
        this.stopped = true;
        this._stopping = this._stop(why);
        return this._stopping;
    }
    async _stop(why) {
        this.log.info('lighting service stopping' + (why ? ': ' + why : ''));
        if (this._gateTimer) { this._clearInterval(this._gateTimer); this._gateTimer = null; }
        if (this._autoTimer) { this._clearTimeout(this._autoTimer); this._autoTimer = null; }
        let r = null;
        // first the release (the platform gives the process 200 ms), then the subscriptions
        if (this.ctl) { try { r = await this.ctl.shutdown(); } catch (e) { this.log.warn('shutdown: ' + e); } this.ctl.removeAllListeners(); }
        for (const x of [this.oem, this.drive, this.car]) { if (x) { try { x.removeAllListeners(); await x.shutdown(); } catch (e) { /* */ } } }
        if (instance === this) instance = null;
        return r;
    }

    /* ---------- the lighting link ---------- */
    _linkNow() { return LINK_KEYS.map((k) => this.settings.get(k)).join('|'); }
    strict() { return this.o.strict != null ? !!this.o.strict : this.settings.get('backend') !== 'mock'; }

    async makeController() {
        const { settings, log, signals } = this;
        const old = this.ctl;
        if (old) { try { await old.shutdown(); } catch (e) { /* */ } old.removeAllListeners(); }
        const retries = Number(settings.get('busyRetries'));
        const common = {
            log, refreshSeconds: Number(settings.get('refresh')) || 10, frameMs: Number(settings.get('frame')) || 40,
            // one request in flight unless the driver asked for the experiment: the TASU path is not proven to take two
            maxInFlight: settings.get('inflight') === '2' ? 2 : 1, parkedPolicy: settings.get('parked') === 'lenient' ? 'lenient' : 'strict',
            parked: () => (this.parked ? (this.parked.speed() === null ? null : !this.parked.moving()) : null),
            gate: () => this.gate(), txMode: settings.get('txMode'), verify: settings.get('verify') === 'on',
            maxBusyRetries: isNaN(retries) ? 3 : retries, maxCommandMs: 5000,
        };
        ['now', 'setTimeout', 'clearTimeout'].forEach((k) => { if (this.o[k]) common[k] = this.o[k]; });
        const backend = settings.get('backend');
        let ctl;
        if (this.o.controller) ctl = await this.o.controller(common, backend);
        else if (backend === 'bdc') {
            ctl = new BdcUdsLightingController(Object.assign(common, { signals, armed: settings.get('arm') === 'on', allowUnknownVariant: settings.get('unknownVariant') === 'on', maxSeconds: Math.max(30, Math.min(254, Number(settings.get('refresh')) || 10)) }));
            try { await ctl.init(); } catch (e) { log.warn('diagnostic link: ' + e); }
        } else if (backend === 'someip') ctl = new SomeIpLightingController(Object.assign(common, { signals }));
        else ctl = new MockLightingController(Object.assign(common, { latencyMs: Number(settings.get('simLatency')) || 0 }));
        this.ctl = ctl;
        ctl.on('failure', (why) => this.say('Lighting control stopped: ' + why, 5000));
        ctl.on('refused', (why) => this.say('Cannot apply: ' + why, 4000));
        ctl.on('state', (s, err) => { if (s === 'disconnected' && err) this.say('Link: ' + err, 4000); });
        ctl.on('gated', () => this.gateTick().catch((e) => log.warn('gate: ' + e)));
        // the read-back runs after Apply has answered: what it found is said when it is worth saying
        ctl.on('verified', (r) => { if (r && r.missed) this.say(r.missed + ' module(s) had missed their colour: written again', 4000); });
        this.probing = true;
        try { await ctl.connect(); } finally { this.probing = false; }
        log.info('lighting link ' + ctl.kind + ': ' + ctl.state + (ctl.lastError ? ' (' + ctl.lastError + ')' : ''));
        this.emit('controller', ctl);
        if (this.car) this.syncEffects();
        return ctl;
    }

    async _onSetting(key) {
        const { settings } = this;
        const now = this._linkNow();
        if (now !== this._linkKey) { this._linkKey = now; await this.makeController(); this.say('Lighting link: ' + this.ctl.kind); }
        if (key === 'refresh' || !key) this.ctl.refreshSeconds = Math.max(2, Math.min(254, Number(settings.get('refresh')) || 10));
        if (key === 'frame' || !key) this.ctl.frameMs = Number(settings.get('frame')) || 40;
        if (!key || /^(doorRelease|turnGlow|nightDim|drive)$/.test(key)) this.syncEffects();
        if (!key || /^(oemOffRule|conflict)$/.test(key)) await this.gateTick();
    }

    /* ---------- the gate ---------- */
    conflict() { if (this.settings.get('conflict') === 'ignore') return false; try { return fs.existsSync(this.comfortSock); } catch (e) { return false; } }
    /** 'away' | 'inUse' | 'unknown' (see the header). */
    carState() {
        const a = this.drive ? this.drive.away() : null;
        if (a === true) return 'away';
        if (a === false) return 'inUse';
        if (this.parked && this.parked.moving && this.parked.moving()) this._activeAt = this.now();
        return this.now() - this._activeAt < this.idleMs ? 'inUse' : 'unknown';
    }
    /** Why every module must be handed back now, or null. */
    factoryGate() {
        if (this.conflict()) return 'another ambient lighting controller is running on this head unit (IterioDev Comfort)';
        if (this.carState() === 'away') return 'the car is locked or left: the factory lighting has it';
        if (this.oem && this.settings.get('oemOffRule') !== 'ignore' && this.oem.factoryOn() === false) return 'the factory ambient lighting is switched off';
        return null;
    }
    /** Why nothing more may be written (and the lights left to lapse), or null. */
    holdReason() {
        if (!this.strict()) return null;
        if (this.carState() === 'unknown') return 'the car has not said it is in use (no vehicle state signal, no sign of use for ' + Math.round(this.idleMs / 60000) + ' min)';
        if (this.oem && this.settings.get('oemOffRule') !== 'ignore' && this.oem.factoryOn() === null) return this.oem.unknownWhy() + ' (setting "Factory ambient lighting off" can switch this check off)';
        return null;
    }
    /** What the controller asks before every write. */
    gate() { return this.stopped ? 'the app is stopping' : this.factoryGate() || this.holdReason(); }

    /** One look at the gate at a time: the timer, a signal and the controller may all ask at once. */
    gateTick() { const p = this._gateOp.then(() => this._gateStep(), () => this._gateStep()); this._gateOp = p.catch(() => {}); return p; }
    async _gateStep() {
        const ctl = this.ctl;
        if (!ctl || this.stopped) return;
        this.syncEffects();
        if (this.busy) return;                                // (an Apply in hand: the controller asks the gate itself; the next tick looks again)
        const release = this.factoryGate(), hold = release ? null : this.holdReason(), why = release || hold;
        if (why && (ctl.program || ctl.driven.size)) {
            if (ctl.program) this.suspended = still(ctl.program);
            this.busy = true;
            // (the car left: the release and nothing after it; the factory lighting switched off with someone in the car: one read-back)
            try { if (release) { await ctl.restoreOem({ verify: this.carState() !== 'away' }); this.stats.releases++; } else { await ctl.lapse(hold); this.stats.lapses++; } } finally { this.busy = false; }
            this.log.info('custom lighting ' + (release ? 'released' : 'left to lapse') + ': ' + why);
            this.say('Custom lighting ' + (release ? 'released' : 'stopped') + ': ' + why, 4500);
        } else if (!why && this.lastGate && this.suspended && !ctl.program && this.settings.get('resume') === 'on') {
            const p = this.suspended; this.suspended = null;
            this.busy = true;
            try {
                const r = await ctl.apply(this.settings.get('welcome') === 'on' ? { mode: 'welcome', then: p } : p);
                if (r.ok) { this.stats.resumes++; this.say('Lighting back on: ' + S.describe(p, ctl.slaves), 3000); } else this.log.info('resume refused: ' + (r.reason || 'refused'));
            } finally { this.busy = false; }
        }
        this.lastGate = why;
    }

    /* ---------- the car's signals ---------- */
    /**
     * What the settings and the car ask for now, handed to the controller (which does nothing when unchanged).
     * doors: the open doors. Their contour lines are handed back to BMW (the factory handback, once) and left alone
     * until they close, so the car shows its own door warning; nothing is blinked or coloured by this app. A door
     * that stays open keeps its line with BMW for as long as it is open: there is nothing to time out, because
     * nothing is being written to it. A lost door signal counts as every door closed.
     */
    syncEffects() {
        const { settings, car, ctl } = this;
        if (!ctl || !car || this.stopped) return null;
        const gated = !!this.gate(), lost = car.lost();
        const doors = settings.get('doorRelease') !== 'off' && !gated && !lost.doors ? car.doors() : [];
        const turn = settings.get('turnGlow') === 'on' && !gated && !lost.turn ? sidesOf(car.turn(), settings.get('drive') === 'lhd' ? 'lhd' : 'rhd') : [];
        const dim = settings.get('nightDim') === 'on' && car.night() === true ? NIGHT_DIM : 1;
        const p = ctl.setEffects({ doors, turn, dim });
        if (p && p.catch) p.catch((e) => this.log.warn('effects: ' + e));
        return { doors, turn, dim };
    }

    /* ---------- what the driver asks for ---------- */
    /** Apply a confirmed program. Resolves { ok, reason?, ... } (ok false with reason 'busy' while another is in hand). */
    async apply(program, opts) {
        if (this.busy) return { ok: false, reason: 'busy' };
        this.touch();
        this.busy = true;
        try {
            const r = await this.ctl.apply(program);
            if (r.ok && !(opts && opts.remember === false)) this.favs.setLast(program);
            return r;
        } finally { this.busy = false; }
    }
    /** The off switch: back to the factory lighting, and nothing comes back by itself afterwards. */
    async restoreOem() {
        if (this.busy) return { ok: false, reason: 'busy' };
        this.touch();
        this.busy = true;
        try {
            const r = await this.ctl.restoreOem();
            this.favs.clearLast();
            this.suspended = null;
            return r;
        } finally { this.busy = false; }
    }

    /* The driving mode followed (setting, off by default): the mode's own program, the driver's lighting, or BMW's. */
    async followMode(m, was) {
        const { settings, ctl, drive } = this;
        if (settings.get('modeFollow') !== 'on' || !ctl || this.busy) return;
        const c = drive.choice(m), last = this.favs.lastApplied();
        let p = c.type === 'custom' ? c.program : c.type === 'default' ? (last ? last.program : null) : null;
        this.busy = true;
        try {
            if (!p) { if (c.type === 'oem' && ctl.program) { await ctl.restoreOem(); this.say(drive.label(m) + ': BMW lighting', 2500); } return; }
            // (the pulse: only on a driving-mode status this module could decode, with its setting on)
            if (m === 'sport' && was && settings.get('sportPulse') === 'on') p = { mode: 'pulse', then: p };
            const r = await ctl.apply(p);
            if (r.ok) this.say(drive.label(m) + ': ' + S.describe(still(p), ctl.slaves), 2500); else this.log.info('driving mode ' + m + ': not applied: ' + (r.reason || 'refused'));
        } finally { this.busy = false; }
    }

    /* ---------- apply the last lighting at start (setting, off by default) ----------
     * The last configuration Apply sent is kept (favourites.json "last"); Restore OEM clears it. With the setting on,
     * it is applied once the link is up, retrying for a while when the parking state is not yet known (the speed
     * signal arrives a moment after start) and giving up quietly on any other refusal. */
    _autoApplyAtStart() {
        const { settings, log } = this;
        const last = this.favs.lastApplied();
        if (settings.get('autoApply') !== 'on' || !last) return;
        let tries = 0;
        const again = () => { this._autoTimer = this._setTimeout(attempt, 1500); };
        const attempt = async () => {
            this._autoTimer = null;
            const ctl = this.ctl, drive = this.drive;
            if (this.stopped || ctl.program || this.busy) return;                   // the driver got there first
            // the car has not said whether it is in use yet: wait for it, never guess
            if (drive && drive.stateAwaited() && ++tries < 20) return again();
            if (drive && drive.stateAwaited()) { log.info('apply at start skipped: the car never said its state'); return; }
            if (ctl.state !== 'connected') { if (++tries < 20) again(); return; }
            const can = ctl.canControl();
            if (!can.ok && /parking state unknown|has not said/.test(can.reason || '') && ++tries < 20) return again();
            if (!can.ok) { log.info('apply at start skipped: ' + can.reason); return; }
            this.busy = true;
            try {
                const r = await ctl.apply(settings.get('welcome') === 'on' && !S.isAnimated(last.program) ? { mode: 'welcome', then: last.program } : last.program);
                if (r.ok) this.say('Last lighting applied: ' + S.describe(last.program, ctl.slaves), 3000); else log.info('apply at start refused: ' + (r.reason || 'refused'));
            } finally { this.busy = false; }
        };
        this._autoTimer = this._setTimeout(attempt, 50);
    }

    /** For the Diagnostics page. */
    status() {
        return {
            state: this.carState(), release: this.factoryGate(), hold: this.holdReason(), strict: this.strict(),
            factoryOn: this.oem ? this.oem.factoryOn() : null, suspended: !!this.suspended, stats: Object.assign({}, this.stats),
            effects: this.ctl ? Object.assign({}, this.ctl.effects) : null, car: this.car ? this.car.summary() : '-',
        };
    }
}

/** The process's one service: made on the first call, the same one after it. */
function service(o) {
    // (the same settings object = the same app start; a test's fresh harness gets a service of its own)
    if (instance && !instance.stopped && instance.settings === o.settings) return instance;
    instance = new LightingService(o);
    return instance;
}

module.exports = { LightingService, service, still, IDLE_MS, NIGHT_DIM, GATE_MS, LINK_KEYS, COMFORT_SOCK };

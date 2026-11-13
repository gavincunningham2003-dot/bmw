'use strict';
/* 0.5.0: the factory gate (factory lighting off, car parked / left, signals missing or lost), the background
 * service and its shutdown, the car's signals (an open door: its line back to BMW since 0.5.1, indicator green,
 * night), and the transport rules
 * (no reply is never resent, busy retries configurable, a maximum duration for one command). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS, STAGE } = require('../../scripts/stage');
const { MockLightingController, MockBdc } = require(path.join(JS, 'lighting_mock'));
const { BdcUdsLightingController } = require(path.join(JS, 'lighting_bdc_uds'));
const { WriteScheduler } = require(path.join(JS, 'lighting_scheduler'));
const { LightingService } = require(path.join(JS, 'lighting_service'));
const { OemLighting } = require(path.join(JS, 'oem_lighting'));
const CS = require(path.join(JS, 'car_signals'));
const O = require(path.join(JS, 'lighting_overlay'));
const S = require(path.join(JS, 'lighting_scene'));
const PL = require(path.join(JS, 'lighting_plan'));
const P = require(path.join(JS, 'lighting_protocol'));
const { bus } = require('./fake_tasu');
const { harness } = require('./ui_harness');

const SPEC = JSON.parse(fs.readFileSync(path.join(STAGE, 'app.json'), 'utf8'));
const COND = 'de.bmw.infrastructure.VehicleCondition', COMFORT = 'de.bmw.infotainment.misc.ComfortFunctionIuK', AMBIENT = 'de.bmw.body.interiorillumination.AmbientLight';
const DOORS = 'de.bmw.body.DoorsWindowsRoofMirrors', LIGHT = 'de.bmw.body.Light', VEHICLE = 'de.bmw.infotainment.vehicle.Vehicle';
const BLUE = { mode: 'solid', colour: { r: 0, g: 0, b: 254 }, brightness: 100, zone: 'all' };
const RAINBOW = { mode: 'rainbow', zone: 'all' };
const FOOT = { mode: 'solid', colour: { r: 0, g: 254, b: 0 }, brightness: 100, zone: 'footwells' };
// the G20's four door contour lines, where the body controller reported them (2026-11-04)
const LINE = { passengerFront: '1:3', passengerRear: '1:6', driverFront: '2:8', driverRear: '2:11' };

function fakeSettings(sets) {
    const values = {};
    SPEC.settings.forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, sets || {});
    const handlers = [];
    return { get: (k) => values[k], set(k, v) { values[k] = v; handlers.forEach((fn) => fn(k)); }, onChange: (fn) => handlers.push(fn), values };
}
/** kit/signals faked: watch() keeps the handlers so a test can speak as the car; every sub can be made to go away. */
function fakeSignals(o) {
    const H = {}, subs = {};
    return {
        H, subs,
        watch: async (iface, inst, handlers) => {
            if (o && o.missing && o.missing.indexOf(iface) >= 0) return { iface, available: false, error: 'no SOME/IP config for ' + iface };
            H[iface] = handlers;
            subs[iface] = { iface, available: true, error: null, closed: false, shutdown: async () => { subs[iface].closed = true; } };
            return subs[iface];
        },
    };
}
/** A service on the simulated BDC with fake time. opts: sets, mock (MockBdc options), ctl (controller options), strict, missing. */
async function makeService(opts) {
    const o = opts || {};
    const clock = fakeClock();
    const settings = fakeSettings(o.sets), signals = fakeSignals(o);
    const bdc = new MockBdc(Object.assign({ now: clock.now }, o.mock || {}));
    const lines = [];
    const log = { info: (m) => lines.push(String(m)), warn: (m) => lines.push('WARN ' + m), error: (m) => lines.push('ERROR ' + m) };
    const made = [];
    const svc = new LightingService({
        settings, signals, log, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-svc-')),
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        setInterval: () => ({ fake: true }), clearInterval: () => { svc.intervalCleared = true; },
        strict: o.strict, idleMs: o.idleMs, comfortSock: path.join(os.tmpdir(), 'no-such-comfort.sock'),
        parkedWatch: () => ({ speed: () => (o.speed == null ? 0 : o.speed), moving: () => (o.speed || 0) > 3 }),
        controller: (common) => { const c = new MockLightingController(Object.assign({}, common, { bdc }, o.ctl || {})); made.push(c); return c; },
    });
    await svc.start();
    for (let i = 0; i < 6; i++) await tick();                // the subscriptions settle
    const say = [];
    svc.on('say', (t) => say.push(t));
    const car = {
        condition: (n) => signals.H[COND].VehicleCondition({ statusConditionVehicle: n }),
        factory: (mode, menu) => signals.H[COMFORT].statusAmbientLightInteriorColour({ statusHueInteriorLighting: 100, statusMenuAmbientePanoramicRoofInteriorLighting: menu == null ? 4 : menu, statusModeAmbientePanoramicRoofInteriorLighting: mode }),
        doors: (v) => signals.H[DOORS].CentralLockingSystemAndPanelStatus(Object.assign({ statusDoorSwitchDRD: 0, statusDoorSwitchPSD: 0, statusDoorSwitchDRDR: 0, statusDoorSwitchPSDR: 0 }, v)),
        turn: (v) => signals.H[LIGHT].StatusFunctionsIndicators({ activeFunctionIndicateDirection: v }),
        night: (v) => signals.H[VEHICLE].statusDayNightChangeOver({ dayNightChangeOver: v }),
    };
    return { svc, clock, settings, signals, bdc, lines, say, car, made };
}
const writes = (bdc) => bdc.requests.filter((r) => r.sid === 0x2E);
const keyOf = (r) => (r.data[0] === 0xDA ? 1 : 2) + ':' + r.data[2];
const phys = (svc, key) => { const p = svc.ctl.physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
const settle = async (svc) => { await tick(); await svc.gateTick(); await svc.ctl.scheduler.drain(); await tick(); };
const allOem = (svc) => svc.ctl.slaves.every((s) => phys(svc, S.key(s))[4] === 'oem');

/* ================= the factory ambient lighting switch ================= */
test('factoryOn(): the catalogue field and its values; unfilled, never received and a lost provider are unknown, never "on"', () => {
    const o = new OemLighting(null, null);
    assert.strictEqual(o.factoryOn(), null, 'nothing received');
    const seen = [];
    o.on('change', (is) => seen.push(is));
    o.take('statusAmbientLightInteriorColour', { statusModeAmbientePanoramicRoofInteriorLighting: 1, statusMenuAmbientePanoramicRoofInteriorLighting: 4 });
    assert.strictEqual(o.factoryOn(), true);
    o.take('statusAmbientLightInteriorColour', { statusModeAmbientePanoramicRoofInteriorLighting: 0, statusMenuAmbientePanoramicRoofInteriorLighting: 4 });
    assert.strictEqual(o.factoryOn(), false, 'mode AUS (0)');
    o.take('statusAmbientLightInteriorColour', { statusModeAmbientePanoramicRoofInteriorLighting: 'EIN', statusMenuAmbientePanoramicRoofInteriorLighting: 'AMBIENTEBELEUCHTUNG_AUS' });
    assert.strictEqual(o.factoryOn(), false, 'the menu says off: off wins');
    o.take('statusAmbientLightInteriorColour', { statusModeAmbientePanoramicRoofInteriorLighting: 3, statusMenuAmbientePanoramicRoofInteriorLighting: 15 });
    assert.strictEqual(o.factoryOn(), null, 'SIGNAL_UNBEFUELLT is not "on"');
    o.take('ambientLightActive', true);
    assert.strictEqual(o.factoryOn(), true, 'the body interface alone');
    o.take('ambientLightActive', false);
    assert.strictEqual(o.factoryOn(), false);
    assert.deepStrictEqual(seen, [true, false, null, true, false]);
    // the provider of a value goes away: what it said is no longer believed
    o.take('ambientLightActive', true);
    o.subs.ambient = { available: false, error: null };
    assert.strictEqual(o.factoryOn(), null);
});
test('the wire layout IterioDev reads (service 0xB512 event 0x8003, payload byte 7) is that same field in this head unit\'s catalogue', () => {
    // the struct as the catalogue lists it: UInt16 hue, menu, three layer hues, brightness offset, then the mode
    const order = ['statusHueInteriorLighting:2', 'statusMenuAmbientePanoramicRoofInteriorLighting:1', 'statusHueValueLayer1IndividualGroup:1', 'statusHueValueLayer2IndividualGroup:1',
        'statusHueValueLayer3IndividualGroup:1', 'statusBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting:1', 'statusModeAmbientePanoramicRoofInteriorLighting:1'];
    let offset = 0;
    const at = {};
    order.forEach((f) => { const [name, size] = f.split(':'); at[name] = offset; offset += Number(size); });
    assert.strictEqual(at.statusModeAmbientePanoramicRoofInteriorLighting, 7);
    assert.strictEqual(0xB512, 46354); assert.strictEqual(0x8003, 32771);
    assert.ok(SPEC.signals[COMFORT].statusAmbientLightInteriorColour === 'rs', 'read and subscribed, never written');
});
test('factory ambient lighting switched OFF: custom lighting is released at once, with the screen closed', async () => {
    const { svc, car, bdc, say } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    assert.strictEqual(svc.gate(), null);
    assert.ok((await svc.apply(BLUE)).ok);
    assert.deepStrictEqual(phys(svc, '2:1').slice(0, 3), [0, 0, 254]);
    const before = writes(bdc).length;
    car.factory(0);                                           // the driver switches the ambient lighting off in iDrive
    await settle(svc);
    assert.strictEqual(svc.ctl.program, null);
    assert.ok(allOem(svc), 'every module handed back');
    assert.deepStrictEqual(writes(bdc).slice(before).map(keyOf), ['1:0', '2:0'], 'one release a bus (NAD 0), bus 1 then bus 2, nothing else');
    assert.ok(writes(bdc).slice(before).every((r) => r.data[3] === 0 && r.data.slice(4).every((b) => b === 0)));
    assert.ok(/released.*switched off/.test(say.join('|')), say.join('|'));
    const r = await svc.apply(BLUE);
    assert.ok(!r.ok && /factory ambient lighting is switched off/.test(r.reason));
});
test('factory lighting ON again: nothing comes back by itself; with the setting on it does', async () => {
    const a = await makeService({ strict: true });
    a.car.condition(5); a.car.factory(1);
    await a.svc.apply(BLUE);
    a.car.factory(0); await settle(a.svc);
    const n = writes(a.bdc).length;
    a.car.factory(1); await settle(a.svc);
    await a.clock.advance(20000); await settle(a.svc);
    assert.strictEqual(a.svc.ctl.program, null, 'still the factory lighting');
    assert.strictEqual(writes(a.bdc).length, n, 'not one write');
    const b = await makeService({ strict: true, sets: { resume: 'on' } });
    b.car.condition(5); b.car.factory(1);
    await b.svc.apply(BLUE);
    b.car.factory(0); await settle(b.svc);
    assert.strictEqual(b.svc.ctl.program, null);
    b.car.factory(1); await settle(b.svc);
    assert.ok(b.svc.ctl.program && b.svc.ctl.program.mode === 'solid');
    assert.deepStrictEqual(phys(b.svc, '1:1').slice(0, 3), [0, 0, 254]);
});
test('the setting "Keep custom lighting" ignores the factory switch (and an unknown one)', async () => {
    const { svc, car } = await makeService({ strict: true, sets: { oemOffRule: 'ignore' } });
    car.condition(5);
    assert.ok((await svc.apply(BLUE)).ok, 'the factory state was never received');
    car.factory(0); await settle(svc);
    assert.ok(svc.ctl.program);
});

/* ================= parked / locked ================= */
test('vehicle states 1, 2 and 3 (parked, parked, standby with nobody in it) each release; 5, 7, 8, 10, 12 do not', async () => {
    for (const n of [1, 2, 3]) {
        const { svc, car, bdc } = await makeService({ strict: true });
        car.condition(5); car.factory(1);
        await svc.apply(BLUE);
        car.condition(n); await settle(svc);
        assert.strictEqual(svc.ctl.program, null, 'state ' + n);
        assert.ok(allOem(svc), 'state ' + n + ': handed back');
        assert.strictEqual(svc.carState(), 'away');
        const after = writes(bdc).length;
        assert.ok(!(await svc.apply(BLUE)).ok, 'nothing applied while away');
        assert.strictEqual(writes(bdc).length, after);
    }
    for (const n of [5, 7, 8, 10, 12]) {
        const { svc, car } = await makeService({ strict: true });
        car.factory(1); car.condition(n);
        assert.ok((await svc.apply(BLUE)).ok, 'state ' + n);
        await settle(svc);
        assert.ok(svc.ctl.program, 'state ' + n + ' keeps it');
    }
});
test('the car left: an animation stops, keep-alives stop, and nothing is written afterwards (the car can sleep)', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(10); car.factory(1);
    await svc.apply(RAINBOW);
    await clock.advance(2000);
    assert.ok(svc.ctl.stats.frames > 3);
    car.condition(2); await settle(svc);
    const frames = svc.ctl.stats.frames, n = writes(bdc).length;
    await clock.advance(120000);
    for (let i = 0; i < 5; i++) await svc.gateTick();
    assert.strictEqual(svc.ctl.stats.frames, frames, 'no more frames');
    assert.strictEqual(writes(bdc).length, n, 'no write of any kind after the release');
    assert.strictEqual(clock.pending(), 0, 'no timer left running in the controller');
    assert.ok(allOem(svc));
});
test('unlocked again: the factory lighting stays (default); with "resume" the lighting returns, with the welcome sweep if set', async () => {
    const a = await makeService({ strict: true });
    a.car.condition(5); a.car.factory(1);
    await a.svc.apply(BLUE);
    a.car.condition(1); await settle(a.svc);
    a.car.condition(5); await settle(a.svc);
    assert.strictEqual(a.svc.ctl.program, null);
    const b = await makeService({ strict: true, sets: { resume: 'on', welcome: 'on' } });
    b.car.condition(5); b.car.factory(1);
    await b.svc.apply(BLUE);
    b.car.condition(3); await settle(b.svc);
    b.car.condition(5); await settle(b.svc);
    assert.strictEqual(b.svc.ctl.program.mode, 'welcome');
    await b.clock.advance(4000);
    assert.strictEqual(b.svc.ctl.program.mode, 'solid');
});
test('Restore OEM is the off switch: nothing comes back after the car is unlocked, even with "resume" on', async () => {
    const { svc, car } = await makeService({ strict: true, sets: { resume: 'on' } });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    await svc.restoreOem();
    car.condition(1); await settle(svc); car.condition(5); await settle(svc);
    assert.strictEqual(svc.ctl.program, null);
    assert.strictEqual(svc.favs.lastApplied(), null);
});

/* ================= missing, stale and lost signals ================= */
test('no vehicle state at all: in use only while something shows it; after 15 min without, the lights are left to lapse with NO write', async () => {
    const { svc, car, bdc, clock, say } = await makeService({ strict: true, missing: [COND] });
    car.factory(1);
    assert.strictEqual(svc.drive.away(), null);
    assert.ok((await svc.apply(BLUE)).ok, 'the screen was just used');
    await clock.advance(14 * 60000); await settle(svc);
    assert.ok(svc.ctl.program, 'still inside the window');
    const n = writes(bdc).length;
    await clock.advance(61000); await settle(svc);
    assert.strictEqual(svc.carState(), 'unknown');
    assert.strictEqual(svc.ctl.program, null);
    assert.ok(writes(bdc).slice(n).every((r) => r.data[3] === 1), 'not even a release: the car may be asleep');
    const stopped = writes(bdc).length;
    await clock.advance(5000); await settle(svc);
    assert.strictEqual(writes(bdc).length, stopped, 'and no write of any kind from then on');
    assert.ok(/stopped/.test(say.join('|')));
    // the simulated lights go back by themselves when their time is up
    await clock.advance(31000);
    assert.ok(allOem(svc));
    const r = await svc.ctl.apply(BLUE);
    assert.ok(!r.ok && /has not said it is in use/.test(r.reason), r.reason);
    svc.touch();                                              // someone uses the screen again
    assert.ok((await svc.apply(BLUE)).ok);
});
test('the vehicle state\'s provider goes away while "in use": that state is no longer believed', async () => {
    const { svc, car, signals, clock } = await makeService({ strict: true, idleMs: 60000 });
    car.factory(1); car.condition(10);
    await svc.apply(BLUE);
    signals.subs[COND].available = false;                     // disconnected: no event says so
    assert.strictEqual(svc.drive.away(), null);
    await clock.advance(61000); await settle(svc);
    assert.strictEqual(svc.ctl.program, null, 'left to lapse');
});
test('the factory lighting state missing or lost: no Apply, no renewal (a missing signal is not "on")', async () => {
    const a = await makeService({ strict: true, missing: [COMFORT, AMBIENT] });
    a.car.condition(5);
    const r = await a.svc.apply(BLUE);
    assert.ok(!r.ok && /has not said whether the factory ambient lighting is on/.test(r.reason), r.reason);
    assert.strictEqual(writes(a.bdc).length, 0);
    // received once, then its provider goes: the renewals stop and nothing more is sent
    const b = await makeService({ strict: true });
    b.car.condition(5); b.car.factory(1);
    await b.svc.apply(BLUE);
    b.signals.subs[COMFORT].available = false;
    await settle(b.svc);
    const n = writes(b.bdc).length;
    assert.strictEqual(b.svc.ctl.program, null);
    await b.clock.advance(60000); await settle(b.svc);
    assert.strictEqual(writes(b.bdc).length, n);
    assert.ok(allOem(b.svc), 'lapsed by itself');
});
test('the keep-alive itself asks the gate: a state that changes between two looks still stops the renewal', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    // the signal changes without its event reaching the service (drive told directly, listeners removed)
    svc.drive.removeAllListeners('away');
    svc.drive.condition({ statusConditionVehicle: 2 });
    const n = writes(bdc).length;
    await clock.advance(30000);                               // several keep-alive periods, no gateTick from the test
    await tick(); await svc._gateOp; await svc.ctl.scheduler.drain();
    assert.ok(writes(bdc).slice(n).every((r) => r.data[3] === 0), 'only releases after the state changed');
    assert.strictEqual(svc.ctl.program, null);
});
test('the simulated BDC: unknown signals do not stop it (there is no car to keep awake), known ones still do', async () => {
    const { svc, car, clock } = await makeService({ missing: [COND, COMFORT, AMBIENT] });
    assert.strictEqual(svc.strict(), false);
    await clock.advance(3600000);
    assert.ok((await svc.ctl.apply(BLUE)).ok);
    const b = await makeService({});
    b.car.condition(2);
    assert.ok(!(await b.svc.apply(BLUE)).ok);
});

/* ================= the background service and shutdown ================= */
test('first install: simulated BDC, disarmed, nothing applied at start, every effect off, autostart requested', async () => {
    const def = (k) => SPEC.settings.find((s) => s.key === k).default;
    assert.strictEqual(def('backend'), 'mock');
    assert.strictEqual(def('arm'), 'off');
    assert.strictEqual(def('autoApply'), 'off');
    ['turnGlow', 'nightDim', 'resume', 'modeFollow', 'sportPulse', 'welcome'].forEach((k) => assert.strictEqual(def(k), 'off', k));
    // (0.5.1: whole-bus writes by default, seen on this car on 2026-11-12; an open door's line goes back to BMW)
    assert.strictEqual(def('inflight'), '1'); assert.strictEqual(def('txMode'), 'broadcast'); assert.strictEqual(def('doorRelease'), 'on');
    assert.strictEqual(SPEC.autostart, true);
    const { svc, bdc } = await makeService({});
    assert.strictEqual(svc.ctl.kind, 'mock');
    assert.strictEqual(writes(bdc).length, 0);
    assert.strictEqual(svc.ctl.program, null);
});
test('the service runs without the screen: the last lighting at start, animation, the door handback and the factory gate all with no UI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-bg-'));
    fs.writeFileSync(path.join(dir, 'favourites.json'), JSON.stringify({ favourites: [], presets: [], last: { program: RAINBOW, at: 1 } }));
    const clock = fakeClock(), settings = fakeSettings({ autoApply: 'on' }), signals = fakeSignals(), bdc = new MockBdc({ now: clock.now });
    const svc = new LightingService({ settings, signals, log: null, dataDir: dir, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => 1, clearInterval() {},
        parkedWatch: () => ({ speed: () => 0, moving: () => false }), controller: (c) => new MockLightingController(Object.assign({}, c, { bdc })) });
    await svc.start();
    for (let i = 0; i < 6; i++) await tick();
    signals.H[COND].VehicleCondition({ statusConditionVehicle: 5 });
    await clock.advance(3000);
    assert.strictEqual(svc.ctl.program && svc.ctl.program.mode, 'rainbow', 'the last lighting came back by itself (setting on)');
    const f = svc.ctl.stats.frames;
    await clock.advance(2000);
    assert.ok(svc.ctl.stats.frames > f, 'the animation runs with no screen');
    signals.H[DOORS].CentralLockingSystemAndPanelStatus({ statusDoorSwitchDRD: 1 });
    await tick(); await clock.advance(500);
    assert.strictEqual(phys(svc, LINE.driverFront)[4], 'oem', 'the open door\'s line is BMW\'s');
    assert.strictEqual(phys(svc, '2:1')[4], 'custom', 'the rainbow runs on around it');
    signals.H[COND].VehicleCondition({ statusConditionVehicle: 2 });
    await settle(svc);
    assert.ok(allOem(svc));
    await svc.stop();
});
test('main.js: the background start makes the service; opening the screen reuses it (one controller, one set of timers); the platform\'s shutdown stops it', async () => {
    // the app loaded as the kit loads it, with a background start and no screen
    let impl = null;
    const realLoad = Module._load;
    Module._load = function (req) { if (/kit[\\/]mgu$/.test(req) || req === './kit/mgu') return { run: (i) => { impl = i; } }; return realLoad.apply(this, arguments); };
    const appFile = path.join(JS, 'app.js');
    delete require.cache[appFile];
    try { require(appFile); } finally { Module._load = realLoad; }
    assert.strictEqual(typeof impl.background, 'function');
    const settings = fakeSettings({}), signals = fakeSignals(), on = {};
    const log = { info() {}, warn() {}, error() {} };
    const sigterm = process.listenerCount('SIGTERM');
    const bg = await impl.background({ app: { on: (ev, fn) => { on[ev] = fn; } }, log, settings, signals, spec: SPEC, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-main-')) });
    const svc = bg.svc;
    assert.ok(svc.started && svc.ctl && svc.ctl.state === 'connected');
    assert.strictEqual(typeof on.shutdown, 'function', 'the platform\'s shutdown is listened for');
    for (let i = 0; i < 6; i++) await tick();
    // lighting applied with the screen never opened
    signals.H[COND].VehicleCondition({ statusConditionVehicle: 5 });
    assert.ok((await svc.apply(RAINBOW)).ok);
    const ctl = svc.ctl;
    // the screen opens: the same service, the same controller, nothing started twice
    const h = await harness({ background: bg, settings, signals });
    assert.strictEqual(h.app.svc, svc);
    assert.strictEqual(h.app.ctl(), ctl);
    assert.strictEqual(svc.stats.starts, 1);
    assert.strictEqual(svc.ctl.program.mode, 'rainbow', 'opening the screen did not disturb the lighting');
    await h.frame();
    // the platform asks the app to stop: animation off, modules released, timers cleared, subscriptions closed
    on.shutdown();
    await svc._stopping;
    assert.strictEqual(svc.stopped, true);
    assert.strictEqual(ctl.program, null);
    assert.strictEqual(ctl.driven.size, 0, 'every module released');
    assert.ok(ctl.slaves.every((s) => ctl.physicalColour(S.key(s)).source === 'oem'));
    assert.strictEqual(svc._gateTimer, null);
    // (the kit's own speed watcher, kit/parked.js, has no shutdown: it ends with the process)
    assert.ok(Object.keys(signals.subs).filter((k) => !/Vehicle2$/.test(k)).every((k) => signals.subs[k].closed), 'every subscription of the service closed');
    const n = ctl.bdc.requests.length;
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(ctl.bdc.requests.length, n, 'nothing is written after the stop');
    assert.strictEqual(await svc.stop(), null, 'a second stop is harmless');
    process.removeAllListeners('SIGTERM');
    assert.ok(sigterm <= 1);
});
test('shutdown with effects and an animation running: both stop, the release goes out once, a dead transport is reported not hidden', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true, sets: { turnGlow: 'on' } });
    car.condition(5); car.factory(1);
    await svc.apply(RAINBOW);
    car.doors({ statusDoorSwitchPSD: 1 }); car.turn(6);
    await tick(); await clock.advance(1000);
    const before = writes(bdc).length;
    const r = await svc.stop('test');
    assert.strictEqual(r.ok, true);
    assert.ok(allOem(svc));
    assert.deepStrictEqual(writes(bdc).slice(before).map(keyOf), ['1:0', '2:0'], 'the whole cabin back in two writes, well inside the platform\'s 200 ms');
    const n = writes(bdc).length;
    const reads = bdc.requests.length;
    car.doors({ statusDoorSwitchDRD: 1 });                     // a late event
    await clock.advance(5000);
    assert.strictEqual(writes(bdc).length, n, 'nothing after the stop');
    assert.strictEqual(bdc.requests.length, reads, 'not even a read-back');
    assert.strictEqual(clock.pending(), 0);
    assert.strictEqual(svc.intervalCleared, true);
    // the transport already gone at shutdown: said, and the modules lapse by themselves
    const b = await makeService({ strict: true });
    b.car.condition(5); b.car.factory(1);
    await b.svc.apply(BLUE);
    b.bdc.offline = true;
    const rb = await b.svc.stop('test');
    assert.strictEqual(rb.ok, false);
    assert.ok(/lapse by themselves/.test(rb.reason));
});
test('changing a link setting replaces the controller without leaving the old one running', async () => {
    const { svc, car, settings, made, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(RAINBOW);
    const old = svc.ctl;
    settings.set('txMode', 'individual');
    for (let i = 0; i < 10; i++) await tick();
    assert.strictEqual(made.length, 2);
    assert.notStrictEqual(svc.ctl, old);
    assert.strictEqual(old.program, null);
    assert.strictEqual(old.listenerCount('gated'), 0);
    const f = old.stats.frames;
    await clock.advance(3000);
    assert.strictEqual(old.stats.frames, f, 'the old controller\'s ticker is gone');
});

/* ================= an open door: its contour line goes back to BMW ================= */
/* 0.5.1: the app no longer blinks an open door's line red. It hands that one module back with the factory
 * handback (ZUSTAND 0), writes nothing to it while the door is open (no single write, no keep-alive, no whole-bus
 * write on its bus), and gives it the colour of the moment when the door closes. BMW shows its own warning. */
const DOOR_FIELD = { driverFront: 'statusDoorSwitchDRD', passengerFront: 'statusDoorSwitchPSD', driverRear: 'statusDoorSwitchDRDR', passengerRear: 'statusDoorSwitchPSDR' };
const isRelease = (r) => r.data[3] === 0 && r.data.slice(4).every((b) => b === 0);
const isRed = (r) => r.data[3] === 1 && r.data[5] >= 250 && r.data[6] === 0 && r.data[7] === 0;
const isBlack = (r) => r.data[3] === 1 && r.data[4] === 0;
test('door signal decoding: each of the four door switches by name or number; implausible and invalid are not "open"', () => {
    assert.deepStrictEqual(CS.doorsOf({ statusDoorSwitchDRD: 1 }), ['driverFront']);
    assert.deepStrictEqual(CS.doorsOf({ statusDoorSwitchPSD: 'BEIFAHRERTUER_IST_OFFEN' }), ['passengerFront']);
    assert.deepStrictEqual(CS.doorsOf({ statusDoorSwitchDRDR: 'FATH_IST_OFFEN' }), ['driverRear']);
    assert.deepStrictEqual(CS.doorsOf({ statusDoorSwitchPSDR: 1 }), ['passengerRear']);
    assert.deepStrictEqual(CS.doorsOf({ statusDoorSwitchDRD: 0, statusDoorSwitchPSD: 2, statusDoorSwitchDRDR: 3, statusDoorSwitchPSDR: 'BFTH_IST_GESCHLOSSEN', statusContactBootLid: 1, statusContactBonnet: 1 }), [], 'the boot and the bonnet are not doors here');
    assert.deepStrictEqual(CS.doorsOf(null), []);
    assert.strictEqual(SPEC.signals[DOORS].CentralLockingSystemAndPanelStatus, 's');
});
test('the red door blink is gone: no setting for it, nothing in the overlay, and the handback is on from the first start', () => {
    assert.strictEqual(SPEC.settings.find((s) => s.key === 'doorFlash'), undefined);
    assert.strictEqual(SPEC.settings.find((s) => s.key === 'doorRelease').default, 'on');
    assert.strictEqual(O.RED, undefined);
    // an open door takes its line OUT of the scene; it puts no colour in
    const mods = [{ bus: 2, nad: 8, locationId: 0x05 }, { bus: 2, nad: 1, locationId: 0x15 }];
    const base = { '2:8': { r: 1, g: 2, b: 3, brightness: 50 }, '2:1': { r: 1, g: 2, b: 3, brightness: 50 } };
    assert.deepStrictEqual(O.compose(base, mods, { doors: ['driverFront'], turn: [] }, 0), { '2:1': base['2:1'] });
    assert.deepStrictEqual(O.compose({}, mods, { doors: ['driverFront'], turn: [] }, 0), {}, 'and nothing over the car\'s own lighting');
    assert.strictEqual(O.moving({ doors: ['driverFront'], turn: [] }, mods), false, 'an open door needs no frames');
    assert.deepStrictEqual(O.releasedKeys({ doors: ['driverFront'] }, mods), ['2:8']);
});
test('each door: ONE release to its own contour line, nothing else touched, nothing written to it while it is open, the colour back when it closes', async () => {
    for (const door of Object.keys(LINE)) {
        const { svc, car, bdc, clock } = await makeService({ strict: true });
        car.condition(5); car.factory(1);
        await svc.apply(BLUE);
        await clock.advance(2000);                              // (the background read-back is done)
        const n = writes(bdc).length, bus = LINE[door].split(':')[0];
        car.doors({ [DOOR_FIELD[door]]: 1 });
        await tick(); await svc.ctl.scheduler.drain();
        const opened = writes(bdc).slice(n);
        assert.deepStrictEqual(opened.map(keyOf), [LINE[door]], door + ': one write, to that door\'s line');
        assert.ok(isRelease(opened[0]), door + ': the factory handback (ZUSTAND 0), not a colour');
        assert.strictEqual(phys(svc, LINE[door])[4], 'oem', door + ': BMW has it');
        assert.ok(!svc.ctl.driven.has(LINE[door]) && !svc.ctl.scene[LINE[door]]);
        svc.ctl.slaves.filter((s) => S.key(s) !== LINE[door]).forEach((s) => assert.deepStrictEqual(phys(svc, S.key(s)), [0, 0, 254, 100, 'custom'], door + ': ' + S.key(s) + ' keeps the colour'));
        // open for a while: keep-alives go on for the others, the door's line is never written, its bus never as a whole
        await clock.advance(30000);
        const during = writes(bdc).slice(n + 1);
        assert.ok(during.length > 18, door + ': the others are kept alive');
        assert.ok(during.every((r) => keyOf(r) !== LINE[door]), door + ': not one write to the open door\'s line');
        assert.ok(during.every((r) => keyOf(r) !== bus + ':0'), door + ': no whole-bus write on its bus');
        assert.ok(during.every((r) => r.data[2] !== 0), door + ': a still colour is kept alive with targeted writes on both buses');
        assert.ok(writes(bdc).slice(n).every((r) => !isRed(r) && !isBlack(r)), door + ': no red and no black from the app');
        assert.strictEqual(phys(svc, LINE[door])[4], 'oem');
        svc.ctl.slaves.filter((s) => S.key(s) !== LINE[door]).forEach((s) => assert.strictEqual(phys(svc, S.key(s))[4], 'custom', door + ': ' + S.key(s) + ' never lapsed'));
        // closed
        const m = writes(bdc).length;
        car.doors({});
        await tick(); await svc.ctl.scheduler.drain();
        assert.deepStrictEqual(writes(bdc).slice(m).map(keyOf), [LINE[door]], door + ': one write gives it the colour back');
        assert.deepStrictEqual(phys(svc, LINE[door]), [0, 0, 254, 100, 'custom']);
        assert.strictEqual(svc.ctl.program.mode, 'solid');
        const k = writes(bdc).length;
        await clock.advance(12000);
        assert.ok(writes(bdc).slice(k).some((r) => keyOf(r) === LINE[door]), door + ': its line is kept alive again with the others');
    }
});
test('several doors open at once: each line released on its own; one closing leaves the others with BMW', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    await clock.advance(2000);
    const n = writes(bdc).length;
    // the driver's two doors are on the same LIN bus: two single releases, never the bus
    car.doors({ statusDoorSwitchDRD: 1, statusDoorSwitchDRDR: 1, statusDoorSwitchPSD: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf).sort(), [LINE.passengerFront, LINE.driverRear, LINE.driverFront].sort());
    assert.ok(writes(bdc).slice(n).every(isRelease));
    ['driverFront', 'driverRear', 'passengerFront'].forEach((d) => assert.strictEqual(phys(svc, LINE[d])[4], 'oem', d));
    assert.deepStrictEqual(phys(svc, LINE.passengerRear).slice(0, 3), [0, 0, 254]);
    assert.deepStrictEqual(phys(svc, '2:1').slice(0, 3), [0, 0, 254], 'the dash, on the driver doors\' bus, keeps its colour');
    car.doors({ statusDoorSwitchDRD: 1, statusDoorSwitchPSD: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(phys(svc, LINE.driverRear), [0, 0, 254, 100, 'custom'], 'the closed door is back on the applied colour');
    assert.strictEqual(phys(svc, LINE.driverFront)[4], 'oem');
    assert.deepStrictEqual(svc.ctl.effects.doors, ['driverFront', 'passengerFront']);
    assert.deepStrictEqual(svc.ctl.status().released.sort(), [LINE.passengerFront, LINE.driverFront].sort());
});
test('a door while the car has its own lighting: nothing is written at all; a program that leaves the door lines to the car: the same', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    car.doors({ statusDoorSwitchPSD: 1 });
    await tick(); await clock.advance(5000);
    car.doors({});
    await tick(); await clock.advance(5000);
    assert.strictEqual(writes(bdc).length, 0);
    await svc.apply(FOOT);
    const n = writes(bdc).length;
    car.doors({ statusDoorSwitchPSD: 1 }); await tick(); await svc.ctl.scheduler.drain();
    car.doors({}); await tick(); await svc.ctl.scheduler.drain();
    assert.strictEqual(writes(bdc).length, n, 'the door lines were never ours');
    assert.strictEqual(phys(svc, LINE.passengerFront)[4], 'oem');
    assert.deepStrictEqual(phys(svc, '2:4').slice(0, 3), [0, 254, 0], 'the footwells keep their colour');
});
test('the door\'s module comes from the body controller\'s location table, not from a fixed LIN address', async () => {
    // another car: the driver front door line (location 0x05) sits on bus 1 NAD 2; bus 2 NAD 8 is a footwell
    const { svc, car, bdc } = await makeService({ strict: true, mock: { slaves: [0x15, 0x05, 0x0C], slaves2: [0x13, 0x17, 0x09, 0x10, 0x01, 0x02, 0x03, 0x04] } });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    const n = writes(bdc).length;
    car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:2']);
    assert.strictEqual(phys(svc, '1:2')[4], 'oem');
    assert.deepStrictEqual(phys(svc, '2:8').slice(0, 3), [0, 0, 254]);
    assert.strictEqual(O.doorOf({ locationId: 0x05 }), 'driverFront');
    assert.strictEqual(O.doorOf({ locationId: 0x07 }), null, 'a door opener is not the contour line');
    assert.strictEqual(O.doorOf({ locationId: 0x01 }), null);
});
test('all four doors open: only the four interior door contour lines are released, through the allow-listed write', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    await clock.advance(2000);
    const n = writes(bdc).length;
    car.doors({ statusDoorSwitchDRD: 1, statusDoorSwitchPSD: 1, statusDoorSwitchDRDR: 1, statusDoorSwitchPSDR: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    const lines = new Set(Object.keys(LINE).map((d) => LINE[d]));
    const w = writes(bdc).slice(n);
    assert.strictEqual(w.length, 4);
    w.forEach((r) => {
        assert.strictEqual(r.target, 0x40);
        assert.ok((r.data[0] === 0xDA && r.data[1] === 0x5E) || (r.data[0] === 0xE3 && r.data[1] === 0xD1), 'only the interior layering actuator');
        assert.strictEqual(P.checkRequest(0x40, 0x2E, r.data), null);
        assert.ok(lines.has(keyOf(r)) && isRelease(r), keyOf(r) + ' is a door contour line, released');
    });
    await clock.advance(20000);
    assert.ok(writes(bdc).slice(n + 4).every((r) => r.data[2] !== 0 && !lines.has(keyOf(r))), 'both buses have a line with BMW: single writes only, none to a line');
    assert.ok(bdc.requests.every((r) => r.sid === 0x22 || r.sid === 0x2E), 'no routine, no IO control');
});
test('the handback ends with the car left (everything is BMW\'s then) and can be switched off; a door left open causes no writes', async () => {
    const a = await makeService({ strict: true });
    a.car.condition(5); a.car.factory(1);
    await a.svc.apply(BLUE);
    a.car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await a.svc.ctl.scheduler.drain();
    a.car.condition(2); await settle(a.svc);
    assert.ok(allOem(a.svc));
    const n = a.bdc.requests.length;
    await a.clock.advance(10 * 60000); await a.svc.gateTick();
    assert.strictEqual(a.bdc.requests.length, n, 'a door left open on a parked car: not one request to the body controller');
    // the setting: off = the custom colour stays on an open door's line
    const b = await makeService({ strict: true });
    b.car.condition(5); b.car.factory(1);
    await b.svc.apply(BLUE);
    b.car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await b.svc.ctl.scheduler.drain();
    assert.strictEqual(phys(b.svc, LINE.driverFront)[4], 'oem');
    b.settings.set('doorRelease', 'off');                      // switched off while the door is open
    await tick(); await b.svc.ctl.scheduler.drain();
    assert.deepStrictEqual(phys(b.svc, LINE.driverFront), [0, 0, 254, 100, 'custom'], 'the colour is back on it');
    b.settings.set('doorRelease', 'on');
    await tick(); await b.svc.ctl.scheduler.drain();
    assert.strictEqual(phys(b.svc, LINE.driverFront)[4], 'oem', 'and BMW\'s again');
    // a door open for a long time stays BMW's: nothing is being written to it, so there is nothing to time out
    await b.clock.advance(20 * 60000); await settle(b.svc);
    assert.strictEqual(phys(b.svc, LINE.driverFront)[4], 'oem');
    assert.strictEqual(b.svc.ctl.program.mode, 'solid');
});
test('the factory lighting switched off while a door is open: every module back in two whole-bus releases', async () => {
    const { svc, car, bdc, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    const n = writes(bdc).length;
    car.factory(0); await settle(svc);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0']);
    assert.ok(writes(bdc).slice(n).every(isRelease));
    assert.ok(allOem(svc));
    const m = writes(bdc).length;
    await clock.advance(5000);
    car.doors({});
    await tick(); await clock.advance(5000);
    assert.strictEqual(writes(bdc).length, m, 'and nothing starts again, not even when the door closes');
    assert.ok(allOem(svc));
});
test('a door closing while the car is moving gives its line the colour back', async () => {
    const opts = { strict: true, speed: 0 };
    const { svc, car } = await makeService(opts);
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    car.doors({ statusDoorSwitchPSDR: 1 });
    await tick(); await svc.ctl.scheduler.drain();
    opts.speed = 40; car.condition(10);                        // driving
    assert.strictEqual(svc.ctl.parked(), false);
    // (canControl({ parked: false }): giving a module back its colour is not a lighting change the parked rule blocks)
    assert.strictEqual(svc.ctl.canControl({ parked: false }).ok, true);
    car.doors({});
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(phys(svc, LINE.passengerRear), [0, 0, 254, 100, 'custom']);
});

/* ================= turn indicators: green ================= */
test('indicator decoding: left, right and hazards by name or number; lock, unlock and alarm flashes are not a turn signal', () => {
    assert.strictEqual(CS.turnOf({ activeFunctionIndicateDirection: 7 }), 'left');
    assert.strictEqual(CS.turnOf({ activeFunctionIndicateDirection: 'TIPPBLINKEN_RECHTS' }), 'right');
    assert.strictEqual(CS.turnOf({ activeFunctionIndicateDirection: 'FAS_RICHTUNGSBLINKEN_MIDPRIO_LINKS' }), 'left');
    assert.strictEqual(CS.turnOf({ activeFunctionIndicateDirection: 'WARNBLINKEN_MANUELL' }), 'both');
    assert.strictEqual(CS.turnOf(6), 'both');
    [0, 2, 3, 4, 5, 11, 14, 15, 17, 26, 253, 254, 255, 'BLINKEN_AUS', 'QUITTIERUNGSBLINKEN_SCHAERFEN', 'DWA_BLINKEN', 'ANKUENDIGUNGSBLINKEN_OEFFNEN', 'SIGNAL_UNBEFUELLT', undefined, null].forEach((v) => assert.strictEqual(CS.turnOf(v), null, String(v)));
    // right-hand drive: the left indicator is the passenger's side
    assert.deepStrictEqual(CS.sidesOf('left', 'rhd'), ['passenger']);
    assert.deepStrictEqual(CS.sidesOf('right', 'rhd'), ['driver']);
    assert.deepStrictEqual(CS.sidesOf('left', 'lhd'), ['driver']);
    assert.deepStrictEqual(CS.sidesOf('right', 'lhd'), ['passenger']);
    assert.deepStrictEqual(CS.sidesOf('both', 'rhd'), ['driver', 'passenger']);
    assert.deepStrictEqual(CS.sidesOf(null, 'rhd'), []);
    assert.strictEqual(SPEC.settings.find((s) => s.key === 'drive').default, 'rhd');
});
test('indicator glow (right-hand drive): left = the passenger side\'s door lines green, right = the driver\'s, hazards = both; off when the indicator stops', async () => {
    const { svc, car, clock, bdc } = await makeService({ strict: true, sets: { turnGlow: 'on' } });
    car.condition(10); car.factory(1);
    await svc.apply(BLUE);
    const green = (k) => { const p = phys(svc, k); return p[0] === 0 && p[1] === 230 && p[2] === 60 && p[3] === 100; };
    const blue = (k) => { const p = phys(svc, k); return p[0] === 0 && p[1] === 0 && p[2] === 254; };
    car.turn(7);                                              // DAUERBLINKEN_LINKS
    await tick(); await clock.advance(50);
    assert.ok(green(LINE.passengerFront) && green(LINE.passengerRear), 'left on a right-hand-drive car is the passenger side');
    assert.ok(blue(LINE.driverFront) && blue(LINE.driverRear));
    await clock.advance(400);
    assert.strictEqual(phys(svc, LINE.passengerFront)[3], 0, 'dark between the blinks');
    car.turn(0);
    await tick(); await svc.ctl.scheduler.drain();
    assert.ok(blue(LINE.passengerFront) && blue(LINE.passengerRear), 'back on the applied colour at once');
    car.turn('DAUERBLINKEN_RECHTS');
    await tick(); await clock.advance(50);
    assert.ok(green(LINE.driverFront) && green(LINE.driverRear) && blue(LINE.passengerFront));
    car.turn('WARNBLINKEN_MANUELL');
    await tick(); await clock.advance(820);
    assert.ok(Object.keys(LINE).every((d) => green(LINE[d])), 'hazards: both sides');
    const n = writes(bdc).length;
    car.turn(3);                                              // the locking flash: not a turn signal
    await tick(); await svc.ctl.scheduler.drain();
    assert.ok(Object.keys(LINE).every((d) => blue(LINE[d])));
    assert.ok(writes(bdc).length > n);
});
test('indicator glow: left-hand drive mirrors it; it is off by default, can be switched off again, and works while driving', async () => {
    const lhd = await makeService({ strict: true, sets: { turnGlow: 'on', drive: 'lhd' } });
    lhd.car.condition(10); lhd.car.factory(1);
    lhd.car.turn(7);
    await tick(); await lhd.clock.advance(50);
    assert.deepStrictEqual(phys(lhd.svc, LINE.driverFront).slice(0, 3), [0, 230, 60]);
    assert.strictEqual(phys(lhd.svc, LINE.passengerFront)[4], 'oem');
    const off = await makeService({ strict: true });
    off.car.condition(10); off.car.factory(1);
    off.car.turn(7);
    await tick(); await off.clock.advance(2000);
    assert.strictEqual(writes(off.bdc).length, 0, 'off by default');
    off.settings.set('turnGlow', 'on');
    await tick(); await off.clock.advance(50);
    assert.deepStrictEqual(phys(off.svc, LINE.passengerFront).slice(0, 3), [0, 230, 60]);
    off.settings.set('turnGlow', 'off');                       // switched off again mid-blink
    await tick(); await off.svc.ctl.scheduler.drain();
    assert.strictEqual(phys(off.svc, LINE.passengerFront)[4], 'oem');
    const n = writes(off.bdc).length;
    await off.clock.advance(5000);
    assert.strictEqual(writes(off.bdc).length, n);
});
test('an open door\'s line is BMW\'s even while the indicator blinks: the other line of that side glows; the indicator provider going away stops the glow', async () => {
    const { svc, car, clock, signals, bdc } = await makeService({ strict: true, sets: { turnGlow: 'on' } });
    car.condition(5); car.factory(1);
    car.turn(7); car.doors({ statusDoorSwitchPSD: 1 });
    await tick(); await clock.advance(50);
    assert.strictEqual(phys(svc, LINE.passengerFront)[4], 'oem', 'the open door\'s line is not ours to blink');
    assert.deepStrictEqual(phys(svc, LINE.passengerRear).slice(0, 3), [0, 230, 60]);
    await clock.advance(3000);
    assert.ok(writes(bdc).every((r) => keyOf(r) !== LINE.passengerFront), 'never written');
    car.doors({});
    signals.subs[LIGHT].available = false;                    // no "indicator off" will ever arrive
    await settle(svc);
    assert.strictEqual(phys(svc, LINE.passengerRear)[4], 'oem');
});
/* ================= night ================= */
test('night dimming (off by default): half the brightness at night, full by day, colours untouched; an open door\'s line stays BMW\'s', async () => {
    const { svc, car, settings, clock } = await makeService({ strict: true });
    car.condition(5); car.factory(1);
    await svc.apply(BLUE);
    car.night(2);
    await tick(); await svc.ctl.scheduler.drain();
    assert.strictEqual(phys(svc, '2:1')[3], 100, 'off by default');
    settings.set('nightDim', 'on');
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(phys(svc, '2:1').slice(0, 4), [0, 0, 254, 50]);
    car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await clock.advance(50);
    assert.strictEqual(phys(svc, LINE.driverFront)[4], 'oem');
    car.doors({});
    await tick(); await svc.ctl.scheduler.drain();
    assert.deepStrictEqual(phys(svc, LINE.driverFront).slice(0, 4), [0, 0, 254, 50], 'closed: the dimmed colour');
    car.night(1);
    await tick(); await svc.ctl.scheduler.drain();
    assert.strictEqual(phys(svc, '2:1')[3], 100);
    assert.strictEqual(CS.nightOf({ dayNightChangeOver: 3 }), null);
    assert.strictEqual(CS.nightOf({ dayNightChangeOver: 'NACHT' }), true);
    // the dimmed lighting is kept alive like any other
    car.night(2); await tick(); await clock.advance(25000);
    assert.deepStrictEqual(phys(svc, '1:1').slice(0, 4), [0, 0, 254, 50]);
});

/* ================= command sending ================= */
const sched = (writer, opts) => { const clock = fakeClock(); const s = new WriteScheduler(Object.assign({ writer, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }, opts || {})); return { s, clock }; };
const T = (r) => ({ active: true, r, g: 0, b: 0, brightness: 100, seconds: 10 });
test('a write nobody answers is sent ONCE: not resent by the scheduler, by a repeated set(), or by a frame', async () => {
    const calls = [];
    const { s, clock } = sched(async (slave) => { calls.push(slave.nad); return slave.nad === 2 ? { ok: false, reason: 'timeout' } : { ok: true }; });
    const seen = [];
    s.on('unanswered', (k) => seen.push(k)); s.on('failed', (k) => seen.push('FAILED ' + k));
    s.set('1:1', { bus: 1, nad: 1 }, T(1), 'apply'); s.set('1:2', { bus: 1, nad: 2 }, T(1), 'apply');
    await s.drain();
    assert.deepStrictEqual(calls, [1, 2]);
    assert.deepStrictEqual(seen, ['1:2']);
    assert.strictEqual(s.stats.timeouts, 1);
    assert.strictEqual(s.last.get('1:2').unanswered, true);
    // the same target again, unforced: skipped (it may well have been taken)
    s.set('1:2', { bus: 1, nad: 2 }, T(1), 'apply');
    s.frame([{ key: '1:2', slave: { bus: 1, nad: 2 }, params: T(1) }]);
    await s.drain(); await clock.advance(10000);
    assert.deepStrictEqual(calls, [1, 2], 'never sent again for want of a reply');
    // a NEW target is a new command, not a resend
    s.set('1:2', { bus: 1, nad: 2 }, T(9), 'apply');
    await s.drain();
    assert.deepStrictEqual(calls, [1, 2, 2]);
    assert.ok(PL.plan({ '1:2': T(9) }, [{ bus: 1, nad: 2 }], s.last, { mode: 'individual', params: (t) => t }).length === 0, 'the planner does not count it as due either');
});
test('busy retries are configurable, zero included; a busy that runs out is a reported failure, not an endless loop', async () => {
    for (const [max, calls] of [[0, 1], [1, 2], [3, 4]]) {
        let n = 0;
        const { s, clock } = sched(async () => { n++; return { ok: false, nrc: 0x21 }; }, { maxBusyRetries: max, busyBackoffMs: 100 });
        const failed = [];
        s.on('failed', (k, p, r) => failed.push(r.nrc));
        s.set('1:1', { bus: 1, nad: 1 }, T(1), 'apply');
        await clock.advance(5000); await s.drain();
        assert.strictEqual(n, calls, 'maxBusyRetries ' + max);
        assert.deepStrictEqual(failed, [0x21]);
        assert.strictEqual(s.status().maxBusyRetries, max);
    }
    // the transport turning a request away before sending it counts as busy too
    let n = 0;
    const { s, clock } = sched(async () => { n++; return n < 3 ? { ok: false, busy: true, reason: 'transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' } : { ok: true }; }, { maxBusyRetries: 3, busyBackoffMs: 10 });
    s.set('1:1', { bus: 1, nad: 1 }, T(1), 'apply');
    await clock.advance(1000); await s.drain();
    assert.strictEqual(n, 3);
    assert.strictEqual(s.last.get('1:1').ok, true);
    assert.strictEqual(SPEC.settings.find((x) => x.key === 'busyRetries').steps[0], 0);
});
test('one command has a maximum duration: a write that never returns is given up (unanswered), and the queue goes on', async () => {
    const calls = [];
    const { s, clock } = sched((slave) => { calls.push(slave.nad); return slave.nad === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true }); }, { maxCommandMs: 2000 });
    s.set('1:1', { bus: 1, nad: 1 }, T(1), 'apply'); s.set('1:2', { bus: 1, nad: 2 }, T(1), 'apply');
    await clock.advance(1900);
    assert.deepStrictEqual(calls, [1], 'one in flight: the second waits');
    await clock.advance(200); await s.drain();
    assert.deepStrictEqual(calls, [1, 2]);
    assert.strictEqual(s.last.get('1:1').unanswered, true);
    assert.strictEqual(s.inFlight.size, 0);
});
test('the controller: an unanswered write is reported, not resent; the module is written again only when its keep-alive is due', async () => {
    const clock = fakeClock(), bdc = new MockBdc({ now: clock.now });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient' });
    c._canVerify = () => false;                                // no read-back: nothing may be assumed either way
    await c.connect();
    bdc.dropNext = 1;                                          // the first write gets no reply
    const r = await c.apply(BLUE);
    assert.deepStrictEqual([r.ok, r.written, r.unanswered, r.failed], [true, 18, 1, 0]);
    const first = keyOf(writes(bdc)[0]);
    const count = () => writes(bdc).filter((x) => keyOf(x) === first).length;
    assert.strictEqual(count(), 1);
    await clock.advance(2400);                                 // before the keep-alive is due
    assert.strictEqual(count(), 1, 'not sent again for want of a reply');
    assert.strictEqual(c.stats.unanswered, 1);
    assert.ok(c.driven.has(first), 'it may show the colour: a restore releases it');
    await clock.advance(6000);                                 // the keep-alive: due for every module alike
    assert.strictEqual(count(), 2);
    assert.strictEqual(writes(bdc).length, 38);
});
test('with a read-back the missing reply is settled by evidence: a module that shows the colour is left alone', async () => {
    const clock = fakeClock(), bdc = new MockBdc({ now: clock.now });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient' });
    await c.connect();
    // the reply is lost AFTER the module took the write
    const real = c._writeSlave.bind(c);
    let lose = 1;
    c._writeSlave = async (slave, params) => { const r = await real(slave, params); return lose-- > 0 ? { ok: false, reason: 'timeout' } : r; };
    let check = null;
    c.on('verified', (v) => { check = v; });
    const r = await c.apply(BLUE);
    assert.deepStrictEqual([r.ok, r.unanswered, r.verifying], [true, 1, true], 'an unanswered write arms the read-back (single writes, setting off)');
    assert.strictEqual(check, null, 'Apply did not wait for it');
    await clock.advance(1600);
    assert.deepStrictEqual([check.confirmed, check.missed], [19, 0]);
    assert.strictEqual(writes(bdc).length, 19, 'the read-back showed it took: no second write');
});
test('a whole-bus write without a reply: not repeated as 12 single writes, whole-bus mode stays on; a REFUSED one falls back', async () => {
    const clock = fakeClock(), bdc = new MockBdc({ now: clock.now });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient', txMode: 'broadcast' });
    c._canVerify = () => false;
    await c.connect();
    const real = c._writeSlave.bind(c);
    c._writeSlave = async (slave, params) => { const r = await real(slave, params); return slave.bus === 2 && slave.nad === 0 ? { ok: false, reason: 'timeout' } : r; };
    const r = await c.apply({ mode: 'rainbow' });
    assert.deepStrictEqual([r.ok, r.written, r.unanswered], [true, 7, 12]);
    assert.strictEqual(writes(bdc).length, 2, 'two whole-bus writes and nothing more');
    assert.strictEqual(c.broadcastOk, true);
    assert.strictEqual(c.driven.size, 19);
    c._stopTicker();
});
test('three writes in a row without a reply: custom control stops and says so (the lights lapse by themselves)', async () => {
    const clock = fakeClock(), bdc = new MockBdc({ now: clock.now });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient' });
    await c.connect();
    await c.apply(BLUE);
    const why = [];
    c.on('failure', (w) => why.push(w));
    bdc.offline = true; c._available = () => true;             // the link looks up, the body controller says nothing
    const n = bdc.requests.length;
    await clock.advance(20000);
    assert.strictEqual(c.program, null);
    assert.ok(/not answering.*none was sent again/.test(why[0]), why[0]);
    assert.strictEqual(bdc.requests.length - n, 3, 'three writes, each sent once');
    await clock.advance(60000);
    assert.strictEqual(bdc.requests.length - n, 3, 'and then silence');
    assert.strictEqual(clock.pending(), 0);
});
test('a still colour is targeted and never whole-bus; an animation in a zone never uses NAD 0 on a bus with a module left to BMW; the read-back (setting on) repairs a miss', async () => {
    const clock = fakeClock(), bdc = new MockBdc({ now: clock.now });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient', txMode: 'broadcast', verify: true });
    await c.connect();
    const checks = [];
    c.on('verified', (v) => checks.push([v.confirmed, v.missed]));
    // one module does not take its write although the body controller says yes (what a read-back is for)
    const real = c._writeSlave.bind(c);
    let drop = true;
    c._writeSlave = async (slave, params) => { if (drop && slave.bus === 1 && slave.nad === 1) { drop = false; return { ok: true }; } return real(slave, params); };
    const r = await c.apply(BLUE);
    assert.strictEqual(writes(bdc).length, 18, 'one write per module (the dropped one never reached the car)');
    assert.ok(writes(bdc).every((x) => x.data[2] !== 0), 'none to NAD 0');
    assert.strictEqual(r.verifying, true, 'the setting asks for the read-back');
    await clock.advance(1600);
    assert.deepStrictEqual(checks[0], [18, 1]);
    assert.deepStrictEqual(writes(bdc).slice(18).map(keyOf), ['1:1'], 'the read-back found the one that missed it: one single write');
    assert.deepStrictEqual(Array.from(c.deaf), [], 'a missed targeted write says nothing about NAD 0');
    await c.restoreOem();
    const n = writes(bdc).length;
    await c.apply({ mode: 'rainbow', zone: 'footwells' });      // footwells only: the rest stays BMW's
    await clock.advance(4000);
    assert.ok(writes(bdc).length > n);
    assert.ok(writes(bdc).slice(n).every((x) => x.data[2] !== 0), 'no NAD 0 while BMW keeps modules on those buses');
    assert.strictEqual(c.physicalColour('2:1').source, 'oem');
    await c.restoreOem();
});
test('the real transport path: one request in flight, the kit\'s own busy retries switched off, a refused transport reported as busy', async () => {
    const mock = new MockBdc({});
    const b = bus(JS, mock, {});
    const seen = [];
    const realPhysical = b.diag.physical.bind(b.diag);
    let inFlight = 0, most = 0;
    b.diag.physical = async function (target, sid, data, timeoutMs, accept, opts) { seen.push(opts); inFlight++; most = Math.max(most, inFlight); try { return await realPhysical(target, sid, data, timeoutMs, accept, opts); } finally { inFlight--; } };
    const c = new BdcUdsLightingController({ diag: b.diag, diagModule: b.diagModule, armed: true, parkedPolicy: 'lenient', refreshSeconds: 10 });
    await c.init(); await c.connect();
    const r = await c.apply(BLUE);
    assert.strictEqual(r.written, 19);
    assert.strictEqual(most, 1, 'never two requests at once');
    assert.strictEqual(c.scheduler.maxInFlight, 1);
    assert.ok(seen.every((o) => o && o.maxRetries === 0 && o.hardTimeoutMs > 0), 'no hidden retries, a hard limit on every request');
    assert.ok(seen.filter((o) => o.hardTimeoutMs === 5000).length >= 19);
    await c.restoreOem();
    // the gateway turns the request away: busy, to be retried by the scheduler's count only
    b.diag.physical = async () => { throw new Error('transport refused: APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'); };
    const w = await c._writeSlave({ bus: 1, nad: 1 }, T(1));
    assert.deepStrictEqual([w.ok, w.busy], [false, true]);
    await c.shutdown();
});

/* ================= the screen ================= */
test('the Driving page: the door handback, indicator glow and night dimming each have a switch that turns them on and off again', async () => {
    const h = await harness({});
    h.app.setPage(5);
    await h.frame();
    for (const [key, setting, first] of [['fx:door', 'doorRelease', 'on'], ['fx:turn', 'turnGlow', 'off'], ['fx:night', 'nightDim', 'off']]) {
        const other = first === 'on' ? 'off' : 'on';
        assert.strictEqual(h.settings.get(setting), first);
        await h.press(key); await h.frame();
        assert.strictEqual(h.settings.get(setting), other, setting);
        await h.press(key); await h.frame();
        assert.strictEqual(h.settings.get(setting), first, setting + ' can be switched back');
    }
    const label = (k) => SPEC.settings.find((s) => s.key === k).label;
    assert.strictEqual(label('doorRelease'), 'Open door');
    await h.app.svc.stop();
});
test('every page draws, every mode is reachable, and no two controls of a page overlap', async () => {
    const h = await harness({});
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // with something applied and something saved, so that every button of every page is live
    assert.ok((await h.app.svc.apply(BLUE)).ok);
    h.app.favs.add('#FE0000'); h.app.favs.add('#00FE00'); h.app.favs.addPreset('Test preset', RAINBOW); h.app.favs.addPreset('Second', BLUE);
    h.app.draft.colours.hsv = { h: 10, s: 1, v: 1 }; h.app.dirty().colours = true; h.app.dirty().dual = true; h.app.dirty().modes = true;
    for (let page = 0; page < 6; page++) {
        h.app.setPage(page);
        await h.frame();
        const ts = h.targets().filter((t) => t.w > 0 && t.h > 0);
        assert.ok(ts.length >= 2, 'page ' + page + ' has controls: ' + ts.length);
        ts.forEach((t) => assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= 1600 && t.y + t.h <= 520, 'page ' + page + ' ' + t.key + ' is on the screen: ' + [t.x, t.y, t.w, t.h]));
        for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
            // (a row and the button drawn on it are one control: same row, the button inside)
            const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
            if (overlap(ts[i], ts[j]) && !inside(ts[i], ts[j]) && !inside(ts[j], ts[i])) assert.fail('page ' + page + ': ' + ts[i].key + ' overlaps ' + ts[j].key);
        }
    }
    h.app.setPage(2);
    await h.frame();
    ['solid', 'dual', 'rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse'].forEach((m) => assert.ok(h.targets().some((t) => t.key === 'mode:' + m), m + ' is a knob target'));
    for (const m of ['rainbow', 'fade', 'breathing', 'wave']) { await h.press('mode:' + m); await h.frame(); assert.ok(h.targets().some((t) => t.key === 'p:speed'), m + ' has its speed step'); }
    await h.app.svc.stop();
});

module.exports = run('v050');

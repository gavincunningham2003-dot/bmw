'use strict';
/* 0.5.1: the animations are the MGU App Kit Ambient Config's own (its scenes.js unchanged, called through
 * lighting_scene.render), the update method is its lights.js's (whole-bus writes, frame by frame, nothing queued,
 * read-back in the background), an open door's line goes back to BMW, and a full handback is two whole-bus
 * releases. Everything here runs on the simulated body controller; nothing touches a car. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS, STAGE, APP } = require('../../scripts/stage');
const { MockLightingController, MockBdc, G20_SLAVES } = require(path.join(JS, 'lighting_mock'));
const { LightingService } = require(path.join(JS, 'lighting_service'));
const S = require(path.join(JS, 'lighting_scene'));
const PL = require(path.join(JS, 'lighting_plan'));
const P = require(path.join(JS, 'lighting_protocol'));
const NOTICE = require(path.join(JS, 'ambient_config_notice'));
// the reference, loaded directly: nothing of this project between the test and its lightAt()
const AC = require(path.join(JS, 'ambient_config_scenes'));
const LIN = require(path.join(JS, 'ambient_config_lin'));
const { harness } = require('./ui_harness');

const SPEC = JSON.parse(fs.readFileSync(path.join(STAGE, 'app.json'), 'utf8'));
const COND = 'de.bmw.infrastructure.VehicleCondition', COMFORT = 'de.bmw.infotainment.misc.ComfortFunctionIuK', DOORS = 'de.bmw.body.DoorsWindowsRoofMirrors';
const MODULES = G20_SLAVES.bus1.map((loc, i) => ({ bus: 1, nad: i + 1, locationId: loc })).concat(G20_SLAVES.bus2.map((loc, i) => ({ bus: 2, nad: i + 1, locationId: loc })));
// Ambient Config's own picture of a G20 (lin.js sample()): its buses are 0 and 1, ours 1 and 2
const REF_LIGHTS = LIN.sample();
const refLight = (m) => REF_LIGHTS.find((l) => l.bus === m.bus - 1 && l.nad === m.nad);
const UPPER = { rgb: [200, 10, 40], bright: 70 }, LOWER = { rgb: [5, 90, 250], bright: 30 };
const TOP = { colour: { r: 200, g: 10, b: 40 }, brightness: 70 }, BOTTOM = { colour: { r: 5, g: 90, b: 250 }, brightness: 30 };
const program = (mode, speed) => ({ mode, top: TOP, bottom: BOTTOM, speed: speed || 2 });
const refScene = (kind, speed) => ({ kind, upper: UPPER, lower: LOWER, speed: speed || 2 });
const DUAL = { mode: 'dual', top: TOP, bottom: BOTTOM, handlesTo: 'bottom' };
const BLUE = { mode: 'solid', colour: { r: 0, g: 0, b: 254 }, brightness: 100, zone: 'all' };
const cap = (v) => Math.min(254, v);
const LINE = { passengerFront: '1:3', passengerRear: '1:6', driverFront: '2:8', driverRear: '2:11' };

const writes = (bdc) => bdc.requests.filter((r) => r.sid === 0x2E);
const reads = (bdc) => bdc.requests.filter((r) => r.sid === 0x22);
const keyOf = (r) => (r.data[0] === 0xDA ? 1 : 2) + ':' + r.data[2];
const isRelease = (r) => r.data[3] === 0 && r.data.slice(4).every((b) => b === 0);
const phys = (c, key) => { const p = c.physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
function make(mock, opts) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient', txMode: 'broadcast' }, opts || {}));
    return { c, bdc, clock };
}
/** Every write the controller hands to its transport, with the moment it was handed over. */
function tap(c, clock) {
    const log = [], real = c._writeSlave.bind(c);
    c._writeSlave = async (slave, params) => {
        const e = { t: clock.now(), key: slave.bus + ':' + slave.nad, slave, params, bytes: P.encodeLayeringWrite({ bus: slave.bus, nad: slave.nad, active: params.active, brightness: params.brightness, r: params.r, g: params.g, b: params.b, seconds: params.seconds }), done: null };
        log.push(e);
        const r = await real(slave, params);
        e.done = clock.now();
        return r;
    };
    return log;
}
/** Writes grouped into frames: writes handed over while the same frame was being written (no gap between one's end and the next's start). */
function framesOf(log) {
    const frames = [];
    log.forEach((e) => { const f = frames[frames.length - 1]; if (f && f[f.length - 1].done === e.t && f.length < 40 && e.frame !== false) f.push(e); else frames.push([e]); });
    return frames;
}
function fakeSettings(sets) {
    const values = {};
    SPEC.settings.forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, sets || {});
    const handlers = [];
    return { get: (k) => values[k], set(k, v) { values[k] = v; handlers.forEach((fn) => fn(k)); }, onChange: (fn) => handlers.push(fn), values };
}
async function makeService(opts) {
    const o = opts || {};
    const clock = fakeClock();
    const settings = fakeSettings(o.sets), H = {}, subs = {};
    const signals = { H, subs, watch: async (iface, inst, handlers) => { H[iface] = handlers; subs[iface] = { iface, available: true, error: null, shutdown: async () => {} }; return subs[iface]; } };
    const bdc = new MockBdc(Object.assign({ now: clock.now }, o.mock || {}));
    const svc = new LightingService({
        settings, signals, log: null, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-051-')),
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => ({ fake: true }), clearInterval() {},
        strict: true, comfortSock: path.join(os.tmpdir(), 'no-such-comfort.sock'),
        parkedWatch: () => ({ speed: () => 0, moving: () => false }),
        controller: (common) => new MockLightingController(Object.assign({}, common, { bdc }, o.ctl || {})),
    });
    await svc.start();
    for (let i = 0; i < 6; i++) await tick();
    const car = {
        condition: (n) => H[COND].VehicleCondition({ statusConditionVehicle: n }),
        factory: (mode) => H[COMFORT].statusAmbientLightInteriorColour({ statusHueInteriorLighting: 100, statusMenuAmbientePanoramicRoofInteriorLighting: 4, statusModeAmbientePanoramicRoofInteriorLighting: mode }),
        doors: (v) => H[DOORS].CentralLockingSystemAndPanelStatus(Object.assign({ statusDoorSwitchDRD: 0, statusDoorSwitchPSD: 0, statusDoorSwitchDRDR: 0, statusDoorSwitchPSDR: 0 }, v)),
    };
    car.condition(5); car.factory(1);                         // someone in the car, factory ambient lighting on
    return { svc, clock, settings, bdc, car };
}
const settle = async (svc) => { await tick(); await svc.gateTick(); await svc.ctl.scheduler.drain(); await tick(); };
const allOem = (svc) => svc.ctl.slaves.every((s) => svc.ctl.physicalColour(S.key(s)).source === 'oem');

/* ================= 1. the original files, unchanged ================= */
test('ambient_config_scenes.js and ambient_config_lin.js are the reference\'s files byte for byte; the MIT notice travels with them', () => {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    Object.keys(NOTICE.FILES).forEach((name) => {
        assert.strictEqual(sha(path.join(APP, name)), NOTICE.FILES[name].sha256, name + ' was edited: it must stay the reference\'s file (copy it again and update the notice instead)');
        assert.strictEqual(sha(path.join(JS, name)), NOTICE.FILES[name].sha256, name + ' as staged for the package');
    });
    assert.deepStrictEqual(Object.keys(NOTICE.FILES).sort(), ['ambient_config_lin.js', 'ambient_config_scenes.js']);
    assert.ok(/^[0-9a-f]{40}$/.test(NOTICE.COMMIT) && /cauliflowermossgrape\/idrive7-apps/.test(NOTICE.SOURCE));
    const text = fs.readFileSync(path.join(JS, 'ambient_config_notice.js'), 'utf8');
    assert.ok(/MIT License/.test(text) && /Copyright \(c\) 2026 cauliflowermossgrape/.test(text) && /The above copyright notice and this permission notice shall be included/.test(text), 'the licence text is in the package');
    // the files are used as they are: no copy of their maths is left in this project's renderer
    const scene = fs.readFileSync(path.join(JS, 'lighting_scene.js'), 'utf8');
    assert.ok(/AC\.lightAt\(/.test(scene));
    assert.ok(!/Math\.(sin|cos)\(/.test(scene), 'no trigonometry of its own in lighting_scene.js');
});
test('this car\'s modules are the lights Ambient Config knows for a G20: same buses (0, 1 -> 1, 2), same addresses, same places', () => {
    assert.strictEqual(REF_LIGHTS.length, 19);
    MODULES.forEach((m) => {
        const l = refLight(m);
        assert.ok(l, 'bus ' + m.bus + ' NAD ' + m.nad);
        assert.strictEqual(l.loc, m.locationId, S.key(m) + ': the same installation location');
        assert.deepStrictEqual(S.lightOf(m, 'bottom'), { part: l.part, y: l.y, bus: l.bus }, S.key(m) + ' (' + l.name + '): the light handed to lightAt()');
    });
    // right-hand drive: nothing to mirror. The lights are the car's "driver" and "passenger" ones by location, and
    // lightAt() reads only part, y (front to rear) and bus, never a left or a right
    assert.ok(MODULES.filter((m) => m.bus === 1).every((m) => /passenger/i.test(refLight(m).name)), 'bus 1 is the passenger side: where the wave starts');
    assert.ok(MODULES.filter((m) => m.bus === 2).every((m) => /driver|dash|passenger front$/i.test(refLight(m).name)));
    assert.strictEqual(SPEC.settings.find((s) => s.key === 'drive').default, 'rhd');
});

/* ================= 2. the animations ARE the reference's ================= */
const TIMES = [0, 1, 40, 137, 499, 500, 999, 1000, 1499, 1500, 1501, 1999, 2000, 2599, 2600, 3000, 4000, 4096, 5000, 6600, 8000, 12000, 19200, 25013, 61234, 600000, 3599999];
for (let t = 0; t < 26000; t += 173) TIMES.push(t);
test('Rainbow, Breathing, Smooth Fade and Colour Wave: every module at every moment is scenes.lightAt(), at Slow, Normal and Fast', () => {
    let n = 0;
    for (const mode of ['rainbow', 'breathing', 'fade', 'wave']) for (const speed of [1, 2, 3]) for (const t of TIMES) {
        const sc = S.render(program(mode, speed), MODULES, 5000 + t, { phase0: 5000 });
        assert.strictEqual(Object.keys(sc).length, 19);
        MODULES.forEach((m) => {
            const want = AC.lightAt(refScene(mode, speed), refLight(m), t), got = sc[S.key(m)];
            assert.deepStrictEqual([got.r, got.g, got.b, got.brightness], [want.rgb[0], want.rgb[1], want.rgb[2], want.bright], mode + ' speed ' + speed + ' t ' + t + ' ' + S.key(m));
            n++;
        });
    }
    assert.ok(n > 30000, n + ' comparisons');
});
test('the three speeds are the reference\'s: Slow is the same picture at 1.6 x the time, Fast at 0.55 x; the periods are 12, 8, 4 and 5 s', () => {
    assert.deepStrictEqual(S.SPEED_LABELS, { 1: 'Slow', 2: 'Normal', 3: 'Fast' });
    for (const mode of ['rainbow', 'breathing', 'fade', 'wave']) {
        const period = { rainbow: 12000, fade: 8000, breathing: 4000, wave: 5000 }[mode];
        const at = (speed, t) => S.render(program(mode, speed), MODULES, t);
        [0.1, 0.25, 0.5, 0.8].forEach((f) => {
            assert.deepStrictEqual(at(1, period * 1.6 * f), at(2, period * f), mode + ' slow');
            assert.deepStrictEqual(at(3, period * 0.55 * f), at(2, period * f), mode + ' fast');
        });
        assert.deepStrictEqual(at(2, period), at(2, 0), mode + ': once round in ' + period + ' ms');
        assert.notDeepStrictEqual(at(2, period / 2), at(2, 0), mode + ': and not before');
    }
});
test('Welcome Sweep and Sport Pulse: scenes.lightAt() over the lighting they end on, 2.6 s and 2 s, whatever the speed step', () => {
    assert.strictEqual(S.onceMs({ mode: 'welcome' }), AC.lasts({ kind: 'welcome' }));
    assert.strictEqual(S.onceMs({ mode: 'pulse' }), AC.lasts({ kind: 'pulse' }));
    assert.deepStrictEqual([S.onceMs({ mode: 'welcome' }), S.onceMs({ mode: 'pulse' })], [2600, 2000]);
    for (const kind of ['welcome', 'pulse']) for (const then of [DUAL, program('breathing', 3), program('rainbow', 1)]) for (const t of TIMES.filter((x) => x <= 3000)) {
        // (as Ambient Config's control.js makes them: the look with its kind replaced, so the look's two colours)
        const sc = S.render({ mode: kind, then }, MODULES, t);
        MODULES.forEach((m) => {
            const want = AC.lightAt(refScene(kind), refLight(m), t), got = sc[S.key(m)];
            assert.deepStrictEqual([got.r, got.g, got.b, got.brightness], [want.rgb[0], want.rgb[1], want.rgb[2], want.bright], kind + ' over ' + then.mode + ' t ' + t + ' ' + S.key(m));
        });
    }
    // the sweep: the dash before the doors before the rear; the pulse: red for 1.5 s on every light
    const w = S.render({ mode: 'welcome', then: DUAL }, MODULES, 1300);
    assert.ok(w['2:1'].brightness === 70 && w['1:2'].brightness > 0 && w['1:2'].brightness < 30 && w['1:6'].brightness === 0, 'half way: the dash full, a front door handle coming up, the rear door line still dark: ' + JSON.stringify([w['2:1'], w['1:2'], w['1:6']]));
    assert.ok(MODULES.every((m) => { const x = S.render({ mode: 'pulse', then: DUAL }, MODULES, 1499)[S.key(m)]; return x.r === 255 && x.g === 0 && x.b === 0 && x.brightness === 100; }));
    assert.deepStrictEqual(S.render({ mode: 'pulse', then: DUAL }, MODULES, 1500), S.render(DUAL, MODULES, 0));
    // a module the follow-on leaves to the car stays the car's
    const foot = S.render({ mode: 'welcome', then: { mode: 'solid', colour: { r: 1, g: 2, b: 3 }, brightness: 50, zone: 'footwells' } }, MODULES, 2600);
    assert.strictEqual(Object.keys(foot).length, 4);
});
test('on the wire: every frame the controller sends is lightAt() at the moment the frame was made, in the reference\'s own LIN bytes', async () => {
    for (const mode of ['rainbow', 'wave', 'fade', 'breathing']) for (const speed of [1, 2, 3]) {
        const { c, clock } = make();
        await c.connect();
        const log = tap(c, clock);
        assert.ok((await c.apply(program(mode, speed))).ok);
        await clock.advance(2500);
        const frame = log.filter((e) => e.params.active);
        assert.ok(frame.length > 20, mode + ': ' + frame.length + ' writes');
        frame.forEach((e) => {
            const t = e.t - c.phase0;
            // a whole-bus write carries the colour most lights of the bus want: any light of that bus that wants it
            const mods = e.slave.nad === 0 ? MODULES.filter((m) => m.bus === e.slave.bus) : MODULES.filter((m) => S.key(m) === e.key);
            const wants = mods.map((m) => AC.lightAt(refScene(mode, speed), refLight(m), t));
            const mine = wants.find((v) => cap(v.rgb[0]) === e.bytes[5] && cap(v.rgb[1]) === e.bytes[6] && cap(v.rgb[2]) === e.bytes[7] && v.bright === e.bytes[4]);
            assert.ok(mine, mode + ' speed ' + speed + ' at ' + t + ' ms, ' + e.key + ': ' + e.bytes.slice(4, 8) + ' is not what lightAt() says (' + JSON.stringify(wants[0]) + ')');
            // and the bytes are exactly lin.js's writeFrame() for that colour (its bus 0 / 1, the 5 s hold of a moving scene)
            assert.deepStrictEqual(e.bytes, LIN.writeFrame(e.slave.bus - 1, e.slave.nad, mine.rgb, mine.bright, 5), mode + ' ' + e.key);
        });
        await c.restoreOem();
    }
});

/* ================= 3. whole-bus updates and the lights that differ ================= */
test('Rainbow, Fade and Wave are TWO writes a frame (one NAD 0 write a bus); the wave\'s two buses carry different colours', async () => {
    for (const mode of ['rainbow', 'fade', 'wave']) {
        const { c, clock, bdc } = make();
        await c.connect();
        await c.apply(program(mode));
        const n = writes(bdc).length;
        await clock.advance(2000);
        const w = writes(bdc).slice(n);
        assert.ok(w.length >= 40, mode + ': ' + w.length + ' writes in 2 s');
        assert.ok(w.every((r) => r.data[2] === 0), mode + ': every write is a whole-bus write');
        assert.deepStrictEqual(Array.from(new Set(w.map(keyOf))).sort(), ['1:0', '2:0']);
        assert.ok(Math.abs(w.filter((r) => keyOf(r) === '1:0').length - w.filter((r) => keyOf(r) === '2:0').length) <= 1, mode + ': bus 1, bus 2, bus 1, bus 2');
        if (mode === 'wave') assert.notDeepStrictEqual(w[w.length - 2].data.slice(5, 8), w[w.length - 1].data.slice(5, 8), 'the band is a quarter of a wave apart on the two buses');
        assert.strictEqual(c.stats.broadcasts, writes(bdc).length);
        await c.restoreOem();
    }
});
test('Breathing and a still dual colour: the majority colour to the whole bus, then single writes only for the lights that differ', async () => {
    // bus 1: 5 lower lights, 2 upper (the two door lines); bus 2: 7 lower, 5 upper (3 dash lines, 2 door lines)
    const { c, clock, bdc } = make();
    await c.connect();
    const r = await c.apply(DUAL);
    assert.strictEqual(r.written, 19);
    assert.deepStrictEqual(writes(bdc).map(keyOf), ['1:0', '1:3', '1:6', '2:0', '2:1', '2:2', '2:3', '2:8', '2:11'], '9 writes instead of 19: the bus, then its upper lights front to back');
    assert.deepStrictEqual(writes(bdc)[0].data.slice(4, 8), [30, 5, 90, 250], 'the whole bus gets the lower colour (most of its lights)');
    assert.deepStrictEqual(writes(bdc)[1].data.slice(4, 8), [70, 200, 10, 40], 'the exceptions get the upper one');
    MODULES.forEach((m) => { const up = S.groupOf(m, 'bottom') === 'top'; assert.deepStrictEqual(phys(c, S.key(m)).slice(0, 4), up ? [200, 10, 40, 70] : [5, 90, 250, 30], S.key(m)); });
    // one module's colour changes: one write, not the bus
    const n = writes(bdc).length;
    await c.apply({ mode: 'zones', handlesTo: 'bottom', assignments: [{ zone: 'lower', colour: BOTTOM.colour, brightness: 30 }, { zone: 'upper', colour: TOP.colour, brightness: 70 }, { zone: 'module:2:4', colour: { r: 9, g: 9, b: 9 }, brightness: 10 }] });
    assert.deepStrictEqual(PL.plan(c.scene, c.slaves, c.scheduler.last, { mode: 'broadcast', params: (t) => c._params(t) }), [], 'nothing left to write');
    assert.ok(writes(bdc).slice(n).some((x) => keyOf(x) === '2:4' && x.data[4] === 10));
    await c.restoreOem();
    // breathing: the same shape every frame
    const b = make();
    await b.c.connect();
    await b.c.apply(program('breathing'));
    const k = writes(b.bdc).length;
    await b.clock.advance(1000);
    const per = {};
    writes(b.bdc).slice(k).forEach((x) => { per[keyOf(x)] = (per[keyOf(x)] || 0) + 1; });
    assert.deepStrictEqual(Object.keys(per).sort(), ['1:0', '1:3', '1:6', '2:0', '2:1', '2:11', '2:2', '2:3', '2:8']);
    await b.c.restoreOem();
});
test('single writes (the setting "One per module") show exactly the same colours; they just take 19 writes a frame', async () => {
    const a = make({}, { txMode: 'individual' }), b = make();
    await a.c.connect(); await b.c.connect();
    await a.c.apply(program('wave')); await b.c.apply(program('wave'));
    await a.clock.advance(1000); await b.clock.advance(1000);
    MODULES.forEach((m) => assert.deepStrictEqual(phys(a.c, S.key(m)), phys(b.c, S.key(m)), S.key(m)));
    assert.ok(writes(a.bdc).every((r) => r.data[2] !== 0));
    assert.ok(writes(a.bdc).length > 5 * writes(b.bdc).length);
    await a.c.restoreOem(); await b.c.restoreOem();
});

/* ================= 4. frame by frame: nothing queued, nothing obsolete ================= */
test('a slow link (200 ms a write): each frame is written out before the next is made, from the time it is THEN; no frame is queued or dropped', async () => {
    const { c, clock } = make({}, { latencyMs: 200 });
    await c.connect();
    const log = tap(c, clock);
    const ap = c.apply(program('rainbow', 3));
    await clock.advance(1000);
    await ap;
    let deepest = 0;
    const real = c.scheduler._pump.bind(c.scheduler);
    c.scheduler._pump = () => { deepest = Math.max(deepest, c.scheduler.queue.size + c.scheduler.inFlight.size); return real(); };
    const first = log.length;
    await clock.advance(6000);
    const w = log.slice(first).filter((e) => e.done !== null);
    assert.ok(w.length >= 26 && w.length <= 30, w.length + ' writes in 6 s at 200 ms each: the link is used fully, one write at a time');
    // never two in flight, never more than one frame (2 writes) waiting
    for (let i = 1; i < w.length; i++) assert.ok(w[i].t >= w[i - 1].done, 'write ' + i + ' was handed over only when the one before had its reply');
    assert.ok(deepest <= 2, 'at most one frame in the scheduler: ' + deepest);
    // every frame: both buses the same colour, and that colour is lightAt() at the moment the frame was MADE (its first
    // write), not the colour of some earlier moment that waited in a queue
    for (let i = 0; i + 1 < w.length; i += 2) {
        const made = w[i].t, want = AC.lightAt(refScene('rainbow', 3), refLight(MODULES[0]), made - c.phase0);
        assert.deepStrictEqual([w[i].key, w[i + 1].key], ['1:0', '2:0']);
        assert.deepStrictEqual(w[i].bytes.slice(5, 8), want.rgb.map(cap), 'frame at ' + (made - c.phase0) + ' ms');
        assert.deepStrictEqual(w[i + 1].bytes.slice(5, 8), want.rgb.map(cap), 'both buses show the same moment');
        if (i >= 2) assert.strictEqual(made, w[i - 1].done, 'the next frame is made the moment the last one is out');
    }
    assert.strictEqual(c.scheduler.stats.dropped, 0, 'nothing was ever dropped: nothing was ever queued ahead');
    assert.strictEqual(c.stats.framesDropped, 0);
    assert.ok(c.fps() > 2 && c.fps() <= 2.7, 'about 2.5 whole frames a second: ' + c.fps());
    await clock.advance(0);
    const rp = c.restoreOem(); await clock.advance(1000); await rp;
});
test('a moving scene holds 5 s and is renewed after 3 (the reference\'s figures); a still one keeps the driver\'s setting', async () => {
    const { c, clock, bdc } = make();
    await c.connect();
    // a breathing whose two groups are at a brightness that does not change is rewritten only for its renewal
    await c.apply({ mode: 'fade', top: TOP, bottom: TOP, speed: 2 });          // upper = lower: nothing changes frame to frame
    const n = writes(bdc).length;
    assert.strictEqual(writes(bdc)[0].data[8], 5, 'ZEIT 5 s');
    await clock.advance(2900);
    assert.strictEqual(writes(bdc).length, n, 'no write while the colour is the same and younger than 3 s');
    assert.ok(c.stats.frames > 50, 'frames were looked at all the while: ' + c.stats.frames);
    assert.strictEqual(c.stats.framesWritten, 0);
    await clock.advance(300);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0'], 'renewed after 3 s: two writes');
    assert.strictEqual(phys(c, '2:1')[4], 'custom');
    await clock.advance(20000);
    assert.ok(MODULES.every((m) => phys(c, S.key(m))[4] === 'custom'), 'never lapsed');
    await c.apply(BLUE);
    assert.strictEqual(writes(bdc)[writes(bdc).length - 1].data[8], 10);
    await c.restoreOem();
});
test('Apply never waits for the read-back: it answers when the writes are out; the check runs 1.5 s later and a new Apply cancels it', async () => {
    const { c, clock, bdc } = make();
    await c.connect();
    const before = reads(bdc).length;
    const checks = [];
    c.on('verified', (v) => checks.push(v));
    const r = await c.apply(BLUE);                              // no clock advance: nothing it awaits needs time
    assert.deepStrictEqual([r.ok, r.written, r.verifying], [true, 19, true]);
    assert.strictEqual(reads(bdc).length, before, 'no status read during Apply');
    await clock.advance(1000);
    await c.apply(DUAL);                                        // the driver changes his mind before the check
    await clock.advance(1000);
    assert.strictEqual(checks.length, 0, 'the first check was dropped with its Apply');
    await clock.advance(600);
    assert.strictEqual(checks.length, 1);
    assert.deepStrictEqual([checks[0].confirmed, checks[0].missed], [19, 0]);
    assert.strictEqual(reads(bdc).length, before + 2, 'one read of each bus');
    // an animation is never read back (lights.js: only a still colour)
    await c.apply(program('rainbow'));
    await clock.advance(5000);
    assert.strictEqual(reads(bdc).length, before + 2);
    await c.restoreOem();
});
test('writes wait while a read-back has the link, and go out after it (the gateway takes one request at a time)', async () => {
    const { c, clock, bdc } = make();
    await c.connect();
    await c.apply(BLUE);
    let release = null;
    const real = c._readSlaves.bind(c);
    c._readSlaves = () => new Promise((res) => { release = () => real().then(res); });   // a status read that takes its time (seconds on the car)
    await clock.advance(1600);
    assert.ok(release, 'the read-back is under way');
    assert.strictEqual(c.scheduler.status().held, true);
    const n = writes(bdc).length;
    const ap = c.apply(DUAL);
    await tick(); await tick();
    assert.strictEqual(writes(bdc).length, n, 'nothing is sent into the read');
    release();
    await ap;
    assert.ok(writes(bdc).length > n, 'the Apply went out as soon as the read was done');
    assert.strictEqual(c.scheduler.status().held, false);
    assert.deepStrictEqual(phys(c, '2:1').slice(0, 4), [200, 10, 40, 70]);
    await c.restoreOem();
});

/* ================= 5. a door during Rainbow and during Colour Wave ================= */
for (const mode of ['rainbow', 'wave']) {
    test('a door opening and closing during ' + S.MODE_LABELS[mode] + ': its line goes to BMW with one release, the animation runs on around it, and it rejoins at the current phase', async () => {
        for (const door of Object.keys(LINE)) {
            const { svc, clock, bdc, car } = await makeService({});
            const field = { driverFront: 'statusDoorSwitchDRD', passengerFront: 'statusDoorSwitchPSD', driverRear: 'statusDoorSwitchDRDR', passengerRear: 'statusDoorSwitchPSDR' }[door];
            const what = mode + ', ' + door + ': ';
            assert.ok((await svc.apply(program(mode))).ok);
            await clock.advance(3000);
            const ctl = svc.ctl, phase0 = ctl.phase0, prog = ctl.program, applies = ctl.stats.applies;
            const bus = Number(LINE[door].split(':')[0]), other = bus === 1 ? 2 : 1;
            const n = writes(bdc).length;
            car.doors({ [field]: 1 });
            await tick(); await clock.advance(1000);
            const open = writes(bdc).slice(n);
            const toLine = open.filter((r) => keyOf(r) === LINE[door]);
            assert.strictEqual(toLine.length, 1, what + 'one write to the door\'s line');
            assert.ok(isRelease(toLine[0]), what + 'and it is the factory handback');
            assert.strictEqual(svc.ctl.physicalColour(LINE[door]).source, 'oem', what + 'BMW has the line');
            assert.ok(open.every((r) => keyOf(r) !== bus + ':0'), what + 'no whole-bus write on the door\'s bus while it is open');
            assert.ok(open.filter((r) => keyOf(r) === other + ':0').length >= 10, what + 'the other bus is still one write a frame');
            const singles = new Set(open.filter((r) => r.data[3] === 1 && keyOf(r).split(':')[0] === String(bus)).map(keyOf));
            assert.strictEqual(singles.size, MODULES.filter((m) => m.bus === bus).length - 1, what + 'every other light of that bus is written on its own');
            assert.ok(open.every((r) => r.data[3] === 0 || !(r.data[4] === 0)), what + 'no black');
            // two more seconds open: the animation is alive on every other light, the line untouched
            const before = MODULES.filter((m) => S.key(m) !== LINE[door]).map((m) => svc.ctl.physicalColour(S.key(m)));
            const m0 = writes(bdc).length;
            await clock.advance(2000);
            assert.ok(writes(bdc).slice(m0).every((r) => keyOf(r) !== LINE[door] && keyOf(r) !== bus + ':0'), what + 'still not one write to it');
            const after = MODULES.filter((m) => S.key(m) !== LINE[door]).map((m) => svc.ctl.physicalColour(S.key(m)));
            assert.ok(after.every((p) => p.source === 'custom'), what + 'nothing else lapsed');
            assert.notDeepStrictEqual(after, before, what + 'the animation moved on');
            assert.strictEqual(svc.ctl.physicalColour(LINE[door]).source, 'oem');
            // the door closes
            const log = tap(ctl, clock);
            car.doors({});
            await tick(); await clock.advance(400);
            assert.strictEqual(ctl.phase0, phase0, what + 'the animation\'s time origin was never touched');
            assert.strictEqual(ctl.program, prog);
            assert.strictEqual(ctl.stats.applies, applies, what + 'nothing was applied again');
            // the line shows what lightAt() says for the frame just written: the same phase as its neighbours
            const last = log.filter((e) => e.params.active).pop();
            const m = MODULES.find((x) => S.key(x) === LINE[door]);
            const want = AC.lightAt(refScene(mode), refLight(m), last.t - phase0);
            assert.deepStrictEqual(phys(ctl, LINE[door]), [cap(want.rgb[0]), cap(want.rgb[1]), cap(want.rgb[2]), want.bright, 'custom'], what + 'back at the current phase');
            const mate = MODULES.find((x) => x.bus === bus && S.key(x) !== LINE[door]);
            assert.deepStrictEqual(phys(ctl, LINE[door]).slice(0, 3), phys(ctl, S.key(mate)).slice(0, 3), what + 'in step with the rest of its bus');
            assert.ok(log.some((e) => e.key === bus + ':0' && e.params.active), what + 'its bus is written whole again');
            await svc.stop();
        }
    });
}
test('two doors on different buses during Rainbow: both buses go to single writes, both lines stay BMW\'s; a release nobody answers is not sent again', async () => {
    const { svc, clock, bdc, car } = await makeService({});
    await svc.apply(program('rainbow'));
    await clock.advance(1000);
    const n = writes(bdc).length;
    car.doors({ statusDoorSwitchDRD: 1, statusDoorSwitchPSD: 1 });
    await tick(); await clock.advance(2000);
    const w = writes(bdc).slice(n);
    assert.ok(w.every((r) => r.data[2] !== 0), 'no NAD 0 at all');
    assert.deepStrictEqual(w.filter((r) => keyOf(r) === LINE.driverFront || keyOf(r) === LINE.passengerFront).map(isRelease), [true, true]);
    assert.strictEqual(svc.ctl.driven.size, 17);
    await svc.stop();
    // the release of a door's line gets no reply: sent once, and the frames do not ask again
    const b = await makeService({});
    await b.svc.apply(program('rainbow'));
    await b.clock.advance(1000);
    const real = b.svc.ctl._writeSlave.bind(b.svc.ctl);
    let lost = 0;
    b.svc.ctl._writeSlave = async (slave, params) => { const r = await real(slave, params); if (!params.active && slave.nad === 8) { lost++; return { ok: false, reason: 'timeout' }; } return r; };
    b.car.doors({ statusDoorSwitchDRD: 1 });
    await tick(); await b.clock.advance(3000);
    assert.strictEqual(lost, 1, 'one release, whatever became of its reply');
    assert.strictEqual(b.svc.ctl.program.mode, 'rainbow', 'and the animation goes on');
    await b.svc.stop();
});

/* ================= 6. handing everything back: factory off, locked, asleep, Restore OEM ================= */
test('Restore OEM: two releases (NAD 0, bus 1 then bus 2), one after the other, in the reference\'s bytes; also with single colour writes', async () => {
    for (const txMode of ['broadcast', 'individual']) for (const what of [BLUE, program('rainbow'), program('wave'), DUAL]) {
        const { svc, clock, bdc } = await makeService({ sets: { txMode } });
        assert.ok((await svc.apply(what)).ok);
        await clock.advance(2500);
        const n = writes(bdc).length;
        const log = tap(svc.ctl, clock);
        const r = await svc.restoreOem();
        assert.deepStrictEqual([r.ok, r.released, r.failed.length], [true, 19, 0], txMode + ' ' + what.mode);
        const w = writes(bdc).slice(n);
        assert.deepStrictEqual(w.map((x) => x.data), [LIN.releaseFrame(0, 0), LIN.releaseFrame(1, 0)], txMode + ' ' + what.mode + ': lin.js releaseFrame(bus, 0) for both buses, nothing else');
        assert.ok(log[1].t >= log[0].done, 'the second only when the first had its reply');
        assert.ok(allOem(svc));
        assert.strictEqual(svc.ctl.program, null);
        const m = writes(bdc).length;
        await clock.advance(60000);
        assert.strictEqual(writes(bdc).length, m, 'and nothing is written afterwards');
        assert.ok(allOem(svc));
        await svc.stop();
    }
});
test('the car locked and left during Rainbow: the two releases and then not one more request (no read-back to a car going to sleep)', async () => {
    for (const state of [1, 2, 3]) {
        const { svc, clock, bdc, car } = await makeService({});
        await svc.apply(program('rainbow'));
        await clock.advance(2000);
        const n = writes(bdc).length;
        car.condition(state);
        await settle(svc);
        assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0'], 'state ' + state);
        assert.ok(writes(bdc).slice(n).every(isRelease));
        assert.ok(allOem(svc));
        const all = bdc.requests.length, frames = svc.ctl.stats.frames;
        await clock.advance(30 * 60000); await svc.gateTick();
        assert.strictEqual(bdc.requests.length, all, 'state ' + state + ': silence, reads included');
        assert.strictEqual(svc.ctl.stats.frames, frames, 'state ' + state + ': the animation is stopped');
        await svc.stop();
    }
});
test('the factory ambient lighting switched off: two releases at once, one read-back to make sure, then silence', async () => {
    const { svc, clock, bdc, car } = await makeService({});
    await svc.apply(program('wave'));
    await clock.advance(2000);
    const n = writes(bdc).length, rd = reads(bdc).length;
    car.factory(0);
    await settle(svc);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0']);
    assert.ok(allOem(svc));
    assert.strictEqual(reads(bdc).length, rd, 'the release did not wait for a read');
    await clock.advance(2000);
    assert.strictEqual(reads(bdc).length, rd + 2, 'one read of each bus, in the background');
    assert.strictEqual(writes(bdc).length, n + 2, 'every module had gone back: nothing to repair');
    const all = bdc.requests.length;
    await clock.advance(10 * 60000); await svc.gateTick();
    assert.strictEqual(bdc.requests.length, all);
    assert.ok(!(await svc.apply(BLUE)).ok, 'and no Apply while the factory lighting is off');
    await svc.stop();
});
test('a module that missed the whole-bus release is found by that read-back and released on its own', async () => {
    const { c, clock, bdc } = make({ deafKeys: ['2:5'] });
    await c.connect();
    await c.apply(BLUE);                                       // (2:5 ignores NAD 0: the first read-back repairs the colour)
    await clock.advance(4000);
    assert.deepStrictEqual(Array.from(c.deaf), ['2:5']);
    c.deaf.clear();                                            // as if it had only missed the release
    const n = writes(bdc).length;
    const r = await c.restoreOem();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0']);
    assert.strictEqual(phys(c, '2:5')[4], 'custom', 'it kept our colour');
    await clock.advance(1600);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0', '2:5'], 'released singly after the read-back');
    assert.strictEqual(phys(c, '2:5')[4], 'oem');
    assert.strictEqual(c.stats.releaseRepairs, 1);
    await clock.advance(60000);
    assert.strictEqual(writes(bdc).length, n + 3);
    assert.strictEqual(clock.pending(), 0);
});
test('asleep or unavailable: with the link gone nothing is sent; with a body controller that does not answer each release is sent ONCE; the colours lapse by themselves', async () => {
    // the diagnostic link is gone
    const a = make();
    await a.c.connect();
    await a.c.apply(BLUE);
    a.bdc.offline = true;
    const n = a.bdc.requests.length;
    const r = await a.c.restoreOem();
    assert.strictEqual(r.ok, false);
    assert.ok(/lapse by themselves within 10 s/.test(r.reason), r.reason);
    assert.strictEqual(a.bdc.requests.length, n, 'not one request');
    await a.clock.advance(11000);
    assert.ok(MODULES.every((m) => phys(a.c, S.key(m))[4] === 'oem'), 'ZEIT ran out: every module is the car\'s again');
    assert.strictEqual(a.bdc.requests.length, n);
    // the link is up but the body controller says nothing (asleep)
    const b = make();
    await b.c.connect();
    await b.c.apply(program('rainbow'));
    await b.clock.advance(1000);
    b.bdc.offline = true; b.c._available = () => true;
    const m = b.bdc.requests.length;
    const rp = b.c.restoreOem();
    await b.clock.advance(100);
    const rb = await rp;
    assert.strictEqual(rb.ok, false);
    assert.ok(/refused or unanswered.*lapse by themselves/.test(rb.reason), rb.reason);
    assert.deepStrictEqual(b.bdc.requests.slice(m).map(keyOf), ['1:0', '2:0'], 'two releases, each once');
    await b.clock.advance(60000);
    assert.strictEqual(b.bdc.requests.length, m + 2, 'nothing is sent again, and no read-back is tried');
    assert.ok(MODULES.every((x) => phys(b.c, S.key(x))[4] === 'oem'), 'the 5 s hold of the animation ran out');
    assert.strictEqual(b.clock.pending(), 0);
});
test('a car whose state is not known (asleep): the animation stops with no write at all, not even a release, and the colours run out by themselves', async () => {
    // (lighting_service.js decides between release and lapse: test_v050.js; this is what a lapse does to a running animation)
    const { c, clock, bdc } = make();
    await c.connect();
    await c.apply(program('rainbow'));
    await clock.advance(1000);
    const n = bdc.requests.length, frames = c.stats.frames;
    const r = await c.lapse('the car has not said it is in use');
    assert.deepStrictEqual(r, { ok: true, lapsing: 19 });
    assert.strictEqual(c.program, null);
    await clock.advance(4000);
    assert.ok(MODULES.every((m) => phys(c, S.key(m))[4] === 'custom'), 'still inside the 5 s hold');
    await clock.advance(2000);
    assert.ok(MODULES.every((m) => phys(c, S.key(m))[4] === 'oem'), 'the hold ran out: the car\'s own lighting, with nothing sent');
    await clock.advance(60000);
    assert.strictEqual(bdc.requests.length, n, 'not one request: no frame, no release, no read-back');
    assert.strictEqual(c.stats.frames, frames);
    assert.strictEqual(clock.pending(), 0);
});
test('the platform stops the app during an animation with a door open: two releases, in time, and nothing after', async () => {
    const { svc, clock, bdc, car } = await makeService({});
    await svc.apply(program('wave'));
    car.doors({ statusDoorSwitchPSDR: 1 });
    await tick(); await clock.advance(1500);
    const n = writes(bdc).length;
    const r = await svc.stop('test');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf), ['1:0', '2:0']);
    assert.ok(allOem(svc));
    const all = bdc.requests.length;
    await clock.advance(60000);
    assert.strictEqual(bdc.requests.length, all);
    assert.strictEqual(clock.pending(), 0, 'no timer left');
});
test('a car that refuses NAD 0: the handback falls back to one release a module, and stays that way', async () => {
    const { c, bdc } = make({ noBroadcast: true });
    await c.connect();
    await c.apply(BLUE);
    await c.scheduler.drain();
    assert.strictEqual(c.broadcastOk, false);
    const n = writes(bdc).length;
    const r = await c.restoreOem();
    assert.deepStrictEqual([r.ok, r.released], [true, 19]);
    assert.strictEqual(writes(bdc).length - n, 19);
    assert.ok(writes(bdc).slice(n).every((x) => x.data[2] !== 0 && isRelease(x)));
});

/* ================= 7. the settings, the screen ================= */
test('settings: whole-bus writes and the door handback are on from the start; no red-door setting; the version', () => {
    const def = (k) => SPEC.settings.find((s) => s.key === k);
    assert.strictEqual(SPEC.version, '0.5.1');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version, '0.5.1');
    assert.strictEqual(def('txMode').default, 'broadcast');
    assert.strictEqual(def('doorRelease').default, 'on');
    assert.strictEqual(def('doorFlash'), undefined);
    assert.strictEqual(def('frame').default, 40);
    assert.strictEqual(def('inflight').default, '1', 'one request at a time through the gateway');
    assert.strictEqual(def('backend').default, 'mock'); assert.strictEqual(def('arm').default, 'off');
    assert.ok(!/flash/i.test(SPEC.description) && /BMW's own warning light/.test(SPEC.description));
    // no roof lamp: the 19 modules are the body controller's LIN modules, and nothing else is written
    assert.deepStrictEqual(P.WRITE_DIDS, [0xDA5E, 0xE3D1]);
    assert.ok(MODULES.every((m) => !/roof/i.test(P.LOCATION[m.locationId])));
});
test('the Modes page: every mode draws, the animations have the speed step and their two colours, and no two controls overlap', async () => {
    const h = await harness({});
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    assert.ok((await h.app.svc.apply(program('rainbow'))).ok);
    h.app.dirty().modes = true;
    h.app.setPage(2);
    await h.frame();
    for (const m of ['solid', 'dual', 'rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse']) {
        await h.press('mode:' + m);
        await h.frame();
        const ts = h.targets().filter((t) => t.w > 0 && t.h > 0);
        ts.forEach((t) => assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= 1600 && t.y + t.h <= 520, m + ': ' + t.key + ' is on the screen: ' + [t.x, t.y, t.w, t.h]));
        for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
            if (overlap(ts[i], ts[j]) && !inside(ts[i], ts[j]) && !inside(ts[j], ts[i])) assert.fail(m + ': ' + ts[i].key + ' overlaps ' + ts[j].key);
        }
        const keys = ts.map((t) => t.key);
        if (S.RUNNING[m]) {
            ['p:speed', 'p:speed+', 'p:speed-', 'usecol', 'usedual', 'apply'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, m + ' has ' + k));
            assert.ok(!keys.some((k) => /^p:(periodS|hueSpan|baseHue|minBrightness|maxBrightness|transitionMs|holdMs)/.test(k) || /^pal:/.test(k)), m + ': no knob the reference does not have');
            assert.deepStrictEqual(S.normalise(h.app.modesProgram()), S.normalise(Object.assign({}, h.app.draft.modes.params[m], { mode: m })), m);
        }
        assert.ok(h.png().length > 2000, m + ' rasterises');
    }
    assert.ok(!h.log.some((l) => l[0] === 'error'), JSON.stringify(h.log.filter((l) => l[0] === 'error')));
    // the Colours page colour into both groups, then run it
    await h.press('mode:breathing'); await h.frame();
    h.app.draft.colours.hsv = { h: 120, s: 1, v: 1 }; h.app.draft.colours.brightness = 55;
    await h.press('usecol');
    assert.deepStrictEqual(h.app.modesProgram().top, { colour: { r: 0, g: 255, b: 0 }, brightness: 55 });
    assert.deepStrictEqual(h.app.modesProgram().bottom, h.app.modesProgram().top);
    await h.app.svc.stop();
});

module.exports = run('v051');

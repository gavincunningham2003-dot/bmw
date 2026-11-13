'use strict';
/* 0.4.0: whole-bus writes (NAD 0), the one-time effects and speed steps, hold times, read-back, two-bus refresh,
 * driving modes, the factory gate (car left, factory lighting off, another controller). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run, assert, fakeClock } = require('./t');
const { JS } = require('../../scripts/stage');
const { MockLightingController, MockBdc, DEFAULT_SLAVES } = require(path.join(JS, 'lighting_mock'));
const { BdcUdsLightingController } = require(path.join(JS, 'lighting_bdc_uds'));
const { bus } = require('./fake_tasu');
const P = require(path.join(JS, 'lighting_protocol'));
const S = require(path.join(JS, 'lighting_scene'));
const PL = require(path.join(JS, 'lighting_plan'));
const DM = require(path.join(JS, 'driving_modes'));
const { harness } = require('./ui_harness');

const writes = (c) => c.bdc.requests.filter((r) => r.sid === 0x2E);
const nads = (c) => writes(c).map((r) => (r.data[0] === 0xDA ? 1 : 2) + ':' + r.data[2]);
const phys = (c, key) => { const p = c.physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
function make(mock, opts) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient' }, opts || {}));
    return { c, bdc, clock };
}
const RED = { mode: 'solid', colour: { r: 254, g: 0, b: 0 }, brightness: 100, zone: 'all' };
const DUAL = { mode: 'dual', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 80 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 45 }, handlesTo: 'bottom' };
const mods = (n1, n2) => [].concat(Array.from({ length: n1 }, (_, i) => ({ bus: 1, nad: i + 1 })), Array.from({ length: n2 }, (_, i) => ({ bus: 2, nad: i + 1 })));
const sceneOf = (list, t) => list.reduce((s, m) => { s[m.bus + ':' + m.nad] = Object.assign({}, t); return s; }, {});
const T1 = { r: 1, g: 2, b: 3, brightness: 100 }, T2 = { r: 9, g: 9, b: 9, brightness: 50 };

/* ---------- the planner ---------- */
test('plan: individual mode writes one per module; broadcast mode a uniform cabin in 2 writes', () => {
    const m = mods(7, 12), scene = sceneOf(m, T1);
    assert.strictEqual(PL.plan(scene, m, new Map(), { mode: 'individual', all: true }).length, 19);
    const b = PL.plan(scene, m, new Map(), { mode: 'broadcast', all: true });
    assert.deepStrictEqual(b.map((x) => x.key), ['1:0', '2:0']);
    assert.strictEqual(b[0].slave.nad, 0);
    assert.strictEqual(b[1].covers.length, 12);
});
test('plan: mixed colours = the common colour to the whole bus, then the modules that differ, forced', () => {
    const m = mods(7, 12), scene = sceneOf(m, T1);
    scene['2:3'] = Object.assign({}, T2); scene['2:4'] = Object.assign({}, T2);
    const b = PL.plan(scene, m, new Map(), { mode: 'broadcast', all: true });
    assert.deepStrictEqual(b.map((x) => x.key), ['1:0', '2:0', '2:3', '2:4']);
    assert.ok(b.slice(2).every((x) => x.force), 'the exceptions are written after the whole-bus write, always');
    assert.strictEqual(b[1].params.r, 1);
});
test('plan: a bus with a module left to the car is never written with NAD 0; a bus where it saves nothing is not either', () => {
    const m = mods(7, 12), scene = sceneOf(m, T1);
    delete scene['1:5'];                                              // bus 1: one module stays OEM
    const b = PL.plan(scene, m, new Map(), { mode: 'broadcast', all: true });
    assert.ok(!b.some((x) => x.key === '1:0'), 'no NAD 0 on bus 1');
    assert.strictEqual(b.filter((x) => x.slave.bus === 1).length, 6);
    assert.ok(b.some((x) => x.key === '2:0'));
    // everything already shows its colour and one module is due: one single write, not a whole-bus one
    const last = new Map(m.map((x) => [x.bus + ':' + x.nad, { ok: true, params: Object.assign({ active: true }, T1) }]));
    const one = PL.plan(sceneOf(m, T1), m, last, { mode: 'broadcast', force: new Set(['2:7']) });
    assert.deepStrictEqual(one.map((x) => x.key), ['2:7']);
    assert.deepStrictEqual(PL.plan(sceneOf(m, T1), m, last, { mode: 'broadcast' }), [], 'nothing due, nothing written');
});
test('planRelease: the whole cabin back in one NAD 0 release a bus; one each only once the car refused NAD 0', () => {
    const m = mods(7, 12);
    assert.deepStrictEqual(PL.planRelease(m, m, { whole: true }).map((x) => x.key), ['1:0', '2:0']);
    assert.strictEqual(PL.planRelease(m, m, { whole: false }).length, 19);
    assert.deepStrictEqual(PL.planRelease([m[0]], m, { whole: true }).map((x) => x.key), ['1:1'], 'a single module: its own release');
    assert.ok(PL.planRelease(m, m, { whole: true }).every((x) => x.params.active === false && x.params.seconds === 0));
    // a module that has been seen to miss whole-bus writes gets its own release after the bus's
    assert.deepStrictEqual(PL.planRelease(m, m, { whole: true, deaf: new Set(['1:1']) }).map((x) => x.key), ['1:0', '1:1', '2:0']);
});
test('planRelease: a bus where any module keeps its colour is never released whole (one door open, a zone changed)', () => {
    const m = mods(7, 12);
    // two doors of bus 2 open at once: their two modules, and nothing else on that bus
    const keep = new Set(m.filter((x) => !(x.bus === 2 && (x.nad === 8 || x.nad === 11))).map((x) => x.bus + ':' + x.nad));
    assert.deepStrictEqual(PL.planRelease([m[7 + 7], m[7 + 10]], m, { whole: true, keep }).map((x) => x.key), ['2:8', '2:11']);
    // every module of bus 1 goes, bus 2 keeps one colour: bus 1 whole, bus 2 singly
    const keep2 = new Set(['2:1']);
    const rel = m.filter((x) => x.bus === 1).concat([m[8], m[9]]);
    assert.deepStrictEqual(PL.planRelease(rel, m, { whole: true, keep: keep2 }).map((x) => x.key), ['1:0', '2:2', '2:3']);
});

/* ---------- the controller with whole-bus writes ---------- */
test('single writes when asked for (setting "One per module"): 19 writes, none to NAD 0', async () => {
    const { c } = make();
    await c.connect();
    await c.apply(RED);
    assert.strictEqual(c.txMode, 'individual');
    assert.strictEqual(writes(c).length, 19);
    assert.ok(!nads(c).some((k) => /:0$/.test(k)));
});
test('broadcast: a solid colour is 2 writes and every module shows it; Restore OEM is 2 writes and reports all released', async () => {
    const { c, clock } = make({}, { txMode: 'broadcast' });
    await c.connect();
    const checks = [];
    c.on('verified', (v) => checks.push(v));
    const r = await c.apply(RED);
    // Apply answers as soon as the two writes are out: the read-back comes later, in the background
    assert.deepStrictEqual(r, { ok: true, written: 19, failed: 0, unanswered: 0, released: 0, verifying: true });
    assert.strictEqual(c.bdc.requests.filter((q) => q.sid === 0x22 && (q.data[0] === 0xDA || q.data[0] === 0xE3)).length, 2, 'only the probe\'s reads so far');
    assert.deepStrictEqual(nads(c), ['1:0', '2:0']);
    await clock.advance(1600);
    assert.deepStrictEqual(checks, [{ confirmed: 19, missed: 0, unread: 0 }], 'read back once, 1.5 s later, nothing to repair, no second read');
    await clock.advance(3000);
    assert.strictEqual(checks.length, 1);
    assert.deepStrictEqual(nads(c), ['1:0', '2:0']);
    assert.deepStrictEqual(writes(c)[0].data, [0xDA, 0x5E, 0, 1, 100, 254, 0, 0, 10]);
    c.slaves.forEach((s) => assert.deepStrictEqual(phys(c, s.bus + ':' + s.nad), [254, 0, 0, 100, 'custom']));
    assert.strictEqual(c.driven.size, 19);
    const o = await c.restoreOem();
    assert.deepStrictEqual([o.ok, o.released, o.failed.length], [true, 19, 0]);
    assert.strictEqual(writes(c).length, 4);
    assert.deepStrictEqual(nads(c).slice(2), ['1:0', '2:0']);
    c.slaves.forEach((s) => assert.strictEqual(phys(c, s.bus + ':' + s.nad)[4], 'oem'));
});
test('broadcast: dual colour puts the right colour on every module with fewer writes than modules', async () => {
    const a = make(), b = make({}, { txMode: 'broadcast' });
    await a.c.connect(); await b.c.connect();
    await a.c.apply(DUAL); await b.c.apply(DUAL);
    a.c.slaves.forEach((s) => assert.deepStrictEqual(phys(b.c, s.bus + ':' + s.nad), phys(a.c, s.bus + ':' + s.nad), s.location));
    assert.ok(writes(b.c).length < writes(a.c).length, writes(b.c).length + ' < ' + writes(a.c).length);
});
test('broadcast never touches a module the program leaves to the car', async () => {
    const { c } = make({}, { txMode: 'broadcast' });
    await c.connect();
    await c.apply({ mode: 'solid', colour: { r: 0, g: 254, b: 0 }, brightness: 100, zone: 'footwells' });
    assert.ok(!nads(c).some((k) => /:0$/.test(k)), 'a zone: single writes only');
    const dash = c.slaves.find((s) => /dashboard/i.test(s.location));
    assert.strictEqual(phys(c, dash.bus + ':' + dash.nad)[4], 'oem');
});
test('a car that refuses NAD 0: falls back to single writes, every module still gets its colour, and it stays off', async () => {
    const { c } = make({ noBroadcast: true }, { txMode: 'broadcast' });
    await c.connect();
    const r = await c.apply(RED);
    assert.strictEqual(c.broadcastOk, false);
    await c.scheduler.drain();
    c.slaves.forEach((s) => assert.deepStrictEqual(phys(c, s.bus + ':' + s.nad).slice(0, 3), [254, 0, 0]));
    const before = writes(c).length;
    await c.apply({ mode: 'solid', colour: { r: 0, g: 0, b: 254 }, brightness: 100, zone: 'all' });
    assert.strictEqual(writes(c).length - before, 19, 'single writes from then on');
    assert.ok(r.written >= 0);
});
test('a module that misses the whole-bus write (bus 1 NAD 1 on the G20): the read-back finds it, repairs it, and it gets its own write from then on', async () => {
    const { c, clock } = make({ deafKeys: ['1:1'] }, { txMode: 'broadcast' });
    await c.connect();
    const checks = [];
    c.on('verified', (v) => checks.push([v.confirmed, v.missed]));
    const r = await c.apply(RED);
    assert.strictEqual(r.verifying, true, 'whole-bus mode reads back even with the setting off');
    assert.deepStrictEqual(nads(c), ['1:0', '2:0'], 'Apply did not wait for the read-back');
    await clock.advance(1600);
    assert.deepStrictEqual(checks, [[18, 1]], 'the read-back found the module that kept the car\'s colour');
    assert.deepStrictEqual(nads(c), ['1:0', '2:0', '1:1'], 'and wrote it on its own');
    await clock.advance(1600);
    assert.deepStrictEqual(checks, [[18, 1], [19, 0]], 'a second read confirms the repair');
    c.slaves.forEach((s) => assert.deepStrictEqual(phys(c, s.bus + ':' + s.nad).slice(0, 3), [254, 0, 0], s.location));
    assert.deepStrictEqual(Array.from(c.deaf), ['1:1']);
    const n = writes(c).length;
    await c.apply({ mode: 'solid', colour: { r: 0, g: 0, b: 254 }, brightness: 100, zone: 'all' });
    assert.deepStrictEqual(nads(c).slice(n), ['1:0', '1:1', '2:0'], 'its own write straight after the whole-bus one');
    await clock.advance(1600);
    assert.deepStrictEqual(checks[2], [19, 0]);
    // handing back: the bus, then that module on its own as well
    const m = writes(c).length;
    await c.restoreOem();
    assert.deepStrictEqual(nads(c).slice(m), ['1:0', '1:1', '2:0']);
    assert.ok(c.slaves.every((s) => phys(c, s.bus + ':' + s.nad)[4] === 'oem'));
});
test('a moving program with whole-bus writes: rainbow frames are 2 writes each', async () => {
    const { c, clock } = make({}, { txMode: 'broadcast', frameMs: 100 });
    await c.connect();
    await c.apply({ mode: 'rainbow', zone: 'all' });
    const n0 = writes(c).length;
    await clock.advance(1000);
    const added = writes(c).slice(n0);
    assert.ok(added.length >= 4, 'frames were written: ' + added.length);
    assert.ok(added.every((w) => w.data[2] === 0), 'every frame write is a whole-bus write');
    await c.restoreOem();
});

/* ---------- one-time effects, speed, holds ---------- */
test('welcome sweep: the dashboard comes on before the rear, and it ends on the follow-on program', () => {
    const m = [{ bus: 2, nad: 1, locationId: 0x15 }, { bus: 2, nad: 12, locationId: 0x02 }];
    const p = { mode: 'welcome', then: RED };
    const early = S.render(p, m, 700, { phase0: 0 }), late = S.render(p, m, 2600, { phase0: 0 });
    assert.ok(early['2:1'].brightness > early['2:12'].brightness, 'front first');
    assert.strictEqual(early['2:12'].brightness, 0);
    assert.deepStrictEqual(late['2:12'], { r: 254, g: 0, b: 0, brightness: 100 });
    assert.strictEqual(S.onceMs(p), 2600);
    assert.strictEqual(S.onceMs(RED), 0);
});
test('sport pulse: red for 1.5 s, then the follow-on colour; a one-time program never nests another', () => {
    const m = [{ bus: 1, nad: 1, locationId: 0x0F }];
    const p = { mode: 'pulse', then: { mode: 'solid', colour: { r: 0, g: 0, b: 254 }, brightness: 60, zone: 'all' } };
    // (Ambient Config's red is 255; on the wire every colour byte stops at 254, as 255 means "no change")
    assert.deepStrictEqual(S.render(p, m, 500, {})['1:1'], { r: 255, g: 0, b: 0, brightness: 100 });
    assert.deepStrictEqual(S.render(p, m, 1499, {})['1:1'], { r: 255, g: 0, b: 0, brightness: 100 });
    assert.strictEqual(P.encodeLayeringWrite({ bus: 1, nad: 1, active: true, brightness: 100, r: 255, g: 0, b: 0, seconds: 5 })[5], 254);
    assert.deepStrictEqual(S.render(p, m, 1600, {})['1:1'], { r: 0, g: 0, b: 254, brightness: 60 });
    assert.strictEqual(S.normalise({ mode: 'pulse', then: { mode: 'welcome' } }).then, null);
});
test('speed steps: slow is 1.6 x the base time, fast 0.55 x (the same picture at a scaled time)', () => {
    const m = [{ bus: 1, nad: 1, locationId: 0x0F }];
    const base = { mode: 'rainbow', zone: 'all' };
    assert.deepStrictEqual(S.render(Object.assign({ speed: 1 }, base), m, 1600, {}), S.render(base, m, 1000, {}));
    assert.deepStrictEqual(S.render(Object.assign({ speed: 3 }, base), m, 550, {}), S.render(base, m, 1000, {}));
    assert.strictEqual(S.normalise(Object.assign({ speed: 9 }, base)).speed, 2);
});
test('a one-time program runs once: then its follow-on is applied; with none, the car gets its lighting back', async () => {
    const { c, clock } = make();
    await c.connect();
    await c.apply({ mode: 'welcome', then: RED });
    assert.strictEqual(c.program.mode, 'welcome');
    await clock.advance(3500);
    assert.strictEqual(c.program.mode, 'solid', 'the follow-on took over');
    assert.deepStrictEqual(phys(c, '2:1').slice(0, 4), [254, 0, 0, 100]);
    const n = writes(c).length;
    await clock.advance(3000);
    assert.ok(writes(c).length - n < 19, 'it does not start again');
    await c.apply({ mode: 'pulse', then: null });
    await clock.advance(3000);
    assert.strictEqual(c.program, null);
    assert.strictEqual(phys(c, '2:1')[4], 'oem');
});
test('hold times: a still program holds the chosen time, a moving one 5 s renewed after 3 (Ambient Config\'s)', async () => {
    const { c } = make({}, { refreshSeconds: 60 });
    await c.connect();
    await c.apply(RED);
    assert.strictEqual(writes(c)[0].data[8], 60);
    const n = writes(c).length;
    assert.strictEqual(c.renewMs(), 30000);
    await c.apply({ mode: 'breathing' });
    assert.strictEqual(writes(c)[n].data[8], 5);
    assert.strictEqual(c.holdSeconds(), 5);
    assert.strictEqual(c.renewMs(), 3000);
    await c.restoreOem();
});
test('read-back after a still Apply, in the background: every module confirmed', async () => {
    const { c, clock } = make({}, { verify: true });
    await c.connect();
    let check = null;
    c.on('verified', (v) => { check = v; });
    const r = await c.apply(RED);
    assert.strictEqual(r.verifying, true);
    assert.strictEqual(check, null, 'not during Apply');
    await clock.advance(1600);
    assert.strictEqual(check.confirmed, 19);
    assert.strictEqual(check.missed, 0);
    assert.strictEqual(c.slaves.length, 19, 'the read-back does not change the module list');
});

/* ---------- the gate ---------- */
test('the gate: while it gives a reason nothing is applied and nothing is renewed', async () => {
    let why = null;
    const { c, clock } = make({}, { gate: () => why });
    await c.connect();
    why = 'the car is locked or left';
    const r = await c.apply(RED);
    assert.deepStrictEqual([r.ok, r.reason], [false, 'the car is locked or left']);
    assert.strictEqual(writes(c).length, 0);
    why = null;
    await c.apply(RED);
    const n = writes(c).length;
    why = 'the factory ambient lighting is switched off';
    await clock.advance(30000);
    assert.strictEqual(writes(c).length, n, 'no keep-alive while the gate is closed');
});

/* ---------- both buses on a refresh (the real controller on the fake TASU bus) ---------- */
test('readState reads both buses; a bus that fails keeps its modules; neither answering changes nothing', async () => {
    const bdc = new MockBdc({});
    const b = bus(JS, bdc, {});
    const c = new BdcUdsLightingController({ diag: b.diag, diagModule: b.diagModule, timeoutMs: 300, parkedPolicy: 'lenient' });
    await c.init(); await c.connect();
    assert.strictEqual(c.slaves.length, 19);
    let st = await c.readState();
    assert.strictEqual(st.slaves.length, 19, 'bus 2 survives a refresh');
    assert.deepStrictEqual(c.busRead, { 1: true, 2: true });
    const real = c._read.bind(c);
    c._read = async (did) => (did === P.DID.LIN2_LAYERING ? { ok: false, reason: 'no reply' } : real(did));
    st = await c.readState();
    assert.strictEqual(st.slaves.filter((s) => s.bus === 2).length, 12, 'bus 2 kept from the last read');
    assert.deepStrictEqual(c.busRead, { 1: true, 2: false });
    c._read = async (did) => (did === P.DID.LIN1_LAYERING_STATUS ? { ok: false, reason: 'no reply' } : real(did));
    st = await c.readState();
    assert.strictEqual(st.slaves.filter((s) => s.bus === 1).length, 7);
    c._read = async () => ({ ok: false, reason: 'no reply' });
    st = await c.readState();
    assert.strictEqual(st.slaves.length, 19);
});
test('a car with a different number of modules: 13 on one bus work the same, whole-bus writes included', async () => {
    const { c } = make({ slaves: DEFAULT_SLAVES, slaves2: [] }, { txMode: 'broadcast' });
    await c.connect();
    assert.strictEqual(c.slaves.length, 13);
    const r = await c.apply(RED);
    assert.strictEqual(r.written, 13);
    assert.deepStrictEqual(nads(c), ['1:0']);
});

/* ---------- driving modes ---------- */
test('modeOf: names and wire numbers; a plug-in hybrid\'s modes; unknown values say nothing', () => {
    assert.deepStrictEqual(DM.modeOf('PHEV_ELECTRIC_STANDARD'), { mode: 'electric', phev: true });
    assert.deepStrictEqual(DM.modeOf(17), { mode: 'hybrid', phev: true });
    assert.deepStrictEqual(DM.modeOf('SPORT_DYNAMIC'), { mode: 'sport', phev: false });
    assert.deepStrictEqual(DM.modeOf('SOMETHING_HYBRID_NEW'), { mode: 'hybrid', phev: true });
    assert.strictEqual(DM.modeOf(undefined), null);
    assert.strictEqual(DM.modeOf(99).mode, null);
    assert.strictEqual(DM.conditionOf('FAHREN'), 10);
    assert.strictEqual(DM.conditionOf('NONSENSE'), undefined);
});
test('DrivingModes: the car\'s modes by kind, choices persist, the state is unknown until the car says it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-dm-'));
    const d = new DM.DrivingModes({ dataDir: dir });
    assert.deepStrictEqual(d.modes(), ['sport', 'comfort', 'eco', 'adaptive']);
    assert.strictEqual(d.away(), null);
    const seen = [];
    d.on('mode', (m, was) => seen.push([m, was]));
    d.drive({ actualValueModeDrivingExperience: 'PHEV_HYBRID_STANDARD' });
    d.drive({ actualValueModeDrivingExperience: 'PHEV_HYBRID_STANDARD' });
    d.drive({ actualValueModeDrivingExperience: 15 });
    assert.deepStrictEqual(seen, [['hybrid', null], ['sport', 'hybrid']]);
    assert.deepStrictEqual(d.modes(), ['sport', 'hybrid', 'electric', 'adaptive']);
    assert.deepStrictEqual(d.seen, ['PHEV_HYBRID_STANDARD', '15']);
    assert.deepStrictEqual(d.choice('sport'), { type: 'default' });
    assert.strictEqual(d.setChoice('sport', { type: 'custom', program: RED }), true);
    assert.strictEqual(d.setChoice('sport', { type: 'nonsense' }), false);
    d.setChoice('electric', { type: 'oem' });
    const e = new DM.DrivingModes({ dataDir: dir });
    assert.strictEqual(e.kind, 'hybrid');
    assert.strictEqual(e.choice('sport').program.colour.r, 254);
    assert.deepStrictEqual(e.choice('electric'), { type: 'oem' });
    d.condition({ statusConditionVehicle: 'FAHREN' });
    assert.strictEqual(d.away(), false);
    d.condition({ statusConditionVehicle: 2 });
    assert.strictEqual(d.away(), true);
});

/* ---------- the app: gate, following, conflict ---------- */
test('the app: driving-mode following is off by default; on, the mode\'s program is applied, "BMW" restores, Sport can pulse first', async () => {
    const h = await harness({});
    const a = h.app, ctl = a.ctl();
    a.drive.setChoice('electric', { type: 'custom', program: { mode: 'solid', colour: { r: 0, g: 200, b: 254 }, brightness: 70, zone: 'all' } });
    a.drive.setChoice('hybrid', { type: 'oem' });
    a.drive.setChoice('sport', { type: 'custom', program: RED });
    a.drive.drive({ actualValueModeDrivingExperience: 'PHEV_ELECTRIC_STANDARD' });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(ctl.program, null, 'nothing follows while the setting is off');
    h.settings.set('modeFollow', 'on');
    await a.followMode('electric', null);
    assert.strictEqual(ctl.program.colour.g, 200);
    await a.followMode('hybrid', 'electric');
    assert.strictEqual(ctl.program, null, 'BMW original: restored');
    h.settings.set('sportPulse', 'on');
    await a.followMode('sport', 'hybrid');
    assert.strictEqual(ctl.program.mode, 'pulse');
    assert.strictEqual(ctl.program.then.colour.r, 254);
    await ctl.restoreOem();
});
test('the app: the car locked or left releases the lighting and blocks Apply; it comes back only with the setting on', async () => {
    const h = await harness({});
    const a = h.app, ctl = a.ctl();
    a.drive.condition({ statusConditionVehicle: 'WOHNEN' });
    await ctl.apply(RED);
    a.drive.condition({ statusConditionVehicle: 'PARKEN_BN_IO' });
    await a.gateTick();
    assert.strictEqual(ctl.program, null, 'released');
    assert.strictEqual(a.suspended().colour.r, 254);
    const r = await ctl.apply(RED);
    assert.ok(!r.ok && /locked or left/.test(r.reason), r.reason);
    a.drive.condition({ statusConditionVehicle: 'WOHNEN' });
    await a.gateTick();
    assert.strictEqual(ctl.program, null, 'not back by itself: the setting is off');
    await ctl.apply(RED);
    h.settings.set('resume', 'on');
    a.drive.condition({ statusConditionVehicle: 1 });
    await a.gateTick();
    a.drive.condition({ statusConditionVehicle: 'FAHREN' });
    await a.gateTick();
    assert.ok(ctl.program && ctl.program.colour.r === 254, 'back with the setting on');
    await ctl.restoreOem();
});
test('the app: the factory ambient lighting switched off releases custom lighting (setting: keep it instead)', async () => {
    const values = { ambientLightActive: true };
    let handlers = null;
    const sig = { hasNative: () => true, loadConfig: () => { throw new Error('none'); }, proxy: async () => { throw new Error('none'); },
        watch: async (iface, inst, hs) => { if (/AmbientLight$/.test(iface)) { handlers = hs; hs.ambientLightActive(values.ambientLightActive); return { available: true, error: null }; } return { available: false, error: 'harness' }; } };
    const h = await harness({ signals: sig });
    await new Promise((r) => setTimeout(r, 20));
    const a = h.app, ctl = a.ctl();
    await ctl.apply(RED);
    handlers.ambientLightActive(false);
    assert.ok(/switched off/.test(a.factoryGate()));
    await a.gateTick();
    assert.strictEqual(ctl.program, null);
    h.settings.set('oemOffRule', 'ignore');
    assert.strictEqual(a.factoryGate(), null);
    assert.ok((await ctl.apply(RED)).ok);
    await ctl.restoreOem();
});
test('the app: another lighting controller on the head unit: writes refused unless the setting says otherwise', async () => {
    const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-sock-')), 'ctl.sock');
    fs.writeFileSync(sock, '');
    process.env.AMBIENT_RGB_COMFORT_SOCK = sock;
    try {
        const h = await harness({});
        const ctl = h.app.ctl();
        const r = await ctl.apply(RED);
        assert.ok(!r.ok && /another ambient lighting controller/.test(r.reason), r.reason);
        assert.strictEqual(ctl.bdc.requests.filter((x) => x.sid === 0x2E).length, 0);
        h.settings.set('conflict', 'ignore');
        assert.ok((await ctl.apply(RED)).ok);
        await ctl.restoreOem();
    } finally { delete process.env.AMBIENT_RGB_COMFORT_SOCK; }
});
test('the app: the Driving page and the two one-time modes draw; the version; the new signals are read-only and optional', async () => {
    const h = await harness({});
    h.app.setPage(5);
    let cv = await h.frame();
    assert.ok(h.targets().some((t) => t.key === 'dm:follow'));
    assert.ok(h.targets().some((t) => /^dm:def:/.test(t.key)) && h.targets().some((t) => /^dm:oem:/.test(t.key)));
    await h.press('dm:follow');
    assert.strictEqual(h.settings.get('modeFollow'), 'on');
    h.app.setPage(2);
    cv = await h.frame();
    assert.ok(h.targets().some((t) => t.key === 'mode:welcome') && h.targets().some((t) => t.key === 'mode:pulse'));
    await h.press('mode:welcome');
    assert.strictEqual(h.app.modesProgram().mode, 'welcome');
    assert.ok(cv);
    assert.strictEqual(h.ctx.spec.version, '0.5.1');
    ['de.bmw.infotainment.drivingexcitement.FES', 'de.bmw.infrastructure.VehicleCondition'].forEach((i) => {
        const s = h.ctx.spec.signals[i];
        assert.ok(s && s._optional, i);
        Object.keys(s).filter((k) => k[0] !== '_').forEach((f) => assert.ok(!/w/.test(s[f])));
    });
    assert.ok(!h.log.some((l) => l[0] === 'error'), JSON.stringify(h.log.filter((l) => l[0] === 'error')));
});

module.exports = run('v040');

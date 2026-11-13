'use strict';
const path = require('path');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS } = require('../../scripts/stage');
const { MockLightingController, MockBdc } = require(path.join(JS, 'lighting_mock'));
const P = require(path.join(JS, 'lighting_protocol'));

const writes = (c) => c.bdc.requests.filter((r) => r.sid === 0x2E);
const phys = (c, key) => { const p = c.physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
function make(mock, opts) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));          // the car's 19 modules
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient' }, opts || {}));
    return { c, bdc, clock };
}
const SOLID = { mode: 'solid', colour: { r: 254, g: 0, b: 0 }, brightness: 100, zone: 'all' };
/** apply() on a mock with latency needs the fake clock to move while it waits for the transport */
async function applyAdv(c, clock, program, ms) { const p = c.apply(program); await clock.advance(ms || 2000); return p; }
const DUAL = { mode: 'dual', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 80 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 45 }, handlesTo: 'bottom' };

test('connect probes the BDC: variant, 19 modules on two buses; nothing is written', async () => {
    const { c } = make();
    const caps = await c.connect();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(caps.variant.sgbd, 'BDC_G05');
    assert.strictEqual(c.slaves.length, 19);
    assert.strictEqual(c.custom, false);
    assert.strictEqual(writes(c).length, 0);
});
test('nothing reaches a module until apply(): browsing is the UI\'s business', async () => {
    const { c } = make();
    await c.connect();
    assert.strictEqual(writes(c).length, 0);
    assert.strictEqual(c.program, null);
    assert.strictEqual(phys(c, '2:1')[4], 'oem');
});
test('apply(solid) writes every module once with the colour and ZEIT, reports the count, then only keep-alives', async () => {
    const { c, clock } = make();
    await c.connect();
    const r = await c.apply(SOLID);
    assert.deepStrictEqual(r, { ok: true, written: 19, failed: 0, unanswered: 0, released: 0, verifying: false });
    assert.strictEqual(writes(c).length, 19);
    assert.deepStrictEqual(writes(c).find((w) => w.data[0] === 0xDA && w.data[2] === 1).data, [0xDA, 0x5E, 1, 1, 100, 254, 0, 0, 10]);
    // each bus front to back (Ambient Config's order): bus 1 starts with the passenger front door line, bus 2 with the dash
    assert.deepStrictEqual(writes(c).slice(0, 2).map((w) => w.data[2]), [3, 2]);
    assert.deepStrictEqual(writes(c).slice(7, 10).map((w) => w.data[2]).sort(), [1, 2, 3], 'the three dash lines first on bus 2');
    assert.deepStrictEqual(phys(c, '2:1'), [254, 0, 0, 100, 'custom']);
    assert.strictEqual(c.custom, true);
    await clock.advance(4000);
    assert.strictEqual(writes(c).length, 19, 'no writes while nothing changes and nothing is stale');
    await clock.advance(2000);
    assert.strictEqual(writes(c).length, 38, 'the keep-alive refreshed every module once their write was 5 s old');
    assert.strictEqual(c.stats.keepAlives, 1);
    await clock.advance(5000);
    assert.strictEqual(writes(c).length, 57);
    assert.strictEqual(phys(c, '2:1')[4], 'custom', 'never lapsed');
});
test('dual: upper and lower colours and brightness on the right modules, handles as configured', async () => {
    const { c } = make();
    await c.connect();
    const r = await c.apply(DUAL);
    assert.strictEqual(r.written, 19);
    assert.deepStrictEqual(phys(c, '2:1'), [160, 60, 254, 80, 'custom'], 'dashboard centre: upper');
    assert.deepStrictEqual(phys(c, '1:3'), [160, 60, 254, 80, 'custom'], 'door contour line: upper');
    assert.deepStrictEqual(phys(c, '2:4'), [90, 200, 254, 45, 'custom'], 'footwell: lower');
    assert.deepStrictEqual(phys(c, '1:1'), [90, 200, 254, 45, 'custom'], 'map pocket: lower');
    assert.deepStrictEqual(phys(c, '1:2'), [90, 200, 254, 45, 'custom'], 'handle: lower as configured');
    const r2 = await c.apply(Object.assign({}, DUAL, { handlesTo: 'off' }));
    assert.strictEqual(r2.released, 4, 'the four handles handed back');
    assert.strictEqual(phys(c, '1:2')[4], 'oem');
    assert.strictEqual(c.driven.size, 15);
});
test('changing one zone keeps the others: a zones program', async () => {
    const { c } = make();
    await c.connect();
    await c.apply({ mode: 'zones', assignments: [{ zone: 'all', colour: { r: 1, g: 1, b: 1 }, brightness: 50 }] });
    await c.apply({ mode: 'zones', assignments: [{ zone: 'all', colour: { r: 1, g: 1, b: 1 }, brightness: 50 }, { zone: 'footwells', colour: { r: 9, g: 9, b: 9 }, brightness: 20 }] });
    assert.deepStrictEqual(phys(c, '2:4'), [9, 9, 9, 20, 'custom']);
    assert.deepStrictEqual(phys(c, '2:1'), [1, 1, 1, 50, 'custom']);
    assert.strictEqual(writes(c).length, 19 + 19, 'the second apply forced a full round (apply always refreshes)');
});
test('restoreOem hands the whole cabin back in TWO writes (NAD 0, ZUSTAND 0, one a bus) and reports exactly what happened', async () => {
    const { c, clock } = make();
    await c.connect();
    await c.apply(SOLID);
    const r = await c.restoreOem();
    assert.deepStrictEqual(r, { ok: true, released: 19, failed: [], pending: 0, reason: undefined });
    // single colour writes (this controller's default), and still one release a bus: Ambient Config's give-back
    assert.strictEqual(writes(c).length, 19 + 2);
    const rel = writes(c).slice(-2);
    assert.deepStrictEqual(rel.map((w) => w.data), [[0xDA, 0x5E, 0, 0, 0, 0, 0, 0, 0], [0xE3, 0xD1, 0, 0, 0, 0, 0, 0, 0]], 'bus 1, then bus 2, one after the other');
    assert.strictEqual(c.stats.busReleases, 2);
    assert.ok(c.slaves.every((s) => phys(c, s.bus + ':' + s.nad)[4] === 'oem'), 'all 19 are the car\'s again');
    assert.strictEqual(phys(c, '2:1')[4], 'oem');
    assert.strictEqual(c.program, null);
    assert.strictEqual(c.driven.size, 0);
    const n = writes(c).length;
    await clock.advance(30000);
    assert.strictEqual(writes(c).length, n, 'no keep-alives after restore');
    assert.strictEqual(clock.pending(), 0, 'no timers left');
});
test('restoreOem never claims success when a release was refused', async () => {
    const { c, bdc } = make();
    await c.connect();
    await c.apply(SOLID);
    // a car that takes no NAD 0: the release falls back to one a module, and one of those is refused
    bdc.noBroadcast = true;
    bdc.rejectKeys.add('2:4');
    const r = await c.restoreOem();
    assert.strictEqual(c.broadcastOk, false);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.failed, ['2:4']);
    assert.strictEqual(r.released, 18);
    assert.ok(/lapse by themselves/.test(r.reason));
    assert.ok(c.driven.has('2:4'), 'still counted as driven');
});
test('restoreOem with the transport gone reports the modules it could not release', async () => {
    const { c } = make();
    await c.connect();
    await c.apply(SOLID);
    c.online = false;
    const r = await c.restoreOem();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.pending, 19);
    assert.strictEqual(r.failed.length, 19);
});
test('apply and restore never interleave: a restore during an apply wins and leaves the modules OEM', async () => {
    const { c, clock } = make({}, { latencyMs: 5 });
    await c.connect();
    const a = c.apply(SOLID);
    const r = c.restoreOem();
    await clock.advance(1000);
    const [ra, rr] = await Promise.all([a, r]);
    assert.strictEqual(ra.ok, true);
    assert.strictEqual(rr.ok, true);
    assert.strictEqual(c.program, null);
    assert.strictEqual(phys(c, '2:1')[4], 'oem');
    assert.strictEqual(c.driven.size, 0);
});
test('a second apply supersedes the first: the newest confirmed configuration wins', async () => {
    const { c, clock } = make({}, { latencyMs: 5 });
    await c.connect();
    const a = c.apply(SOLID);
    const b = c.apply(DUAL);
    await clock.advance(1000);
    await a; await b;
    assert.strictEqual(c.program.mode, 'dual');
    assert.deepStrictEqual(phys(c, '2:4'), [90, 200, 254, 45, 'custom']);
});
test('parking policy: strict blocks apply when the state is unknown or moving (fail closed); the mock is exempt only when told so', async () => {
    let parkedState = null;
    const { c } = make({}, { parkedPolicy: 'strict', parked: () => parkedState, kind: 'bdc-uds-like' });
    await c.connect();
    const refused = [];
    c.on('refused', (why) => refused.push(why));
    let r = await c.apply(SOLID);
    assert.strictEqual(r.ok, false); assert.ok(/unknown/.test(r.reason));
    parkedState = false;
    r = await c.apply(SOLID);
    assert.strictEqual(r.ok, false); assert.ok(/moving/.test(r.reason));
    parkedState = true;
    r = await c.apply(SOLID);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(refused.length, 2);
    assert.strictEqual(writes(c).length, 19, 'nothing was written while blocked');
});
test('animated programs tick: each frame is written out before the next is made, unchanged modules are skipped, stale ones forced', async () => {
    const { c, clock } = make({}, { latencyMs: 14, frameMs: 80 });
    await c.connect();
    const r = await applyAdv(c, clock, { mode: 'rainbow', zone: 'all' }, 400);
    assert.strictEqual(r.ok, true);
    const n0 = writes(c).length;
    await clock.advance(3000);
    assert.ok(c.stats.frames >= 8, 'frames: ' + c.stats.frames);
    assert.ok(writes(c).length > n0 + 19 * 5, 'the cabin was repainted: ' + writes(c).length);
    const col = phys(c, '2:1');
    assert.notDeepStrictEqual(col.slice(0, 3), [255, 0, 0], 'moved on from red');
    assert.strictEqual(col[4], 'custom');
    assert.ok(c.fps() > 2, 'fps ' + c.fps());
    const rp = c.restoreOem();
    await clock.advance(1000);
    const rr = await rp;
    assert.strictEqual(rr.ok, true);
    await clock.advance(1000);
    assert.strictEqual(clock.pending(), 0, 'ticker stopped');
});
test('breathing changes brightness only; a static apply after an animation stops the ticker', async () => {
    const { c, clock } = make({}, { latencyMs: 1 });
    await c.connect();
    await applyAdv(c, clock, { mode: 'breathing', top: { colour: { r: 10, g: 20, b: 30 }, brightness: 90 }, bottom: { colour: { r: 10, g: 20, b: 30 }, brightness: 90 }, zone: 'dashboard' }, 100);
    await clock.advance(1000);
    const a = phys(c, '2:1');
    await clock.advance(1000);
    const b = phys(c, '2:1');
    assert.deepStrictEqual(a.slice(0, 3), [10, 20, 30]); assert.notStrictEqual(a[3], b[3]);
    assert.strictEqual(phys(c, '1:1')[4], 'oem', 'outside the zone untouched');
    await applyAdv(c, clock, SOLID, 200);
    const f = c.stats.frames;
    await clock.advance(2000);
    assert.strictEqual(c.stats.frames, f, 'no more frames');
    assert.deepStrictEqual(phys(c, '2:1'), [254, 0, 0, 100, 'custom']);
});
test('busy and lost transport: busy is absorbed, a lost link stops control and reconnects on availability', async () => {
    const { c, clock } = make({ busyEvery: 7 }, { latencyMs: 1 });
    await c.connect();
    const r = await applyAdv(c, clock, SOLID, 3000);
    assert.strictEqual(r.written, 19, 'every module written despite busy replies');
    assert.ok(c.scheduler.stats.busy >= 2);
    c.online = false;
    const p = c.apply({ mode: 'rainbow' }).catch(() => {});
    await clock.advance(500);
    await p;
    assert.notStrictEqual(c.state, 'connected');
    c.online = true;
    c._availability(true);
    await tick(); await tick();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(c.program, null, 'nothing applied by itself after a reconnect');
});
test('every module refusing turns control off with a failure event', async () => {
    const { c, clock } = make({ rejectNrc: 0x22 }, { maxSlaveFailures: 1 });
    await c.connect();
    const failures = [];
    c.on('failure', (w) => failures.push(w));
    const r = await c.apply(SOLID);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(c.program, null);
    assert.ok(failures.length >= 1);
    await clock.advance(20000);
    assert.strictEqual(clock.pending(), 0);
});
test('status carries the applied program, transport stats and per-module state', async () => {
    const { c } = make();
    await c.connect();
    await c.apply(DUAL);
    const s = c.status();
    assert.strictEqual(s.program.mode, 'dual');
    assert.ok(/top #A03CFE 80%/.test(s.description));
    assert.strictEqual(s.driven, 19);
    assert.strictEqual(s.scheduler.accepted, 19);
    assert.strictEqual(s.slaves.filter((m) => m.driven).length, 19);
    await c.shutdown();
    assert.strictEqual(c.status().program, null);
});
test('every write the controller sends passes the allow list and never carries 0xFF in a colour byte', async () => {
    const { c, clock } = make();
    await c.connect();
    await c.apply({ mode: 'solid', colour: { r: 255, g: 255, b: 255 }, brightness: 100, zone: 'all' });
    await c.apply({ mode: 'wave' });
    await clock.advance(500);
    await c.restoreOem();
    c.bdc.requests.forEach((r) => {
        assert.strictEqual(P.checkRequest(r.target, r.sid, r.data), null, JSON.stringify(r));
        if (r.sid === 0x2E) assert.ok(r.data.slice(5, 8).every((b) => b !== 0xFF), 'FF in ' + JSON.stringify(r.data));
    });
});

module.exports = run('controller');

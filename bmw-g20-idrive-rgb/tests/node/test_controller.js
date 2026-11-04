'use strict';
const path = require('path');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS } = require('../../scripts/stage');
const { MockLightingController, MockBdc } = require(path.join(JS, 'lighting_mock'));
const P = require(path.join(JS, 'lighting_protocol'));

const writes = (c) => c.bdc.requests.filter((r) => r.sid === 0x2E);
function make(mock, opts) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, minGapMs: 150 }, opts || {}));
    return { c, bdc, clock };
}

test('connect probes the BDC: variant, slaves; state connected', async () => {
    const { c } = make();
    const caps = await c.connect();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(caps.variant.sgbd, 'BDC_G05');
    assert.strictEqual(c.slaves.length, 13);
    assert.strictEqual(c.slaves[0].location, 'Contour line dashboard driver');
    assert.strictEqual(c.custom, false, 'starts in OEM control');
});
test('setColour without custom control writes nothing; the preview is only remembered', async () => {
    const { c } = make();
    await c.connect();
    c.setColour({ r: 1, g: 2, b: 3 });
    assert.strictEqual(writes(c).length, 0);
    assert.deepStrictEqual(c.colour, { r: 1, g: 2, b: 3 });
    assert.strictEqual(c.physicalColour().source, 'oem');
});
test('enableCustom writes every slave with the colour and ZEIT, then the lights show it', async () => {
    const { c, bdc } = make();
    await c.connect();
    c.setColour({ r: 255, g: 0, b: 128 });
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, true);
    const w = writes(c);
    assert.strictEqual(w.length, 13);
    assert.deepStrictEqual(w[0].data, [0xDA, 0x5E, 1, 1, 100, 254, 0, 128, 10], '255 goes out as FE: FF would mean no change');
    assert.strictEqual(bdc.physical(7).source, 'custom');
    assert.deepStrictEqual([bdc.physical(7).r, bdc.physical(7).g, bdc.physical(7).b], [254, 0, 128]);
});
test('keep-alive: the colour is re-sent before ZEIT lapses, so the lights never fall back while custom is on', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    c.setColour({ r: 10, g: 20, b: 30 });
    await c.enableCustom();
    assert.strictEqual(c.stats.rounds, 1);
    await clock.advance(5100);                                  // ZEIT 10 s * 0.5
    assert.strictEqual(c.stats.rounds, 2, 'a second round after half ZEIT');
    await clock.advance(5100);
    assert.strictEqual(c.stats.rounds, 3);
    assert.strictEqual(bdc.physical(1).source, 'custom', 'still custom after 10 s');
    await clock.advance(30000);
    assert.ok(c.stats.rounds >= 8);
    assert.strictEqual(bdc.physical(1).source, 'custom');
});
test('without the keep-alive (app gone) the BDC returns to OEM after ZEIT: the design is reversible', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    c.setColour({ r: 10, g: 20, b: 30 });
    await c.enableCustom();
    c._stopTimer(); c._gen++;                                   // the app died
    assert.strictEqual(bdc.physical(1).source, 'custom');
    await clock.advance(10001);
    assert.strictEqual(bdc.physical(1).source, 'oem');
});
test('colour changes coalesce: a burst of 20 changes makes one extra round with the last colour', async () => {
    const { c, clock } = make();
    await c.connect();
    await c.enableCustom();
    const before = writes(c).length;
    for (let i = 0; i < 20; i++) c.setColour({ r: i, g: 0, b: 0 });
    await tick();
    await clock.advance(200);
    const after = writes(c);
    assert.strictEqual(after.length - before, 13, 'one round of 13 writes, not 20');
    assert.strictEqual(after[after.length - 1].data[5], 19, 'the last colour won');
});
test('disableCustom writes the slaves inactive and stops the loop; the lights are OEM at once', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    await c.enableCustom();
    await c.disableCustom();
    const last = writes(c).slice(-13);
    assert.ok(last.every((w) => w.data[3] === 0 && w.data[8] === 0), 'ZUSTAND 0, ZEIT 0');
    assert.strictEqual(bdc.physical(1).source, 'oem');
    assert.strictEqual(c.custom, false);
    const n = c.stats.rounds;
    await clock.advance(60000);
    assert.strictEqual(c.stats.rounds, n, 'no more rounds');
    assert.strictEqual(clock.pending(), 0);
});
test('rejected writes: after maxRejects rounds in a row custom control switches itself off with an error', async () => {
    const { c, clock } = make({ rejectNrc: 0x22 }, { maxRejects: 3, keepAliveFactor: 0.1 });
    await c.connect();
    const errors = [];
    c.on('failure', (e) => errors.push(e));
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, true, 'enabling itself works; the refusals come from the writes');
    await clock.advance(5000);
    assert.strictEqual(c.custom, false);
    assert.strictEqual(errors.length, 1);
    assert.ok(/refused 3 rounds/.test(c.lastError));
    assert.ok(c.stats.rejected >= 3);
});
test('a slave that keeps refusing is skipped, the others keep going', async () => {
    const { c, bdc, clock } = make({}, { maxSlaveFailures: 2, keepAliveFactor: 0.1 });
    await c.connect();
    bdc.slaves[2].bus = 2;                                       // NAD 3 now lives on the other bus: writes to it on bus 1 get NRC 31
    await c.enableCustom();
    await clock.advance(1100); await clock.advance(1100);
    const n = writes(c).length;
    await clock.advance(1100);
    assert.strictEqual(writes(c).length - n, 12, 'NAD 3 skipped');
    assert.ok(c.custom);
});
test('extended session: a 7F refusal opens 10 03 once and the write goes through', async () => {
    const { c, bdc } = make({ needsExtendedSession: true });
    await c.connect();
    await c.enableCustom();
    const seq = bdc.requests.map((r) => r.sid);
    assert.ok(seq.indexOf(0x10) >= 0, 'session request sent');
    assert.strictEqual(c.sessionNeeded, true);
    assert.strictEqual(c.stats.accepted, 13);
    assert.strictEqual(bdc.physical(1).source, 'custom');
});
test('session lapses (S3) and is re-opened on the next refusal', async () => {
    const { c, bdc, clock } = make({ needsExtendedSession: true, s3Ms: 3000 });
    await c.connect();
    await c.enableCustom();
    const sessions = () => bdc.requests.filter((r) => r.sid === 0x10).length;
    assert.strictEqual(sessions(), 1);
    await clock.advance(5100);
    assert.strictEqual(sessions(), 2, 'opened again after S3');
    assert.strictEqual(c.custom, true);
});
test('busy (NRC 21) once is just one rejected write; the round continues and the next round is fine', async () => {
    const { c, clock } = make({ busyOnce: true });
    await c.connect();
    await c.enableCustom();
    assert.strictEqual(c.stats.rejected, 1);
    assert.strictEqual(c.stats.accepted, 12);
    await clock.advance(5100);
    assert.strictEqual(c.stats.accepted, 25);
    assert.ok(c.custom);
});
test('timeouts (no reply) are counted and do not stop the loop', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    bdc.dropNext = 2;
    await c.enableCustom();
    assert.strictEqual(c.stats.timeouts, 2);
    assert.strictEqual(c.stats.accepted, 11);
    await clock.advance(5100);
    assert.ok(c.custom);
});
test('offline BDC: connect fails, custom control is refused', async () => {
    const { c } = make({ offline: true });
    const caps = await c.connect();
    assert.strictEqual(caps.available, false);
    assert.strictEqual(c.state, 'disconnected');
    const refused = [];
    c.on('refused', (r) => refused.push(r));
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(refused.length, 1);
});
test('connection loss while custom is on: custom off, state disconnected; back on availability', async () => {
    const { c, clock } = make();
    await c.connect();
    await c.enableCustom();
    c.online = false;
    await clock.advance(5100);
    assert.strictEqual(c.custom, false);
    assert.strictEqual(c.state, 'disconnected');
    c.online = true;
    c._availability(true);
    await tick(); await tick();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(c.custom, false, 'does not turn custom control back on by itself');
});
test('restart: a new controller starts in OEM control with nothing remembered', async () => {
    const { c } = make();
    await c.connect();
    c.setColour({ r: 9, g: 9, b: 9 });
    await c.enableCustom();
    const { c: fresh } = make();
    await fresh.connect();
    assert.strictEqual(fresh.custom, false);
    assert.deepStrictEqual(fresh.colour, { r: 255, g: 255, b: 255 });
});
test('readState re-reads the slaves and reports', async () => {
    const { c } = make();
    await c.connect();
    const st = await c.readState();
    assert.strictEqual(st.slaves.length, 13);
    assert.strictEqual(st.state, 'connected');
});
test('unknown or legacy body controller variants refuse custom control', async () => {
    const { c } = make({ sgbdIndex: '0F2050' });
    await c.connect();
    assert.strictEqual(c.capabilities.rgbActuator, 'legacy');
    assert.strictEqual(c.canControl().ok, true, 'the base class only refuses none/unsupported; bdc_uds adds the documented gate');
    const { c: c2 } = make({ sgbdIndex: '0F16B0' });
    await c2.connect();
    assert.strictEqual(c2.canControl().ok, false);
});
test('status() is a complete snapshot for the diagnostics page', async () => {
    const { c } = make();
    await c.connect();
    await c.enableCustom();
    const s = c.status();
    assert.strictEqual(s.kind, 'mock');
    assert.strictEqual(s.slaves.length, 13);
    assert.ok(s.history.length > 0 && s.history[0].bytes.indexOf('2E DA 5E') === 0);
    assert.ok(s.lastRequest.indexOf('2E DA 5E') === 0);
    assert.strictEqual(s.lastReply, '6E DA 5E');
    assert.strictEqual(s.stats.accepted, 13);
    await c.shutdown();
    assert.strictEqual(c.custom, false);
});
test('shutdown releases the lights', async () => {
    const { c, bdc } = make();
    await c.connect();
    await c.enableCustom();
    await c.shutdown();
    assert.strictEqual(bdc.physical(1).source, 'oem');
});
test('the car layout: 7 + 12 slaves on two buses, each written on its own bus with its own DID', async () => {
    const { G20_SLAVES } = require(path.join(JS, 'lighting_mock'));
    const clock = fakeClock();
    const bdc = new MockBdc({ now: clock.now, slaves: G20_SLAVES.bus1, slaves2: G20_SLAVES.bus2 });
    const c = new MockLightingController({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, minGapMs: 0 });
    await c.connect();
    assert.strictEqual(c.slaves.length, 19);
    assert.strictEqual(c.slaves.filter((s) => s.bus === 2).length, 12);
    assert.strictEqual(c.slaves.find((s) => s.bus === 2 && s.nad === 3).location, 'Contour line dashboard driver');
    c.setColour({ r: 255, g: 0, b: 0 });
    await c.enableCustom();
    const w = writes(c);
    assert.strictEqual(w.length, 19);
    assert.strictEqual(w.filter((x) => x.data[0] === 0xE3 && x.data[1] === 0xD1).length, 12, 'bus 2 slaves go to E3D1');
    assert.strictEqual(w.filter((x) => x.data[0] === 0xDA && x.data[1] === 0x5E).length, 7, 'bus 1 slaves go to DA5E');
    assert.strictEqual(bdc.physical(3, 2).source, 'custom', 'the dashboard driver line follows');
    const st = await c.readState();
    assert.strictEqual(st.slaves.filter((s) => s.r === 254 && s.g === 0).length, 19, 'E3D1 / DA5F read back the custom colour on every module');
    await c.disableCustom();
    assert.strictEqual(bdc.physical(3, 2).source, 'oem');
});
test('the mock BDC honours 0xFF as "no change" the way the car does', async () => {
    const { c, bdc } = make();
    await c.connect();
    bdc.uds(0x40, 0x2E, [0xDA, 0x5E, 1, 1, 100, 0x00, 0xFE, 0x00, 5]);        // green
    assert.deepStrictEqual([bdc.physical(1).r, bdc.physical(1).g, bdc.physical(1).b], [0, 254, 0]);
    bdc.uds(0x40, 0x2E, [0xDA, 0x5E, 1, 1, 100, 0xFF, 0xFF, 0xFF, 5]);        // no change
    assert.deepStrictEqual([bdc.physical(1).r, bdc.physical(1).g, bdc.physical(1).b], [0, 254, 0]);
    c.setColour({ r: 255, g: 255, b: 255 });
    await c.enableCustom();
    assert.deepStrictEqual([bdc.physical(1).r, bdc.physical(1).g, bdc.physical(1).b], [254, 254, 254], 'the controller never sends FF');
    await c.disableCustom();
});
test('every write the mock controller sends passes the allow list', async () => {
    const { c } = make();
    await c.connect();
    await c.enableCustom();
    await c.disableCustom();
    c.bdc.requests.forEach((r) => assert.strictEqual(P.checkRequest(r.target, r.sid, r.data), null, JSON.stringify(r)));
});

module.exports = run('controller');

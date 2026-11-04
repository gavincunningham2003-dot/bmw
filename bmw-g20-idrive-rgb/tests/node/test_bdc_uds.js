'use strict';
const path = require('path');
const { test, run, assert, tick } = require('./t');
const { JS } = require('../../scripts/stage');
const { bus } = require('./fake_tasu');
const { MockBdc, DEFAULT_SLAVES } = require(path.join(JS, 'lighting_mock'));
const { BdcUdsLightingController } = require(path.join(JS, 'lighting_bdc_uds'));
const P = require(path.join(JS, 'lighting_protocol'));

const FOREIGN = [0x62, 0xF4, 0x0C, 0x0B, 0xB8];   // another app's coolant read of the DME, on the same transport
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(mock, opts, busOpts) {
    const bdc = new MockBdc(Object.assign({ slaves: DEFAULT_SLAVES, slaves2: [] }, mock || {}));
    const b = bus(JS, bdc, Object.assign({ foreign: [FOREIGN] }, busOpts || {}));
    const c = new BdcUdsLightingController(Object.assign({ diag: b.diag, diagModule: b.diagModule, refreshSeconds: 10, minGapMs: 0, timeoutMs: 300, fadeMs: 0 }, opts || {}));
    return { c, bdc, b };
}
const writes = (bdc) => bdc.requests.filter((r) => r.sid === 0x2E);

test('probe over the (fake) TASU link: SGBD index, SVK, slaves from DA5F, PWM; foreign frames ignored', async () => {
    const { c, bdc } = make();
    await c.init();
    const caps = await c.connect();
    assert.strictEqual(c.state, 'connected');
    assert.strictEqual(caps.transport, 'tasu');
    assert.strictEqual(caps.variant.index, '0F2680');
    assert.strictEqual(caps.rgbActuator, 'verified');
    assert.strictEqual(caps.slaves.length, 13);
    assert.ok(caps.svk.some((r) => r.type === 'BTLD'));
    assert.strictEqual(caps.pwm.length, 13);
    assert.strictEqual(c.slavesFromCar, true);
    bdc.requests.forEach((r) => assert.strictEqual(r.target, 0x40));
    bdc.requests.forEach((r) => assert.strictEqual(r.sid, 0x22, 'probe only reads'));
});
test('not armed: enabling custom control sends DRY RUNS only; nothing with 2E reaches the transport', async () => {
    const { c, bdc, b } = make({}, { armed: false });
    await c.init(); await c.connect();
    c.setColour({ r: 1, g: 2, b: 3 });
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(writes(bdc).length, 0);
    assert.strictEqual(b.sent.filter((s) => s.sid === 0x2E).length, 0);
    assert.strictEqual(c.dryRuns, 13);
    assert.ok(c.status().history[0].bytes.indexOf('2E DA 5E') === 0, 'the bytes are logged');
    await c.disableCustom();
    assert.strictEqual(writes(bdc).length, 0);
});
test('armed: the exact bytes go to 0x40 and the (simulated) lights change', async () => {
    const { c, bdc } = make({}, { armed: true });
    await c.init(); await c.connect();
    c.setColour({ r: 0xD7, g: 0x6E, b: 0x14 });
    await c.enableCustom();
    const w = writes(bdc);
    assert.strictEqual(w.length, 13);
    assert.deepStrictEqual(w[0], { target: 0x40, sid: 0x2E, data: [0xDA, 0x5E, 1, 1, 100, 0xD7, 0x6E, 0x14, 10] });
    assert.strictEqual(bdc.physical(1).source, 'custom');
    assert.strictEqual(c.lastReply, '6E DA 5E');
    await c.disableCustom();
    assert.strictEqual(bdc.physical(1).source, 'oem');
});
test('ZEIT is capped at maxSeconds even if the setting asks for more', async () => {
    const { c, bdc } = make({}, { armed: true, refreshSeconds: 120, maxSeconds: 30 });
    await c.init(); await c.connect();
    await c.enableCustom();
    assert.strictEqual(writes(bdc)[0].data[8], 30);
    await c.disableCustom();
});
test('an undocumented body controller variant blocks writes unless allowUnknownVariant', async () => {
    const { c, bdc } = make({ sgbdIndex: '0F2050' }, { armed: true });
    await c.init(); await c.connect();
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, false);
    assert.ok(/not documented/.test(r.reason));
    assert.strictEqual(writes(bdc).length, 0);
    const { c: c2, bdc: bdc2 } = make({ sgbdIndex: '0F2050' }, { armed: true, allowUnknownVariant: true });
    await c2.init(); await c2.connect();
    assert.strictEqual((await c2.enableCustom()).ok, true);
    assert.ok(writes(bdc2).length > 0);
    await c2.disableCustom();
});
test('no slaves from the car: refused', async () => {
    const bdc = new MockBdc({ slaves: DEFAULT_SLAVES, slaves2: [] });
    const real = bdc.uds.bind(bdc);
    bdc.uds = (t, sid, d) => (sid === 0x22 && d[0] === 0xDA && d[1] === 0x5F ? [0x7F, 0x22, 0x31] : real(t, sid, d));
    const b = bus(JS, bdc, {});
    const c = new BdcUdsLightingController({ diag: b.diag, diagModule: b.diagModule, armed: true, minGapMs: 0, timeoutMs: 300, fadeMs: 0 });
    await c.init(); await c.connect();
    assert.strictEqual(c.state, 'connected');
    const r = await c.enableCustom();
    assert.strictEqual(r.ok, false);
    assert.ok(/no RGB LIN slaves|slave list/.test(r.reason));
});
test('session: a 7F from the BDC opens 10 03 once, then the write is accepted', async () => {
    const { c, bdc } = make({ needsExtendedSession: true }, { armed: true });
    await c.init(); await c.connect();
    await c.enableCustom();
    assert.strictEqual(bdc.requests.filter((r) => r.sid === 0x10).length, 1);
    assert.deepStrictEqual(bdc.requests.find((r) => r.sid === 0x10).data, [0x03]);
    assert.strictEqual(c.stats.accepted, 13);
    await c.disableCustom();
});
test('transport away: probe reports unavailable; back: reconnects by itself', async () => {
    const { c, b } = make({}, { armed: true }, { available: false });
    await c.init();
    const caps = await c.connect();
    assert.strictEqual(caps.available, false);
    assert.strictEqual(c.state, 'disconnected');
    b.setAvailable(true);
    await sleep(80);
    assert.strictEqual(c.state, 'connected');
});
test('transport lost mid-session: custom control off, state disconnected, no further writes', async () => {
    const { c, bdc, b } = make({}, { armed: true, keepAliveFactor: 0.02 });
    await c.init(); await c.connect();
    await c.enableCustom();
    const n = writes(bdc).length;
    b.setAvailable(false);
    await sleep(300);
    assert.strictEqual(c.custom, false);
    assert.strictEqual(c.state, 'disconnected');
    assert.strictEqual(writes(bdc).length, n);
});
test('a timeout (no reply) is a counted miss, not a crash', async () => {
    const { c, bdc } = make({}, { armed: true, timeoutMs: 60 });
    await c.init(); await c.connect();
    bdc.dropNext = 1;
    await c.enableCustom();
    assert.strictEqual(c.stats.timeouts, 1);
    assert.strictEqual(c.stats.accepted, 12);
    await c.disableCustom();
});
test('the gate: nothing but 22 / 2E DA5E|E3D1 / 10 03 to 0x40 can leave, whatever the caller asks', async () => {
    const { c, b } = make({}, { armed: true });
    await c.init(); await c.connect();
    assert.ok((await c._request(0x14, [0xFF, 0xFF, 0xFF])).blocked, 'clear faults');
    assert.ok((await c._request(0x2E, [0x36, 0x0A, 1, 2, 3, 4, 5, 6, 7])).blocked, 'coding data');
    assert.ok((await c._request(0x31, [0x01, 0xA6, 0x21])).blocked, 'routine');
    assert.ok((await c._request(0x2F, [0x48, 0x00, 3, 50])).blocked, 'io control');
    assert.ok((await c._request(0x10, [0x02])).blocked, 'programming session');
    assert.strictEqual(b.sent.filter((s) => [0x14, 0x31, 0x2F].indexOf(s.sid) >= 0).length, 0);
    assert.strictEqual(b.sent.filter((s) => s.sid === 0x10).length, 0);
});
test('every byte sent in a full session passes the allow list and targets the BDC', async () => {
    const { c, b } = make({ needsExtendedSession: true }, { armed: true });
    await c.init(); await c.connect();
    await c.enableCustom(); await c.restoreOem();
    b.sent.forEach((s) => assert.strictEqual(P.checkRequest(s.target, s.sid, s.data), null, JSON.stringify(s)));
    b.sent.forEach((s) => assert.strictEqual(s.target, 0x40));
});

module.exports = run('bdc_uds');

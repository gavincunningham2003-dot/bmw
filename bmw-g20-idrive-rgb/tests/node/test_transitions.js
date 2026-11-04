'use strict';
const path = require('path');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS } = require('../../scripts/stage');
const { MockLightingController, MockBdc, G20_SLAVES } = require(path.join(JS, 'lighting_mock'));
const { ZONES } = require(path.join(JS, 'lighting_protocol'));

const writes = (x) => (x.bdc ? x.bdc : x).requests.filter((r) => r.sid === 0x2E);
function make(opts, mock) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));          // the car's 19 modules by default
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, minGapMs: 60, fadeMs: 0 }, opts || {}));
    return { c, bdc, clock };
}
const phys = (bdc, bus, nad) => { const p = bdc.physical(nad, bus); return [p.r, p.g, p.b]; };

test('the mock defaults to the car: 19 modules, 7 on bus 1 and 12 on bus 2', async () => {
    const { c } = make();
    await c.connect();
    assert.strictEqual(c.slaves.length, 19);
    assert.strictEqual(c.slaves.filter((s) => s.bus === 1).length, G20_SLAVES.bus1.length);
});
test('fade 0: one round, the lights jump', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    await c.enableCustom();
    const n = writes(bdc).length;
    c.setColour({ r: 200, g: 0, b: 0 }, { fadeMs: 0 });
    await tick(); await clock.advance(100);
    assert.strictEqual(writes(bdc).length - n, 19, 'one round');
    assert.deepStrictEqual(phys(bdc, 1, 1), [200, 0, 0]);
    assert.strictEqual(c.status().fading, false);
});
test('fade: the lights glide from the old colour to the new one over the fade time, round after round', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    c.setColour({ r: 0, g: 0, b: 254 });
    await c.enableCustom();
    c.setColour({ r: 254, g: 0, b: 0 }, { fadeMs: 1000 });
    await tick();
    const seen = [];
    for (let i = 0; i < 12; i++) { await clock.advance(100); seen.push(phys(bdc, 2, 3)); }
    assert.deepStrictEqual(seen[seen.length - 1], [254, 0, 0], 'ends on the target');
    const reds = seen.map((x) => x[0]), blues = seen.map((x) => x[2]);
    for (let i = 1; i < reds.length; i++) { assert.ok(reds[i] >= reds[i - 1], 'red rises: ' + reds); assert.ok(blues[i] <= blues[i - 1], 'blue falls: ' + blues); }
    assert.ok(reds[3] > 30 && reds[3] < 230, 'in between on the way: ' + reds);
    assert.ok(c.stats.rounds >= 8, 'many rounds during the fade: ' + c.stats.rounds);
    assert.strictEqual(c.status().fading, false, 'done');
    const n = c.stats.rounds;
    await clock.advance(3000);
    assert.strictEqual(c.stats.rounds, n, 'no rounds until the keep-alive once the fade is over');
    await clock.advance(2500);
    assert.strictEqual(c.stats.rounds, n + 1, 'the keep-alive round');
});
test('a new colour during a fade starts from where the lights are, not from the old target', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    c.setColour({ r: 0, g: 0, b: 254 });
    await c.enableCustom();
    c.setColour({ r: 254, g: 0, b: 0 }, { fadeMs: 1000 });
    await tick(); await clock.advance(400);
    const mid = phys(bdc, 1, 1);
    assert.ok(mid[0] > 50 && mid[2] > 50, 'mid-fade: ' + mid);
    c.setColour({ r: 0, g: 254, b: 0 }, { fadeMs: 1000 });
    await tick(); await clock.advance(70);
    const next = phys(bdc, 1, 1);
    assert.ok(Math.abs(next[0] - mid[0]) < 60 && Math.abs(next[2] - mid[2]) < 60, 'continues from the mid colour: ' + next + ' vs ' + mid);
    await clock.advance(1200);
    assert.deepStrictEqual(phys(bdc, 1, 1), [0, 254, 0]);
});
test('rainbow: the hue turns at the set rate, every round, until static is chosen again', async () => {
    const { c, bdc, clock } = make({ rainbowPeriodS: 10 });
    await c.connect();
    await c.enableCustom();
    c.setMode('rainbow');
    await tick(); await clock.advance(100);
    const a = phys(bdc, 2, 1);
    await clock.advance(2500);                       // a quarter turn
    const b = phys(bdc, 2, 1);
    assert.notDeepStrictEqual(a, b, 'the colour moved');
    assert.ok(c.stats.rounds > 20, 'rounds kept coming: ' + c.stats.rounds);
    assert.strictEqual(c.status().mode, 'rainbow');
    c.setColour({ r: 10, g: 10, b: 10 }, { fadeMs: 0 });
    assert.strictEqual(c.mode, 'static', 'picking a colour ends the rainbow');
    await tick(); await clock.advance(100);
    assert.deepStrictEqual(phys(bdc, 2, 1), [10, 10, 10]);
    const n = c.stats.rounds;
    await clock.advance(2000);
    assert.strictEqual(c.stats.rounds, n, 'static: no rounds between keep-alives');
});
test('zones: only the zone is driven; the rest is released once and left to OEM; back to all re-drives everything', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    c.setZone('dash', ZONES.dash);
    assert.strictEqual(c.selected().length, 3);
    c.setColour({ r: 0, g: 254, b: 0 });
    await c.enableCustom();
    assert.strictEqual(writes(bdc).length, 3, 'only the three dashboard lines');
    assert.deepStrictEqual(phys(bdc, 2, 1), [0, 254, 0]);
    assert.strictEqual(bdc.physical(1, 1).source, 'oem', 'a door module untouched');   // (nad, bus)
    c.setZone('footwells', ZONES.footwells);
    await tick(); await clock.advance(100);
    const w = writes(bdc);
    const released = w.filter((x) => x.data[3] === 0);
    assert.strictEqual(released.length, 3, 'the dashboard lines released once');
    assert.strictEqual(bdc.physical(1, 2).source, 'oem', 'dashboard centre handed back');
    assert.strictEqual(c.selected().length, 4);
    assert.strictEqual(bdc.physical(4, 2).source, 'custom', 'a footwell driven');
    await clock.advance(5000);
    assert.strictEqual(w.length + 4 <= writes(bdc).length, true, 'the keep-alive drives the zone only');
    assert.strictEqual(writes(bdc).filter((x) => x.data[3] === 0).length, 3, 'no repeated releases');
    c.setZone('all', null);
    await tick(); await clock.advance(100);
    assert.strictEqual(bdc.physical(1, 2).source, 'custom', 'everything driven again');
    await c.disableCustom();
    assert.strictEqual(bdc.physical(4, 2).source, 'oem');
});
test('keep-alive with a slow transport: the next round starts before any module can lapse', async () => {
    const clock = fakeClock();
    let extra = 0;                                                // the controller's clock runs ahead by 100 ms per write
    const bdc = new MockBdc({ now: () => clock.now() + extra });
    const c = new MockLightingController({ bdc, now: () => clock.now() + extra, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 6, minGapMs: 60, fadeMs: 0 });
    const real = c._writeSlave.bind(c);
    c._writeSlave = async (s, p) => { extra += 100; return real(s, p); };     // 100 ms per write: a 1.9 s round
    await c.connect();
    await c.enableCustom();
    assert.ok(c.stats.lastRoundMs >= 1800, 'the round took ' + c.stats.lastRoundMs);
    await clock.advance(1050);                                   // keep-alive is due at 6 s * 0.5 - 1.9 s = 1.1 s
    assert.strictEqual(c.stats.rounds, 1);
    assert.strictEqual(c._busy, false, 'not yet');
    await clock.advance(2100);                                   // the second round starts at 1.1 s and takes 1.9 s
    assert.ok(c.stats.rounds >= 2, 'the second round ran (' + c.stats.rounds + ')');
    for (const s of bdc.slaves) assert.strictEqual(bdc.physical(s.nad, s.bus).source, 'custom', 'still driven: ' + s.nad);
});
test('status carries mode, zone, fade and round timing for the diagnostics page', async () => {
    const { c } = make({ fadeMs: 300 });
    await c.connect();
    await c.enableCustom();
    const s = c.status();
    assert.strictEqual(s.mode, 'static'); assert.strictEqual(s.zone, 'all'); assert.strictEqual(s.selected, 19);
    assert.strictEqual(s.fadeMs, 300); assert.ok(typeof s.stats.avgRoundMs === 'number');
    assert.deepStrictEqual(s.driven, { r: 255, g: 255, b: 255 });
    await c.disableCustom();
    assert.strictEqual(c.status().driven, null);
});

module.exports = run('transitions');

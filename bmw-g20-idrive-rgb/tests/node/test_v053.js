'use strict';
/* 0.5.3: two write methods and one writer (still colours targeted, animated modes whole-bus), the modes take the
 * car's active colours, the selectors open at 100 %, and the Modes page shows the cabin moving as the mode would. */
const fs = require('fs');
const path = require('path');
const { test, run, assert, fakeClock } = require('./t');
const { JS } = require('../../scripts/stage');
const { MockLightingController, MockBdc } = require(path.join(JS, 'lighting_mock'));
const S = require(path.join(JS, 'lighting_scene'));
const A = require(path.join(JS, 'active_colours'));
const { ModePreview, REST_MS } = require(path.join(JS, 'lighting_preview'));
const { harness } = require('./ui_harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writes = (bdc) => bdc.requests.filter((r) => r.sid === 0x2E);
const reads = (bdc) => bdc.requests.filter((r) => r.sid === 0x22);
const keyOf = (r) => (r.data[0] === 0xDA ? 1 : 2) + ':' + r.data[2];
const whole = (r) => r.data[2] === 0 && r.data[3] === 1;                 // a colour to NAD 0 (not a release)
const phys = (c, key) => { const p = c.physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
function make(mock, opts) {
    const clock = fakeClock();
    const bdc = new MockBdc(Object.assign({ now: clock.now }, mock || {}));
    const c = new MockLightingController(Object.assign({ bdc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, refreshSeconds: 10, parkedPolicy: 'lenient', txMode: 'broadcast' }, opts || {}));
    return { c, bdc, clock };
}
const RED = { r: 254, g: 0, b: 0 }, GREEN = { r: 0, g: 254, b: 0 }, BLUE = { r: 0, g: 0, b: 254 };
const solid = (colour, brightness) => ({ mode: 'solid', colour, brightness: brightness == null ? 100 : brightness, zone: 'all' });
const dual = (top, bottom, tb, bb) => ({ mode: 'dual', top: { colour: top, brightness: tb == null ? 80 : tb }, bottom: { colour: bottom, brightness: bb == null ? 40 : bb }, handlesTo: 'bottom' });
const groupKeys = (c, g) => c.slaves.filter((s) => S.groupOf(s, 'bottom') === g).map(S.key).sort();

/* ================= 1. the two write methods ================= */
test('Single Colour: targeted writes only, with whole-bus writes switched on; no animation writer is started', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    const r = await c.apply(solid(BLUE));
    assert.deepStrictEqual([r.ok, r.written, r.failed], [true, 19, 0]);
    assert.strictEqual(c.writer(), 'targeted');
    assert.strictEqual(c.status().writeMode, 'individual');
    assert.deepStrictEqual(writes(bdc).map(keyOf).sort(), c.slaves.map(S.key).sort(), 'each of the 19 modules once, at its own address');
    assert.strictEqual(c._ticker, null, 'no frame loop');
    assert.ok(c._keepTimer, 'the keep-alive holds it');
    await clock.advance(60000);
    assert.strictEqual(c.stats.frames, 0, 'not one frame in a minute');
    assert.strictEqual(c.stats.broadcasts, 0);
    assert.ok(writes(bdc).every((w) => w.data[2] !== 0), 'the keep-alives are targeted too');
    assert.ok(c.slaves.every((s) => phys(c, S.key(s))[4] === 'custom'), 'never lapsed');
    await c.restoreOem();
});
test('Dual Colour: both groups get their own colour; changing one writes that group only; applying the same again writes nothing', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    await c.apply(dual(RED, BLUE));
    groupKeys(c, 'top').forEach((k) => assert.deepStrictEqual(phys(c, k), [254, 0, 0, 80, 'custom'], k));
    groupKeys(c, 'bottom').forEach((k) => assert.deepStrictEqual(phys(c, k), [0, 0, 254, 40, 'custom'], k));
    assert.strictEqual(writes(bdc).length, 19);
    // the upper colour changes
    let n = writes(bdc).length;
    await c.apply(dual(GREEN, BLUE));
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf).sort(), groupKeys(c, 'top'), 'the upper modules, and no other');
    groupKeys(c, 'bottom').forEach((k) => assert.deepStrictEqual(phys(c, k), [0, 0, 254, 40, 'custom'], k + ' untouched'));
    // the lower brightness changes
    n = writes(bdc).length;
    await c.apply(dual(GREEN, BLUE, 80, 15));
    assert.deepStrictEqual(writes(bdc).slice(n).map(keyOf).sort(), groupKeys(c, 'bottom'), 'the lower modules, and no other');
    // nothing changes
    n = writes(bdc).length;
    const r = await c.apply(dual(GREEN, BLUE, 80, 15));
    assert.deepStrictEqual([r.ok, r.written], [true, 19]);
    assert.strictEqual(writes(bdc).length, n, 'an unchanged Apply sends nothing');
    // ... unless a module is due for renewal anyway: then the Apply carries it
    await clock.advance(2000);
    const before = writes(bdc).length;
    c._stopKeepAlive();
    await clock.advance(4000);                                 // every write is now older than half its hold
    await c.apply(dual(GREEN, BLUE, 80, 15));
    assert.strictEqual(writes(bdc).length - before, 19, 'due modules are renewed by the Apply');
    assert.ok(writes(bdc).every((w) => w.data[2] !== 0));
    await c.restoreOem();
});
test('every animated mode still goes out with whole-bus writes, frame after frame', async () => {
    for (const mode of ['rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse']) {
        const { c, bdc, clock } = make();
        await c.connect();
        const r = await c.apply({ mode });
        assert.strictEqual(r.ok, true, mode);
        assert.strictEqual(c.writer(), 'bus', mode);
        assert.strictEqual(c.status().writeMode, 'broadcast', mode);
        assert.deepStrictEqual(writes(bdc).filter(whole).map(keyOf).slice(0, 2), ['1:0', '2:0'], mode + ': the first frame is a whole-bus write on each bus');
        const n = writes(bdc).filter(whole).length;
        await clock.advance(1500);
        if (S.RUNNING[mode]) assert.ok(writes(bdc).filter(whole).length > n, mode + ': and so are the frames after it');
        assert.strictEqual(c._keepTimer, null, mode + ': no keep-alive beside the frames');
        await c.restoreOem();
    }
});

/* ================= 2. one writer at a time ================= */
test('from an animation to a still colour: the frame loop stops first, every module is written directly, and no whole-bus write follows', async () => {
    const { c, bdc, clock } = make({}, { latencyMs: 20 });
    await c.connect();
    const first = c.apply({ mode: 'wave' });
    await clock.advance(3000);
    await first;
    assert.ok(writes(bdc).filter(whole).length > 4, 'the wave is running on whole-bus writes');
    // Apply lands while a frame is on its way out
    const ap = c.apply(solid(RED));
    await clock.advance(1000);
    const r = await ap;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(c.writer(), 'targeted');
    assert.strictEqual(c._ticker, null);
    const all = writes(bdc), lastWhole = all.map(whole).lastIndexOf(true);
    const after = all.slice(lastWhole + 1);
    assert.deepStrictEqual(after.map(keyOf).sort(), c.slaves.map(S.key).sort(), 'after the last frame write: all 19 modules, each once, directly');
    c.slaves.forEach((s) => assert.deepStrictEqual(phys(c, S.key(s)), [254, 0, 0, 100, 'custom']));
    const frames = c.stats.frames, n = all.length;
    await clock.advance(30000);
    assert.strictEqual(c.stats.frames, frames, 'the animation writer is gone');
    assert.ok(writes(bdc).slice(n).length > 0 && writes(bdc).slice(n).every((w) => w.data[2] !== 0), 'only targeted keep-alives from here');
    assert.strictEqual(writes(bdc).slice(n)[0].data[8], 10, 'at the still colour\'s own hold time');
    const back = c.restoreOem();
    await clock.advance(500);
    assert.strictEqual((await back).ok, true);
});
test('from a still colour to an animation: the keep-alive stops, the frames take over, and the two are never live together', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    await c.apply(dual(RED, BLUE));
    assert.ok(c._keepTimer && !c._ticker);
    await c.apply({ mode: 'rainbow' });
    assert.strictEqual(c.writer(), 'bus');
    assert.strictEqual(c._keepTimer, null, 'the still colour\'s keep-alive was cancelled');
    for (let i = 0; i < 40; i++) {
        await clock.advance(250);
        assert.ok(!(c._keepTimer && c._ticker), 'never both timers');
        assert.strictEqual(c.scheduler.status().maxInFlight, 1);
    }
    assert.ok(c.stats.framesWritten > 2);
    await c.apply(solid(GREEN));
    for (let i = 0; i < 40; i++) { await clock.advance(250); assert.strictEqual(c._ticker, null); }
    await c.restoreOem();
    assert.strictEqual(c.writer(), null);
    assert.strictEqual(clock.pending() <= 1, true, 'nothing left running but the one read-back after the handback');
});
test('handing back is the factory release for both: two whole-bus releases after a still colour and after an animation', async () => {
    for (const p of [solid(BLUE), dual(RED, BLUE), { mode: 'breathing' }]) {
        const { c, bdc } = make();
        await c.connect();
        await c.apply(p);
        const n = writes(bdc).length;
        const r = await c.restoreOem();
        assert.deepStrictEqual([r.ok, r.released], [true, 19], p.mode);
        assert.deepStrictEqual(writes(bdc).slice(n).map((w) => [keyOf(w), w.data[3]]), [['1:0', 0], ['2:0', 0]], p.mode);
        assert.ok(c.slaves.every((s) => phys(c, S.key(s))[4] === 'oem'), p.mode);
    }
});

/* ================= 3. the car's active colours ================= */
test('activeLook: applied first, then what the car reported, then the last applied; never anything else', () => {
    const { c } = make();
    return c.connect().then(() => {
        const mods = c.slaves, look = (o) => A.activeLook(Object.assign({ modules: mods, handlesTo: 'bottom' }, o));
        const side = (colour, brightness) => ({ colour, brightness });
        // applied
        assert.deepStrictEqual(look({ program: solid(RED, 60) }), { top: side(RED, 60), bottom: side(RED, 60), source: 'applied' });
        assert.deepStrictEqual(look({ program: dual(RED, BLUE, 80, 40) }), { top: side(RED, 80), bottom: side(BLUE, 40), source: 'applied' });
        assert.deepStrictEqual(look({ program: { mode: 'wave', top: side(GREEN, 70), bottom: side(BLUE, 30) } }), { top: side(GREEN, 70), bottom: side(BLUE, 30), source: 'applied' });
        assert.deepStrictEqual(look({ program: { mode: 'welcome', then: dual(RED, BLUE, 80, 40) } }), { top: side(RED, 80), bottom: side(BLUE, 40), source: 'applied' }, 'a one-time effect counts as what it ends on');
        assert.deepStrictEqual(look({ program: { mode: 'solid', colour: GREEN, brightness: 50, zone: 'footwells' } }), { top: side(GREEN, 50), bottom: side(GREEN, 50), source: 'applied' }, 'a zone of one group still gives both');
        assert.deepStrictEqual(look({ program: { mode: 'zones', handlesTo: 'bottom', assignments: [{ zone: 'upper', colour: RED, brightness: 90 }, { zone: 'lower', colour: BLUE, brightness: 20 }, { zone: 'module:2:4', colour: GREEN, brightness: 5 }] } }), { top: side(RED, 90), bottom: side(BLUE, 20), source: 'applied' }, 'zones: the colour most modules of a group show');
        // the applied program wins over a read and over the last one
        const live = mods.map((m) => ({ bus: m.bus, nad: m.nad, r: 1, g: 2, b: 3, brightness: 100 }));
        assert.strictEqual(look({ program: solid(RED), live, last: solid(GREEN) }).source, 'applied');
        // nothing applied: the car's own colours as read
        assert.deepStrictEqual(look({ program: null, live, last: solid(GREEN) }), { top: side({ r: 1, g: 2, b: 3 }, 100), bottom: side({ r: 1, g: 2, b: 3 }, 100), source: 'car' });
        // a read that shows nothing lit is not a colour
        const dark = mods.map((m) => ({ bus: m.bus, nad: m.nad, r: 0, g: 0, b: 0, brightness: 0 }));
        assert.deepStrictEqual(look({ program: null, live: dark, last: solid(GREEN, 30) }), { top: side(GREEN, 30), bottom: side(GREEN, 30), source: 'last' });
        assert.strictEqual(look({ program: null, live: null, last: null }), null, 'nothing known: nothing claimed');
    });
});
test('the controller knows the car\'s own colours only from a read that is newer than its last write', async () => {
    const { c, bdc, clock } = make();
    await c.connect();
    const car = c.liveColours();
    assert.strictEqual(car.length, 19, 'the probe read every module');
    assert.deepStrictEqual([car[0].r, car[0].g, car[0].b, car[0].brightness], [0x90, 0xE0, 0x90, 100], 'the factory colour (the simulated car\'s)');
    const n = reads(bdc).length;
    assert.strictEqual(c.liveColours().length, 19);
    assert.strictEqual(reads(bdc).length, n, 'asking costs no request');
    await c.apply(solid(RED));
    assert.strictEqual(c.liveColours(), null, 'ours is on: a read would show our colour, not the car\'s');
    await c.restoreOem();
    assert.strictEqual(c.liveColours(), null, 'handed back, but not read since');
    await clock.advance(1600);                                 // the one read-back after a handback
    const again = c.liveColours();
    assert.deepStrictEqual([again.length, again[0].r, again[0].g, again[0].b], [19, 0x90, 0xE0, 0x90], 'read after the release: the car\'s own again');
});
test('the Modes page: every mode takes the active colours when it is picked; an unsent draft is never taken; picking others is possible and Apply makes them active', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    const ctl = h.app.ctl(), d = h.app.draft;
    const side = (colour, brightness) => ({ colour, brightness });
    // nothing applied yet: the car's own colour, as the probe read it
    h.tab(2); await h.frame();
    assert.strictEqual(h.app.look().source, 'car');
    await h.press('mode:fade');
    assert.deepStrictEqual(d.modes.params.fade.top, side({ r: 0x90, g: 0xE0, b: 0x90 }, 100));
    // Dual applied: the modes that take two colours take both, Solid takes the upper one
    assert.ok((await h.app.svc.apply(dual(RED, BLUE, 80, 40))).ok);
    h.tab(0); h.tab(2); await h.frame();
    for (const m of ['rainbow', 'fade', 'breathing', 'wave']) {
        await h.press('mode:' + m); await h.frame();
        assert.deepStrictEqual([d.modes.params[m].top, d.modes.params[m].bottom], [side(RED, 80), side(BLUE, 40)], m);
        assert.deepStrictEqual(S.normalise(h.app.modesProgram()).top, side(RED, 80), m + ': what Apply would send');
    }
    await h.press('mode:solid');
    assert.deepStrictEqual([d.modes.params.solid.colour, d.modes.params.solid.brightness], [RED, 80]);
    // a colour picked on the wheel and NOT applied is not the car's colour
    const w = ctl.scheduler.stats.writes, applied = JSON.stringify(ctl.program);
    h.tab(0); await h.frame();
    h.tap(640, 98 + 304);                                      // the bottom of the hue ring: hue 180
    assert.strictEqual(Math.round(d.colours.hsv.h), 180);
    assert.strictEqual(h.app.dirty().colours, true);
    h.tab(2); await h.frame();
    await h.press('mode:wave'); await h.frame();
    assert.deepStrictEqual(d.modes.params.wave.top, side(RED, 80), 'still the applied colour');
    assert.ok(h.targets().every((t) => t.key !== 'useactive'), 'nothing to go back to: it already follows the car');
    // the driver may pick others on the page: they stay through page changes ...
    await h.press('usecol'); await h.frame();
    assert.deepStrictEqual(d.modes.params.wave.top, side({ r: 0, g: 255, b: 255 }, 100));
    h.tab(1); h.tab(2); await h.frame();
    await h.press('mode:fade'); await h.press('mode:wave'); await h.frame();
    assert.deepStrictEqual(d.modes.params.wave.top, side({ r: 0, g: 255, b: 255 }, 100), 'not reset by switching pages or modes');
    assert.deepStrictEqual(d.modes.params.fade.top, side(RED, 80), 'the other modes keep following the car');
    // ... and "Use active" drops them
    await h.press('useactive'); await h.frame();
    assert.deepStrictEqual(d.modes.params.wave.top, side(RED, 80));
    assert.strictEqual(ctl.scheduler.stats.writes, w, 'none of this wrote to the car');
    assert.strictEqual(JSON.stringify(ctl.program), applied, 'and the applied lighting is what it was');
    // picked and applied: now they ARE the active colours, for every mode
    await h.press('usecol'); await h.frame();
    await h.press('apply'); await sleep(60);
    assert.strictEqual(ctl.program.mode, 'wave');
    assert.deepStrictEqual(ctl.program.top, side({ r: 0, g: 255, b: 255 }, 100));
    await h.frame(); await h.press('mode:breathing');
    assert.deepStrictEqual(d.modes.params.breathing.top, side({ r: 0, g: 255, b: 255 }, 100));
    await h.app.svc.stop();
});
test('the colour wheel does not touch a running mode: turning and tapping change the draft only', async () => {
    const h = await harness({ sets: { backend: 'mock', confirmApplies: 'off' } });
    assert.ok((await h.app.svc.apply({ mode: 'rainbow', top: { colour: RED, brightness: 90 }, bottom: { colour: BLUE, brightness: 90 } })).ok);
    const ctl = h.app.ctl(), applied = JSON.stringify(ctl.program), phase0 = ctl.phase0;
    h.tab(0); await h.frame();
    h.tap(640, 98); h.tap(640, 402);
    await h.press('wheel');
    h.knob({ frontRotaryEncoderOperation: 100, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 120, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 120, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });
    h.tab(1); await h.frame(); h.tap(210, 155);
    await sleep(120);
    assert.strictEqual(JSON.stringify(ctl.program), applied, 'the rainbow is the rainbow it was');
    assert.strictEqual(ctl.phase0, phase0, 'and was not restarted');
    assert.strictEqual(ctl.writer(), 'bus');
    await h.app.svc.stop();
});
test('Welcome and Pulse with nothing applied run in the car\'s colour and hand the cabin back; an unsent draft is not what they end on', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    h.tab(0); await h.frame(); h.tap(640, 98);                   // red on the wheel, not applied
    h.tab(2); await h.frame(); await h.press('mode:welcome');
    const p = S.normalise(h.app.modesProgram());
    assert.strictEqual(p.then, null, 'ends on the car\'s own lighting');
    assert.deepStrictEqual(p.colour, { r: 0x90, g: 0xE0, b: 0x90 }, 'in the colour the car shows');
    assert.ok((await h.app.svc.apply(solid(BLUE, 70))).ok);
    assert.deepStrictEqual(S.normalise(h.app.modesProgram()).then, S.normalise(solid(BLUE, 70)), 'with a colour applied: back to it');
    await h.app.svc.stop();
});

/* ================= 4. the selectors open at 100 % ================= */
test('the Single and the Dual selector open at 100 % each time; opening sends nothing and changes nothing in the car', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    const ctl = h.app.ctl(), d = h.app.draft;
    await h.frame();
    assert.strictEqual(d.colours.brightness, 100);
    assert.strictEqual(d.colours.hsv.v, 1, 'the wheel shows the colour at full brightness');
    h.tap(930, 220 - 64);                                      // the dial: 50 %
    assert.strictEqual(d.colours.brightness, 50);
    await h.frame(); await h.press('apply'); await sleep(40);
    assert.strictEqual(ctl.program.brightness, 50);
    assert.strictEqual(phys(ctl, '2:1')[3], 50);
    const w = ctl.scheduler.stats.writes;
    for (const away of [1, 2, 3, 4]) {
        h.tab(away); await h.frame();
        h.tab(0); await h.frame();
        assert.strictEqual(d.colours.brightness, 100, 'opened at 100 % (after page ' + away + ')');
        assert.strictEqual(h.app.dirty().colours, false, 'opening is not a change');
    }
    assert.strictEqual(ctl.program.brightness, 50, 'the car keeps the brightness it has');
    assert.strictEqual(phys(ctl, '2:1')[3], 50);
    assert.strictEqual(ctl.scheduler.stats.writes, w, 'opening wrote nothing');
    // Dual: each side on its own
    h.tab(1); await h.frame();
    assert.deepStrictEqual([d.dual.top.brightness, d.dual.bottom.brightness], [100, 100]);
    await h.press('ring_top-'); await h.press('ring_top-');
    assert.deepStrictEqual([d.dual.top.brightness, d.dual.bottom.brightness], [90, 100], 'one dial moves one side');
    await h.frame(); await h.press('apply'); await sleep(40);
    assert.deepStrictEqual([ctl.program.top.brightness, ctl.program.bottom.brightness], [90, 100]);
    const w2 = ctl.scheduler.stats.writes;
    h.tab(0); await h.frame(); h.tab(1); await h.frame();
    assert.deepStrictEqual([d.dual.top.brightness, d.dual.bottom.brightness], [100, 100], 'both at 100 % again');
    assert.deepStrictEqual([ctl.program.top.brightness, ctl.program.bottom.brightness], [90, 100], 'the car unchanged');
    assert.strictEqual(ctl.scheduler.stats.writes, w2);
    // the list on the Colours page and the bar's page button open them the same way
    d.dual.top.brightness = 30;
    h.tab(0); await h.frame(); await h.press('go:Dual colour'); await h.frame();
    assert.strictEqual(d.dual.top.brightness, 100);
    await h.app.svc.stop();
});

/* ================= 5. the moving preview ================= */
test('the preview is the mode itself: lighting_scene.render at the preview\'s own clock, restarted by any change, in step with the car when it is the applied program', async () => {
    const { c } = make();
    await c.connect();
    const mods = c.slaves, pv = new ModePreview();
    const wave = { mode: 'wave', top: { colour: RED, brightness: 90 }, bottom: { colour: BLUE, brightness: 50 }, speed: 2 };
    assert.deepStrictEqual(pv.scene(wave, mods, 50000), S.render(wave, mods, 0), 'starts at the beginning');
    assert.deepStrictEqual(pv.scene(wave, mods, 51234), S.render(wave, mods, 1234));
    assert.notDeepStrictEqual(pv.scene(wave, mods, 52000), pv.scene(wave, mods, 52900), 'it moves');
    // a faster speed: restarted, and the mode's own speed (scenes.js: x 0.55)
    const fast = Object.assign({}, wave, { speed: 3 });
    assert.deepStrictEqual(pv.scene(fast, mods, 60000), S.render(fast, mods, 0), 'a change is shown from its start, at once');
    assert.deepStrictEqual(pv.scene(fast, mods, 60700), S.render(fast, mods, 700));
    // another colour
    const green = Object.assign({}, fast, { top: { colour: GREEN, brightness: 90 } });
    assert.deepStrictEqual(pv.scene(green, mods, 61000), S.render(green, mods, 0));
    // the wave's direction: bus by bus, as on the car (the passenger's doors lead the driver's)
    const sc = pv.scene(wave, mods, 70000 + 900);
    assert.notDeepStrictEqual(sc['1:3'], sc['2:8'], 'the front door lines of the two sides are at different points of the wave');
    // a still mode is still
    const st = solid(RED, 60);
    assert.deepStrictEqual(pv.scene(st, mods, 1), pv.scene(st, mods, 99999));
    assert.deepStrictEqual(pv.scene(dual(RED, BLUE), mods, 5), S.render(dual(RED, BLUE), mods, 0));
    // a one-time effect plays, rests on its end, plays again
    const welcome = { mode: 'welcome', then: solid(BLUE, 70) }, ms = S.onceMs(welcome);
    assert.deepStrictEqual(pv.scene(welcome, mods, 1000), S.render(welcome, mods, 0));
    assert.deepStrictEqual(pv.scene(welcome, mods, 1000 + ms + REST_MS / 2), S.render(welcome, mods, ms), 'resting on what it ends on');
    assert.deepStrictEqual(pv.scene(welcome, mods, 1000 + ms + REST_MS + 300), S.render(welcome, mods, 300), 'and again');
    // the applied program: the controller's own time origin
    assert.strictEqual(pv.running, false);
    const live = { program: S.normalise(wave), phase0: 4000 };
    assert.deepStrictEqual(pv.scene(wave, mods, 9000, live), S.render(wave, mods, 9000, { phase0: 4000 }));
    assert.strictEqual(pv.running, true);
    pv.scene(fast, mods, 9000, live);
    assert.strictEqual(pv.running, false, 'a draft that differs from what runs is a preview again');
    pv.stop();
    assert.strictEqual(pv.sig, null);
    // it cannot write: it knows the scene module and nothing of the controller, the scheduler or the transport
    const src = fs.readFileSync(path.join(JS, 'lighting_preview.js'), 'utf8');
    assert.deepStrictEqual((src.match(/require\('[^']+'\)/g) || []), ["require('./lighting_scene')"]);
});
test('the Modes page shows the cabin for every mode, moving for the animated ones, in the mode\'s colours; previewing writes nothing; leaving stops it', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    const ctl = h.app.ctl();
    assert.ok((await h.app.svc.apply(dual(RED, BLUE, 100, 100))).ok);
    await h.app.svc.restoreOem();                              // nothing applied: whatever shows is a preview
    await sleep(20);
    const w = ctl.scheduler.stats.writes;
    h.app.draft.modes.own = { rainbow: true, fade: true, breathing: true, wave: true };
    ['rainbow', 'fade', 'breathing', 'wave'].forEach((m) => { h.app.draft.modes.params[m].top = { colour: RED, brightness: 100 }; h.app.draft.modes.params[m].bottom = { colour: BLUE, brightness: 100 }; });
    h.tab(2);
    const hexes = (cv) => JSON.stringify(cv.words());
    for (const m of ['solid', 'dual', 'rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse']) {
        await h.frame(); await h.press('mode:' + m);
        const a = hexes(await h.frame());
        const scene = h.app.preview.scene(h.app.modesProgram(), ctl.slaves, Date.now(), null);
        assert.strictEqual(Object.keys(scene).length > 0, true, m + ': the cabin is lit in the preview');
        assert.strictEqual(h.app.preview.running, false, m);
        await sleep(S.ONCE[m] ? 1800 : S.isAnimated({ mode: m }) ? 320 : 30);
        const b = hexes(await h.frame());
        if (S.isAnimated({ mode: m })) assert.notStrictEqual(a, b, m + ': the picture moved');
        else assert.strictEqual(a, b, m + ': a still colour stands still');
        assert.ok(h.png().length > 2000, m + ' rasterises');
    }
    // the fade's picture is the fade's colours: at its start every light shows the upper colour
    await h.press('mode:fade'); h.app.preview.stop();
    const start = h.app.preview.scene(h.app.modesProgram(), ctl.slaves, 123456, null);
    assert.ok(Object.keys(start).every((k) => start[k].r > 200 && start[k].b < 60), 'red, the upper colour, not a colour of the preview\'s own');
    assert.strictEqual(ctl.scheduler.stats.writes, w, 'eight modes previewed: not one write');
    assert.strictEqual(ctl.program, null);
    assert.ok(!h.log.some((l) => l[0] === 'error'), JSON.stringify(h.log.filter((l) => l[0] === 'error')));
    // applied: the picture runs in step with the cabin
    await h.frame(); await h.press('apply'); await sleep(80);
    assert.strictEqual(ctl.program.mode, 'fade');
    await h.frame();
    assert.strictEqual(h.app.preview.running, true, 'the draft is the applied program: shown from the controller\'s clock');
    const now = Date.now();
    assert.deepStrictEqual(h.app.preview.scene(h.app.modesProgram(), ctl.slaves, now, { program: ctl.program, phase0: ctl.phase0 }), S.render(ctl.program, ctl.slaves, now, { phase0: ctl.phase0 }));
    // leaving the page: the preview's clock is dropped
    h.tab(0); await h.frame();
    assert.strictEqual(h.app.preview.sig, null, 'stopped when the page is left');
    await h.app.svc.stop();
});

/* ================= 6. an open door: one release, to that door's line ================= */
test('a door opens: ONE command, the release of that door\'s own line; never a whole-bus release, whatever else is or is not lit on its bus', async () => {
    const LINE = { passengerFront: '1:3', passengerRear: '1:6', driverFront: '2:8', driverRear: '2:11' };
    const isRelease = (w) => w.data[3] === 0;
    // over a still colour and over an animation
    for (const p of [solid(BLUE), dual(RED, BLUE), { mode: 'rainbow' }, { mode: 'wave' }]) for (const door of Object.keys(LINE)) {
        const { c, bdc, clock } = make();
        await c.connect();
        await c.apply(p);
        await clock.advance(700);
        const n = writes(bdc).length;
        await c.setEffects({ doors: [door] });
        await clock.advance(50);
        const rel = writes(bdc).slice(n).filter(isRelease);
        assert.deepStrictEqual(rel.map(keyOf), [LINE[door]], p.mode + ' ' + door + ': one release, at the line\'s own address');
        assert.strictEqual(phys(c, LINE[door])[4], 'oem', 'BMW has the line (its own door warning)');
        await clock.advance(20000);
        const during = writes(bdc).slice(n);
        assert.strictEqual(during.filter(isRelease).length, 1, p.mode + ' ' + door + ': released once, not again');
        assert.ok(during.every((w) => !(isRelease(w) && w.data[2] === 0)), 'no whole-bus release');
        assert.ok(during.every((w) => keyOf(w) !== LINE[door] || isRelease(w)), 'nothing written to the open door\'s line');
        assert.ok(during.every((w) => keyOf(w) !== LINE[door].split(':')[0] + ':0'), 'and no whole-bus colour on its bus while it is open');
        assert.ok(c.slaves.filter((s) => S.key(s) !== LINE[door]).every((s) => phys(c, S.key(s))[4] === 'custom'), 'every other light kept');
        await c.setEffects({ doors: [] });
        await clock.advance(300);
        assert.strictEqual(phys(c, LINE[door])[4], 'custom', p.mode + ' ' + door + ': the colour is back when the door closes');
        await c.restoreOem();
    }
    // the edge: the two passenger door lines are the ONLY lights of ours on bus 1, and both doors open together
    const { c, bdc, clock } = make();
    await c.connect();
    await c.apply({ mode: 'zones', handlesTo: 'bottom', assignments: [{ zone: 'module:1:3', colour: RED, brightness: 100 }, { zone: 'module:1:6', colour: RED, brightness: 100 }, { zone: 'dashboard', colour: BLUE, brightness: 100 }] });
    const n = writes(bdc).length;
    await c.setEffects({ doors: ['passengerFront', 'passengerRear'] });
    await clock.advance(50);
    assert.deepStrictEqual(writes(bdc).slice(n).map((w) => [keyOf(w), w.data[3]]), [['1:3', 0], ['1:6', 0]], 'two single releases, not one to NAD 0');
    await c.restoreOem();
});

module.exports = run('v053');

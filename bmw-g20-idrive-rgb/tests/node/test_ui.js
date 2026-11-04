'use strict';
const path = require('path');
const { test, run, assert } = require('./t');
const { harness } = require('./ui_harness');
const { JS } = require('../../scripts/stage');
const C = require(path.join(JS, 'colour'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (h) => h.targets().map((t) => t.key);
const phys = (h, key) => { const p = h.app.ctl().physicalColour(key); return [p.r, p.g, p.b, p.brightness, p.source]; };
const PAGE = { colours: 0, dual: 1, modes: 2, favourites: 3, diagnostics: 4 };

test('every page draws with its controls as targets; the simulated link is up; nothing is applied', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    for (const p of Object.values(PAGE)) { h.tab(p); const cv = await h.frame(); assert.ok(cv.words().length > 100, 'page ' + p); }
    h.tab(0); await h.frame();
    ['wheel', 'ring', 'sat', 'zone', 'apply', 'oem:#783CFE'].forEach((k) => assert.ok(keys(h).indexOf(k) >= 0, k + ' in ' + keys(h)));
    assert.strictEqual(h.app.ctl().program, null);
    assert.strictEqual(h.app.ctl().scheduler.stats.writes, 0);
    assert.ok(h.png().length > 5000);
    await h.app.ctl().shutdown();
});
test('PREVIEW ONLY: taps on the wheel and the dial change the screen, not the car; Apply changes the car', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    h.tap(258, 63);                                               // the top edge of the wheel (centre 258, 260; r 198): hue 0, full saturation
    assert.ok(Math.abs(h.app.draft.colours.hsv.h) < 1e-6 || Math.abs(h.app.draft.colours.hsv.h - 360) < 1e-6);
    assert.ok(h.app.draft.colours.hsv.s > 0.99);
    assert.strictEqual(h.app.dirty().colours, true);
    h.tap(600, 250 - 118);                                        // top of the brightness ring = 50 % (the ring runs 210 -> 150 degrees)
    assert.strictEqual(h.app.draft.colours.brightness, 50);
    await h.frame();
    assert.strictEqual(h.app.ctl().scheduler.stats.writes, 0, 'NOTHING written by previewing');
    assert.strictEqual(h.app.ctl().program, null);
    await h.press('apply');
    await sleep(30);
    const ctl = h.app.ctl();
    assert.strictEqual(ctl.program.mode, 'solid');
    assert.strictEqual(ctl.program.brightness, 50);
    const c1 = phys(h, '2:1');
    assert.ok(c1[0] === 254 && c1[1] < 4 && c1[2] < 4, 'red: ' + c1);
    assert.strictEqual(c1[3], 50);
    assert.strictEqual(h.app.dirty().colours, false);
    await ctl.shutdown();
});
test('the rotary flow: enter the wheel, turn, confirm applies (setting on); cancel restores the draft', async () => {
    const h = await harness({ sets: { backend: 'mock', confirmApplies: 'on' } });
    await h.frame();
    const ed = h.app.editor;
    assert.strictEqual(ed.available, true);
    await h.press('wheel');                                       // enter: the knob is grabbed
    assert.strictEqual(ed.editing, 'wheel');
    assert.strictEqual(h.grabbed(), true);
    const h0 = h.app.draft.colours.hsv.h;
    h.knob({ frontRotaryEncoderOperation: 100, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 110, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });   // 10 clicks
    assert.ok(Math.abs(((h.app.draft.colours.hsv.h - h0) % 360 + 360) % 360 - 30) < 1e-6, '10 clicks = 30 degrees');
    assert.strictEqual(h.app.ctl().program, null, 'turning does not touch the car');
    h.knob({ frontRotaryEncoderOperation: 110, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });   // press = confirm
    await sleep(40);
    assert.strictEqual(ed.editing, null);
    assert.strictEqual(h.grabbed(), false, 'the knob goes back to the HMI');
    assert.strictEqual(h.app.ctl().program.mode, 'solid', 'confirm applied');
    const applied = C.rgbToHex(h.app.ctl().program.colour);
    // now enter the dial, turn, and cancel with a tilt left: the draft returns to the entered value, the car keeps the applied one
    await h.frame();
    await h.press('ring');
    h.knob({ frontRotaryEncoderOperation: 110, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 100, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });   // 10 clicks anticlockwise: dimmer
    assert.strictEqual(h.app.draft.colours.brightness, 80);
    h.knob({ frontRotaryEncoderOperation: 100, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 4 });   // tilt left = cancel
    assert.strictEqual(h.app.draft.colours.brightness, 100);
    assert.strictEqual(ed.editing, null);
    assert.strictEqual(C.rgbToHex(h.app.ctl().program.colour), applied);
    await h.app.ctl().shutdown();
});
test('with the setting off, confirming only ends the edit; the bar Apply button applies', async () => {
    const h = await harness({ sets: { backend: 'mock', confirmApplies: 'off' } });
    await h.frame();
    await h.press('wheel');
    h.knob({ frontRotaryEncoderOperation: 5, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 9, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });
    await sleep(20);
    assert.strictEqual(h.app.ctl().program, null);
    await h.click('BTN_APPLY');
    await sleep(30);
    assert.strictEqual(h.app.ctl().program.mode, 'solid');
    await h.app.ctl().shutdown();
});
test('Dual Colour: two drafts, swap and copy, Apply both drives upper and lower differently; the handle setting', async () => {
    const h = await harness({ sets: { backend: 'mock', handles: 'bottom' } });
    h.tab(PAGE.dual); await h.frame();
    const d = h.app.draft.dual;
    h.tap(200, 113);                                              // top wheel (centre 200, 262; r 150): its top edge = hue 0, red
    h.tap(740, 113);                                              // bottom wheel: hue 0 too
    d.bottom.hsv = { h: 200, s: 0.65, v: 1 };
    assert.strictEqual(h.app.ctl().program, null, 'preview only');
    await h.frame();
    await h.press('swap');
    assert.ok(Math.abs(d.bottom.hsv.h) < 1e-6 && Math.abs(d.top.hsv.h - 200) < 1e-6, 'swapped');
    await h.press('swap');
    await h.frame();
    await h.press('apply');
    await sleep(40);
    const p = h.app.ctl().program;
    assert.strictEqual(p.mode, 'dual');
    const up = phys(h, '2:1');
    assert.ok(up[0] === 254 && up[1] < 4 && up[2] < 4, 'dashboard: upper = red: ' + up);
    const low = phys(h, '2:4');
    assert.ok(low[2] > low[0], 'footwell: lower = blue-ish');
    assert.strictEqual(phys(h, '2:4')[3], 45);
    assert.strictEqual(phys(h, '1:2')[3], 45, 'handle follows the lower group');
    await h.frame();
    await h.press('copy');
    assert.strictEqual(Math.round(d.bottom.hsv.h), Math.round(d.top.hsv.h));
    await h.press('savecombo');
    assert.strictEqual(h.app.favs.presets().length, 1);
    assert.strictEqual(h.app.favs.presets()[0].program.mode, 'dual');
    await h.app.ctl().shutdown();
});
test('Modes: pick Rainbow, adjust its speed with the stepper, Start it; then Breathing; Restore OEM stops it', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    h.tab(PAGE.modes); await h.frame();
    await h.press('mode:rainbow');
    await h.frame();
    assert.ok(keys(h).indexOf('p:periodS+') >= 0);
    await h.press('p:periodS-');
    assert.strictEqual(h.app.draft.modes.params.rainbow.periodS, 19);
    assert.strictEqual(h.app.ctl().program, null, 'preview only');
    await h.press('apply');
    await sleep(60);
    const ctl = h.app.ctl();
    assert.strictEqual(ctl.program.mode, 'rainbow');
    assert.strictEqual(ctl.program.periodS, 19);
    await sleep(300);
    assert.ok(ctl.stats.frames >= 2, 'animating: ' + ctl.stats.frames);
    await h.frame();
    await h.press('mode:breathing');
    await h.frame();
    await h.press('apply');
    await sleep(60);
    assert.strictEqual(ctl.program.mode, 'breathing');
    await h.frame();
    await h.press('oem');
    await sleep(40);
    assert.strictEqual(ctl.program, null);
    assert.strictEqual(phys(h, '2:1')[4], 'oem');
    const f = ctl.stats.frames;
    await sleep(250);
    assert.strictEqual(ctl.stats.frames, f, 'stopped cleanly');
    await ctl.shutdown();
});
test('zones from the Colours page: applying a zone keeps the other zones\' colours', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('apply');                                       // all, violet-ish default
    await sleep(30);
    const before = phys(h, '2:1');
    await h.frame();
    await h.press('zone'); await h.press('zone'); await h.press('zone'); await h.press('zone');   // dashboard, frontDoors, rearDoors, footwells
    assert.strictEqual(h.app.coloursProgram().mode, 'zones');
    h.app.draft.colours.hsv = { h: 120, s: 1, v: 1 };
    await h.frame();
    await h.press('apply');
    await sleep(40);
    assert.deepStrictEqual(phys(h, '2:4').slice(0, 3), [0, 254, 0], 'footwell green');
    assert.deepStrictEqual(phys(h, '2:1').slice(0, 3), before.slice(0, 3), 'dashboard kept its colour');
    assert.strictEqual(h.app.ctl().program.assignments.length, 2);
    await h.app.ctl().shutdown();
});
test('Favourites: colours and complete configurations, apply one, delete one', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('oem:#10FE32');
    await h.frame();
    await h.press('save');
    h.tab(PAGE.dual); await h.frame();
    await h.press('savecombo');
    h.tab(PAGE.favourites); await h.frame();
    assert.ok(keys(h).indexOf('fav:#10FE32') >= 0, keys(h).join());
    const cfgKey = keys(h).find((k) => k.indexOf('cfg:') === 0);
    assert.ok(cfgKey, 'a configuration listed');
    await h.press(cfgKey);
    await sleep(40);
    assert.strictEqual(h.app.ctl().program.mode, 'dual', 'applied from the list');
    await h.frame();
    await h.press('del');
    await h.frame();
    await h.press(cfgKey);
    assert.strictEqual(h.app.favs.presets().length, 0);
    await h.press('fav:#10FE32');
    assert.strictEqual(h.app.favs.has('#10FE32'), false);
    await h.app.ctl().shutdown();
});
test('Cancel discards a draft and returns to the applied colour', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('oem:#0020FE');
    await h.frame();
    await h.press('apply');
    await sleep(30);
    h.tap(258, 63);                                               // red preview
    await h.frame();
    assert.ok(keys(h).indexOf('cancel') >= 0, 'cancel offered while dirty');
    await h.press('cancel');
    assert.strictEqual(C.rgbToHex(C.hsvToRgb(h.app.draft.colours.hsv)), '#0020FE');
    assert.strictEqual(h.app.dirty().colours, false);
    await h.app.ctl().shutdown();
});
test('the diagnostics page shows the link, the variant, transport figures and the modules', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame(); await h.press('apply'); await sleep(30);
    h.tab(PAGE.diagnostics);
    const cv = await h.frame();
    assert.ok(cv.words().length > 500);
    assert.ok(keys(h).indexOf('probe') >= 0);
    await h.press('probe');
    assert.strictEqual(h.app.ctl().state, 'connected');
    await h.app.ctl().shutdown();
});
test('switching the link to the car without a diagnostic link: no link, Apply refused, nothing written', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    h.settings.set('backend', 'bdc');
    await sleep(60);
    const ctl = h.app.ctl();
    assert.strictEqual(ctl.kind, 'bdc-uds');
    assert.notStrictEqual(ctl.state, 'connected');
    await h.frame();
    await h.press('apply');
    await sleep(30);
    assert.strictEqual(ctl.program, null);
    await ctl.shutdown();
});

module.exports = run('ui');

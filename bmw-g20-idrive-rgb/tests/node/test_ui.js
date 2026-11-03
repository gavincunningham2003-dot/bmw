'use strict';
const { test, run, assert, tick } = require('./t');
const { harness } = require('./ui_harness');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (h) => h.targets().map((t) => t.key);

test('the colour page draws with its buttons as targets and a simulated link', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    const cv = await h.frame();
    assert.ok(cv.words().length > 100);
    const k = keys(h);
    ['custom', 'oem', 'save', 'nudgeH-', 'nudgeH+', 'nudgeS-', 'nudgeS+', 'nudgeV-', 'nudgeV+', 'oem:#D76E14'].forEach((x) => assert.ok(k.indexOf(x) >= 0, 'target ' + x + ' in ' + k));
    assert.strictEqual(h.app.ctl().kind, 'mock');
    assert.strictEqual(h.app.ctl().state, 'connected');
    assert.ok(h.png().length > 5000, 'rasterises to a PNG');
    await h.app.ctl().shutdown();
});
test('a tap on the wheel picks hue by angle and saturation by radius; the slider picks value', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    h.tap(270, 120);                                              // straight above the centre (270, 270): hue 0, s 0.75
    let hsv = h.app.hsv();
    assert.ok(Math.abs(hsv.h) < 1e-6 || Math.abs(hsv.h - 360) < 1e-6, 'hue ' + hsv.h);
    assert.ok(Math.abs(hsv.s - 0.75) < 1e-6, 'sat ' + hsv.s);
    h.tap(420, 270);                                              // 3 o'clock: hue 90
    assert.ok(Math.abs(h.app.hsv().h - 90) < 1e-6);
    h.tap(542, 72 + 396 / 2);                                     // the middle of the value slider
    hsv = h.app.hsv();
    assert.ok(Math.abs(hsv.v - 0.5) < 0.01, 'value ' + hsv.v);
    h.tap(1500, 500);                                             // nowhere: unchanged
    assert.ok(Math.abs(h.app.hsv().v - 0.5) < 0.01);
    assert.deepStrictEqual(h.app.ctl().colour, require(require('path').join(require('../../scripts/stage').JS, 'colour')).hsvToRgb(h.app.hsv()), 'the controller holds the selected colour');
    await h.app.ctl().shutdown();
});
test('Apply to lights drives the simulated BDC with the selected colour; Restore OEM lets go', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('oem:#0020FE');                                 // library Blue
    await h.frame();
    assert.deepStrictEqual(h.app.ctl().colour, { r: 0x00, g: 0x20, b: 0xFE });
    await h.press('custom');
    await sleep(20);
    const ctl = h.app.ctl();
    assert.strictEqual(ctl.custom, true);
    assert.deepStrictEqual([ctl.physicalColour().r, ctl.physicalColour().g, ctl.physicalColour().b], [0x00, 0x20, 0xFE]);
    await h.frame();
    assert.ok(keys(h).indexOf('custom') >= 0);
    await h.press('nudgeH+');                                     // live change while custom is on
    await sleep(250);                                             // past the 150 ms coalescing gap
    const want = require(require('path').join(require('../../scripts/stage').JS, 'colour')).hsvToRgb(h.app.hsv());
    const got = ctl.physicalColour();
    assert.deepStrictEqual([got.r, got.g, got.b], [want.r, want.g, want.b], 'the lights followed the nudge');
    await h.press('oem');
    await sleep(20);
    assert.strictEqual(ctl.custom, false);
    assert.strictEqual(ctl.physicalColour().source, 'oem');
    await ctl.shutdown();
});
test('the HMI bar buttons work too (Custom on/off, Restore OEM, Next page)', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.click('BTN_CUSTOM');
    await sleep(20);
    assert.strictEqual(h.app.ctl().custom, true);
    await h.click('BTN_OEM');
    await sleep(20);
    assert.strictEqual(h.app.ctl().custom, false);
    await h.click('BTN_PAGE');
    assert.strictEqual(h.app.page(), 1);
    await h.click('BTN_PAGE'); await h.click('BTN_PAGE');
    assert.strictEqual(h.app.page(), 0);
    await h.app.ctl().shutdown();
});
test('favourites: save on the colour page, see and pick it on the favourites page, delete it', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('oem:#783CFE');
    await h.frame();
    await h.press('save');
    assert.ok(h.app.favs.has('#783CFE'));
    h.tab(1);
    await h.frame();
    assert.ok(keys(h).indexOf('fav:#783CFE') >= 0, keys(h).join());
    await h.press('fav:#783CFE');
    assert.deepStrictEqual(h.app.ctl().colour, { r: 0x78, g: 0x3C, b: 0xFE });
    await h.press('del');
    await h.frame();
    await h.press('fav:#783CFE');
    assert.strictEqual(h.app.favs.has('#783CFE'), false);
    await h.frame();
    assert.ok(keys(h).indexOf('fav:#783CFE') < 0);
    await h.app.ctl().shutdown();
});
test('the diagnostics page shows the link, the variant, the slaves and the last request bytes', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    await h.press('custom');
    await sleep(20);
    h.tab(2);
    const cv = await h.frame();
    assert.ok(keys(h).indexOf('probe') >= 0);
    const words = cv.words().length;
    assert.ok(words > 500, 'a full page');
    const s = h.app.ctl().status();
    assert.ok(s.lastRequest.indexOf('2E DA 5E') === 0);
    await h.press('probe');
    assert.strictEqual(h.app.ctl().state, 'connected');
    await h.app.ctl().shutdown();
});
test('the iDrive knob turns the hue; a press cycles the channel; the grab follows the page and the setting', async () => {
    const h = await harness({ sets: { backend: 'mock', knob: 'hue' } });
    await h.frame();
    assert.strictEqual(h.grabbed(), true, 'grabbed on the colour page');
    const h0 = h.app.hsv().h;
    h.knob({ frontRotaryEncoderOperation: 100, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    h.knob({ frontRotaryEncoderOperation: 104, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
    assert.ok(Math.abs((h.app.hsv().h - h0 + 360) % 360 - 12) < 1e-6, '4 clicks = 12 degrees, got ' + h.app.hsv().h);
    h.knob({ frontRotaryEncoderOperation: 65535, frontRotaryEncoderPushButton: 15, frontRotaryEncoderDeflection: 15 });   // invalid (VM): ignored
    assert.ok(Math.abs((h.app.hsv().h - h0 + 360) % 360 - 12) < 1e-6);
    h.knob({ frontRotaryEncoderOperation: 104, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });
    assert.strictEqual(h.app.channel(), 's');
    h.tab(2);
    assert.strictEqual(h.grabbed(), false, 'released on another page');
    h.tab(0);
    assert.strictEqual(h.grabbed(), true);
    h.settings.set('knob', 'off');
    assert.strictEqual(h.grabbed(), false, 'released when turned off');
    await h.app.ctl().shutdown();
});
test('switching the link setting to the car without a diagnostic link: no link, custom control refused', async () => {
    const h = await harness({ sets: { backend: 'mock' } });
    await h.frame();
    h.settings.set('backend', 'bdc');
    await sleep(50);
    const ctl = h.app.ctl();
    assert.strictEqual(ctl.kind, 'bdc-uds');
    assert.notStrictEqual(ctl.state, 'connected');
    await h.frame();
    await h.press('custom');
    assert.strictEqual(ctl.custom, false);
    h.settings.set('backend', 'someip');
    await sleep(50);
    assert.strictEqual(h.app.ctl().kind, 'someip');
    assert.strictEqual(h.app.ctl().state, 'disconnected');
    await h.frame();
    await h.app.ctl().shutdown();
});
test('settings: hue / sat / val, keep-alive and brightness feed the controller', async () => {
    const h = await harness({ sets: { backend: 'mock', hue: 200, sat: 50, val: 100 } });
    await h.frame();
    h.settings.set('hue', 200);
    assert.strictEqual(Math.round(h.app.hsv().h), 200);
    assert.strictEqual(Math.round(h.app.hsv().s * 100), 50);
    h.settings.set('refresh', 20);
    assert.strictEqual(h.app.ctl().refreshSeconds, 20);
    h.settings.set('brightness', 50);
    assert.strictEqual(h.app.ctl().brightness, 50);
    await h.app.ctl().shutdown();
});

module.exports = run('ui');

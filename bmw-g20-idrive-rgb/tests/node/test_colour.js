'use strict';
const path = require('path');
const { test, run, assert } = require('./t');
const { JS } = require('../../scripts/stage');
const C = require(path.join(JS, 'colour'));

test('rgb <-> hsv round trip on a grid', () => {
    for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
        const hsv = C.rgbToHsv({ r, g, b }), back = C.hsvToRgb(hsv);
        assert.deepStrictEqual(back, { r, g, b }, JSON.stringify([r, g, b, hsv]));
    }
});
test('hsv primaries', () => {
    assert.deepStrictEqual(C.hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
    assert.deepStrictEqual(C.hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
    assert.deepStrictEqual(C.hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
    assert.deepStrictEqual(C.hsvToRgb(360, 1, 1), { r: 255, g: 0, b: 0 });
    assert.deepStrictEqual(C.hsvToRgb(-120, 1, 1), { r: 0, g: 0, b: 255 });
    assert.deepStrictEqual(C.hsvToRgb(0, 0, 0.5), { r: 128, g: 128, b: 128 });
    assert.strictEqual(C.rgbToHsv({ r: 0, g: 0, b: 0 }).s, 0);
});
test('hex parse and format', () => {
    assert.strictEqual(C.rgbToHex({ r: 0x90, g: 0xE0, b: 0x90 }), '#90E090');
    assert.deepStrictEqual(C.hexToRgb('#d76e14'), { r: 0xD7, g: 0x6E, b: 0x14 });
    assert.deepStrictEqual(C.hexToRgb('10FE32'), { r: 0x10, g: 0xFE, b: 0x32 });
    assert.strictEqual(C.hexToRgb('#12345'), null);
    assert.strictEqual(C.hexToRgb('zzzzzz'), null);
    assert.strictEqual(C.hexToRgb(''), null);
    assert.strictEqual(C.rgbToHex({ r: 300, g: -5, b: 12.6 }), '#FF000D');
});
test('coding byte folds FF to FE (community rule for 360A coding only)', () => {
    assert.strictEqual(C.codingByte(255), 254);
    assert.strictEqual(C.codingByte(254), 254);
    assert.strictEqual(C.codingByte(0), 0);
});
test('wheel: hue 0 is at 12 o\'clock, clockwise, saturation by radius (the kit arc convention)', () => {
    const cx = 200, cy = 200, r = 100;
    const top = C.wheelHit(200, 110, cx, cy, r);
    assert.ok(Math.abs(top.h) < 1e-9 || Math.abs(top.h - 360) < 1e-9, 'top = hue 0, got ' + top.h);
    assert.ok(Math.abs(top.s - 0.9) < 1e-9);
    const right = C.wheelHit(290, 200, cx, cy, r);
    assert.ok(Math.abs(right.h - 90) < 1e-9, '3 o\'clock = 90, got ' + right.h);
    const bottom = C.wheelHit(200, 250, cx, cy, r);
    assert.ok(Math.abs(bottom.h - 180) < 1e-9);
    const left = C.wheelHit(150, 200, cx, cy, r);
    assert.ok(Math.abs(left.h - 270) < 1e-9);
    assert.strictEqual(C.wheelHit(200, 60, cx, cy, r), null, 'outside');
    assert.ok(C.wheelHit(200, 90, cx, cy, r, { slack: 12 }), 'inside with slack');
    assert.strictEqual(C.wheelHit(200, 90, cx, cy, r, { slack: 12 }).s, 1, 'slack clamps saturation');
});
test('wheelPos is the inverse of wheelHit', () => {
    const cx = 300, cy = 260, r = 200;
    for (let h = 0; h < 360; h += 37) for (const s of [0.1, 0.4, 0.7, 1.0]) {
        const p = C.wheelPos(h, s, cx, cy, r), back = C.wheelHit(p.x, p.y, cx, cy, r);
        assert.ok(Math.abs(C.wrapHue(back.h - h)) < 1e-6 || Math.abs(C.wrapHue(back.h - h) - 360) < 1e-6, h + ' ' + back.h);
        assert.ok(Math.abs(back.s - s) < 1e-6);
    }
});
test('wheelPixels: RGBA of the right size, opaque inside, transparent outside, hue 0 at the top', () => {
    const w = C.wheelPixels(64);
    assert.strictEqual(w.data.length, 64 * 64 * 4);
    const px = (x, y) => Array.prototype.slice.call(w.data, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
    assert.strictEqual(px(0, 0)[3], 0, 'corner transparent');
    assert.strictEqual(px(32, 32)[3], 255, 'centre opaque');
    const top = px(31, 2);
    assert.ok(top[0] > 200 && top[1] < 80 && top[2] < 80, 'top is red: ' + top);
    assert.ok(px(31, 31)[0] > 230 && px(31, 31)[1] > 230 && px(31, 31)[2] > 230, 'centre is white');
});
test('drawWheel records ramped full-circle arcs on a recorder', () => {
    const { Recorder } = require(path.join(JS, 'kit', 'record'));
    const r = new Recorder(420, 420);
    C.drawWheel(r, 210, 210, 200);
    assert.ok(r.words().length >= 24 * 12, 'arcs recorded');
    assert.ok(r.ramps.size >= 24, 'a ramp per ring');
    const { Canvas } = require(path.join(JS, 'kit', 'canvas'));
    const { play } = require(path.join(JS, 'kit', 'record'));
    const c = new Canvas(420, 420);
    play(r.words(), c);
    assert.ok(c.png().length > 1000, 'rasterises');
});
test('nudge wraps hue and clamps s / v', () => {
    assert.strictEqual(C.nudge({ h: 355, s: 1, v: 1 }, 'h', 10).h, 5);
    assert.strictEqual(C.nudge({ h: 5, s: 1, v: 1 }, 'h', -10).h, 355);
    assert.strictEqual(C.nudge({ h: 0, s: 0.98, v: 1 }, 's', 0.05).s, 1);
    assert.strictEqual(C.nudge({ h: 0, s: 1, v: 0.02 }, 'v', -0.05).v, 0);
});
test('luma picks dark text on light colours', () => {
    assert.ok(C.luma({ r: 255, g: 255, b: 255 }) > 0.9);
    assert.ok(C.luma({ r: 0, g: 0, b: 128 }) < 0.2);
});

module.exports = run('colour');

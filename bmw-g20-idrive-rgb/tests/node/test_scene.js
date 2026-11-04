'use strict';
const path = require('path');
const { test, run, assert } = require('./t');
const { JS } = require('../../scripts/stage');
const S = require(path.join(JS, 'lighting_scene'));
const { G20_SLAVES } = require(path.join(JS, 'lighting_mock'));
const P = require(path.join(JS, 'lighting_protocol'));

const modules = G20_SLAVES.bus1.map((loc, i) => ({ bus: 1, nad: i + 1, locationId: loc, location: P.LOCATION[loc] })).concat(G20_SLAVES.bus2.map((loc, i) => ({ bus: 2, nad: i + 1, locationId: loc, location: P.LOCATION[loc] })));
const by = (bus, nad) => modules.find((m) => m.bus === bus && m.nad === nad);

test('the car\'s 19 modules fall into categories, groups and sides from their locations', () => {
    assert.strictEqual(S.category(by(2, 1)), 'dashLine');
    assert.strictEqual(S.category(by(1, 3)), 'doorLine');
    assert.strictEqual(S.category(by(1, 2)), 'handle');
    assert.strictEqual(S.category(by(1, 1)), 'pocket');
    assert.strictEqual(S.category(by(2, 4)), 'footwell');
    assert.strictEqual(S.groupOf(by(2, 1), 'bottom'), 'top', 'dashboard line is upper');
    assert.strictEqual(S.groupOf(by(1, 3), 'bottom'), 'top', 'door contour line is upper');
    assert.strictEqual(S.groupOf(by(1, 1), 'bottom'), 'bottom', 'map pocket is lower');
    assert.strictEqual(S.groupOf(by(2, 4), 'bottom'), 'bottom', 'footwell is lower');
    assert.strictEqual(S.groupOf(by(1, 2), 'bottom'), 'bottom', 'handles go where the program says');
    assert.strictEqual(S.groupOf(by(1, 2), 'top'), 'top');
    assert.strictEqual(S.groupOf(by(1, 2), 'off'), 'off');
    assert.strictEqual(S.isFront(by(1, 3)), true); assert.strictEqual(S.isRear(by(1, 6)), true);
    assert.strictEqual(S.isDriverSide(by(2, 8)), true); assert.strictEqual(S.isDriverSide(by(1, 3)), false);
});
test('zones select the right modules', () => {
    const count = (z, o) => modules.filter((m) => S.zoneFilter(z, o)(m)).length;
    assert.strictEqual(count('all'), 19);
    assert.strictEqual(count('dashboard'), 3);
    assert.strictEqual(count('footwells'), 4);
    assert.strictEqual(count('frontDoors'), 6);
    assert.strictEqual(count('rearDoors'), 6);
    assert.strictEqual(count('doors'), 12);
    assert.strictEqual(count('upper', { handlesTo: 'bottom' }), 7, 'dash 3 + door lines 4');
    assert.strictEqual(count('lower', { handlesTo: 'bottom' }), 12, 'pockets 4 + footwells 4 + handles 4');
    assert.strictEqual(count('upper', { handlesTo: 'top' }), 11);
    assert.strictEqual(count('lower', { handlesTo: 'off' }), 8);
    assert.strictEqual(count('module:2:1'), 1);
    assert.strictEqual(S.zoneLabel('module:2:1', modules), 'Contour line dashboard centre');
    assert.strictEqual(S.zoneLabel('upper'), 'Upper lighting');
});
test('solid renders the zone only; brightness and colour bytes are clamped', () => {
    const sc = S.render({ mode: 'solid', colour: { r: 300, g: -1, b: 254 }, brightness: 120, zone: 'dashboard' }, modules, 0);
    assert.strictEqual(Object.keys(sc).length, 3);
    assert.deepStrictEqual(sc['2:1'], { r: 255, g: 0, b: 254, brightness: 100 });
    assert.strictEqual(sc['1:1'], undefined);
});
test('dual: top and bottom colours and brightness, handles as configured, same at any time', () => {
    const p = { mode: 'dual', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 80 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 45 }, handlesTo: 'bottom' };
    const a = S.render(p, modules, 0), b = S.render(p, modules, 123456);
    assert.deepStrictEqual(a, b, 'static');
    assert.deepStrictEqual(a['2:1'], { r: 160, g: 60, b: 254, brightness: 80 });
    assert.deepStrictEqual(a['2:4'], { r: 90, g: 200, b: 254, brightness: 45 });
    assert.deepStrictEqual(a['1:2'], { r: 90, g: 200, b: 254, brightness: 45 }, 'handle follows the bottom');
    const off = S.render(Object.assign({}, p, { handlesTo: 'off' }), modules, 0);
    assert.strictEqual(off['1:2'], undefined, 'handles left OEM');
    assert.strictEqual(Object.keys(off).length, 15);
});
test('zones program: later assignments win, others untouched', () => {
    const sc = S.render({ mode: 'zones', assignments: [{ zone: 'all', colour: { r: 1, g: 1, b: 1 }, brightness: 50 }, { zone: 'footwells', colour: { r: 9, g: 9, b: 9 }, brightness: 20 }] }, modules, 0);
    assert.deepStrictEqual(sc['2:4'], { r: 9, g: 9, b: 9, brightness: 20 });
    assert.deepStrictEqual(sc['2:1'], { r: 1, g: 1, b: 1, brightness: 50 });
    assert.strictEqual(Object.keys(sc).length, 19);
});
test('rainbow turns the hue once per period; brightness as set', () => {
    const p = { mode: 'rainbow', periodS: 10, brightness: 60, zone: 'all' };
    const a = S.render(p, modules, 0)['2:1'], b = S.render(p, modules, 2500)['2:1'], c = S.render(p, modules, 10000)['2:1'];
    assert.deepStrictEqual([a.r, a.g, a.b], [255, 0, 0], 'hue 0 = red');
    assert.deepStrictEqual([b.r, b.g, b.b], [128, 255, 0], 'a quarter turn: hue 90');
    assert.deepStrictEqual([c.r, c.g, c.b], [255, 0, 0], 'a full turn');
    assert.strictEqual(a.brightness, 60);
});
test('fade glides through the palette with holds', () => {
    const p = { mode: 'fade', colours: [{ r: 254, g: 0, b: 0 }, { r: 0, g: 0, b: 254 }], transitionMs: 1000, holdMs: 1000, brightness: 100, zone: 'dashboard' };
    const at = (ms) => S.render(p, modules, ms)['2:1'];
    assert.deepStrictEqual([at(0).r, at(0).b], [254, 0], 'holding red');
    assert.deepStrictEqual([at(500).r, at(500).b], [254, 0], 'still holding');
    const mid = at(1500);
    assert.ok(mid.r > 100 && mid.r < 160 && mid.b > 100 && mid.b < 160, 'half way: ' + JSON.stringify(mid));
    assert.deepStrictEqual([at(2000).r, at(2000).b], [0, 254], 'blue');
    assert.deepStrictEqual([at(4000).r, at(4000).b], [254, 0], 'back round');
});
test('breathing moves the brightness between the limits, smoothly', () => {
    const p = { mode: 'breathing', colour: { r: 10, g: 20, b: 30 }, minBrightness: 10, maxBrightness: 90, periodS: 4, zone: 'all' };
    const b = (ms) => S.render(p, modules, ms)['1:1'].brightness;
    assert.strictEqual(b(0), 10); assert.strictEqual(b(2000), 90); assert.strictEqual(b(4000), 10);
    assert.ok(b(1000) > 40 && b(1000) < 60);
    const swapped = S.normalise({ mode: 'breathing', minBrightness: 80, maxBrightness: 20 });
    assert.deepStrictEqual([swapped.minBrightness, swapped.maxBrightness], [20, 80]);
});
test('wave: every module gets a hue by its position along the cabin; the dashboard leads', () => {
    const p = { mode: 'wave', baseHue: 240, hueSpan: 60, periodS: 8, brightness: 100, zone: 'all' };
    const sc = S.render(p, modules, 0);
    assert.strictEqual(Object.keys(sc).length, 19);
    const hues = Object.keys(sc).map((k) => S.rgbToHsv(sc[k]).h);
    assert.ok(new Set(hues.map((h) => Math.round(h))).size > 4, 'different phases: ' + hues.map((h) => Math.round(h)));
    assert.ok(S.wavePosition(by(2, 1)) < S.wavePosition(by(1, 3)) && S.wavePosition(by(1, 3)) < S.wavePosition(by(1, 6)), 'dash < front door < rear door');
});
test('normalise fills defaults and keeps what is given; isAnimated; describe', () => {
    const p = S.normalise({ mode: 'solid', colour: { r: 1, g: 2, b: 3 } });
    assert.strictEqual(p.brightness, 100); assert.strictEqual(p.zone, 'all');
    assert.strictEqual(S.normalise({ mode: 'nope' }).mode, 'solid');
    assert.strictEqual(S.isAnimated({ mode: 'wave' }), true); assert.strictEqual(S.isAnimated({ mode: 'dual' }), false);
    assert.ok(/#010203 100% All lighting/.test(S.describe(p)));
    assert.ok(/top #A03CFE 80%, bottom/.test(S.describe(S.DEFAULTS.dual)));
});
test('diff lists changed keys only', () => {
    const a = { '1:1': { r: 1, g: 1, b: 1, brightness: 1 }, '1:2': { r: 2, g: 2, b: 2, brightness: 2 } };
    const b = { '1:1': { r: 1, g: 1, b: 1, brightness: 1 }, '1:2': { r: 2, g: 2, b: 2, brightness: 3 }, '1:3': { r: 0, g: 0, b: 0, brightness: 0 } };
    assert.deepStrictEqual(S.diff(a, b).sort(), ['1:2', '1:3']);
});
test('presets round-trip through JSON with normalised programs', () => {
    const list = [S.presetFrom('Evening', { mode: 'dual', top: { colour: { r: 1, g: 2, b: 3 }, brightness: 70 } }), S.presetFrom('', { mode: 'wave' })];
    const back = S.presetsFromJson(S.presetsToJson(list));
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[0].name, 'Evening');
    assert.deepStrictEqual(back[0].program.top.colour, { r: 1, g: 2, b: 3 });
    assert.strictEqual(back[0].program.bottom.brightness, 45, 'defaults filled');
    assert.strictEqual(back[1].name, 'Colour Wave');
    assert.deepStrictEqual(S.presetsFromJson('{bad'), []);
});

module.exports = run('scene');

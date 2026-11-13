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
/* The animations are the MGU App Kit Ambient Config's (ambient_config_scenes.js, unchanged): the figures below are
 * that file's, worked out by hand (rainbow 12 s, fade 8 s, breathing 4 s, wave 5 s at normal speed; slow x 1.6,
 * fast x 0.55). test_v051.js compares render() with its lightAt() module by module. */
const RED = { r: 254, g: 0, b: 0 }, BLUE = { r: 0, g: 0, b: 254 };
const look = (mode, more) => Object.assign({ mode, top: { colour: RED, brightness: 60 }, bottom: { colour: BLUE, brightness: 20 } }, more || {});
test('rainbow: the whole cabin one colour, once round in 12 s (19.2 s slow, 6.6 s fast), at the upper brightness', () => {
    const p = look('rainbow');
    const at = (ms, q) => { const t = S.render(q || p, modules, ms)['2:1']; return [t.r, t.g, t.b]; };
    assert.deepStrictEqual(at(0), [255, 0, 0], 'hue 0 = red');
    assert.deepStrictEqual(at(3000), [128, 255, 0], 'a quarter turn: hue 90');
    assert.deepStrictEqual(at(12000), [255, 0, 0], 'a full turn');
    assert.deepStrictEqual(at(4800, look('rainbow', { speed: 1 })), [128, 255, 0], 'slow: the quarter turn at 12 s x 1.6 / 4');
    assert.deepStrictEqual(at(1650, look('rainbow', { speed: 3 })), [128, 255, 0], 'fast: at 12 s x 0.55 / 4');
    const sc = S.render(p, modules, 5000);
    assert.strictEqual(Object.keys(sc).length, 19);
    assert.strictEqual(new Set(Object.keys(sc).map((k) => JSON.stringify(sc[k]))).size, 1, 'every module the same colour: one write a bus');
    assert.strictEqual(sc['1:1'].brightness, 60, 'lower modules too take the upper brightness');
});
test('fade: every light from the upper colour to the lower one and back in 8 s, the brightness with it', () => {
    const p = look('fade');
    const at = (ms) => S.render(p, modules, ms);
    assert.deepStrictEqual(at(0)['2:1'], { r: 254, g: 0, b: 0, brightness: 60 }, 'the upper colour');
    assert.deepStrictEqual(at(4000)['2:1'], { r: 0, g: 0, b: 254, brightness: 20 }, 'half way round: the lower colour');
    assert.deepStrictEqual(at(2000)['2:1'], { r: 127, g: 0, b: 127, brightness: 40 }, 'a quarter: half way between');
    assert.deepStrictEqual(at(8000)['2:1'], at(0)['2:1'], 'back');
    assert.deepStrictEqual(at(2000)['1:1'], at(2000)['2:1'], 'upper and lower lights alike');
});
test('breathing: each group in its own colour, between 12 % and 100 % of its brightness, every 4 s', () => {
    const p = look('breathing');
    const at = (ms, k) => S.render(p, modules, ms)[k];
    assert.deepStrictEqual(at(0, '2:1'), { r: 254, g: 0, b: 0, brightness: 7 }, 'upper (dash line): 12 % of 60');
    assert.deepStrictEqual(at(2000, '2:1'), { r: 254, g: 0, b: 0, brightness: 60 }, 'full');
    assert.deepStrictEqual(at(2000, '2:4'), { r: 0, g: 0, b: 254, brightness: 20 }, 'lower (footwell): its own colour and brightness');
    assert.deepStrictEqual(at(4000, '2:1'), at(0, '2:1'));
    assert.strictEqual(at(1000, '2:1').brightness, 34, 'half way up: 60 x (0.12 + 0.88 / 2)');
    // the handles go with the group the setting says (Ambient Config has them lower: the default)
    assert.strictEqual(at(2000, '1:2').b, 254);
    assert.strictEqual(S.render(look('breathing', { handlesTo: 'top' }), modules, 2000)['1:2'].r, 254);
    assert.strictEqual(S.render(look('breathing', { handlesTo: 'off' }), modules, 2000)['1:2'], undefined, 'handles left to the car');
});
test('wave: a band around the upper colour rolling bus by bus (the passenger doors, then the dash and the driver doors)', () => {
    const p = look('wave');
    const sc = S.render(p, modules, 0);
    assert.strictEqual(Object.keys(sc).length, 19);
    const colours = (bus) => Array.from(new Set(modules.filter((m) => m.bus === bus).map((m) => { const t = sc[S.key(m)]; return [t.r, t.g, t.b].join(); })));
    assert.deepStrictEqual(colours(1), ['255,0,0'], 'bus 1 (Ambient Config\'s bus 0): the upper colour\'s hue, every module the same');
    assert.deepStrictEqual(colours(2), ['255,0,255'], 'bus 2: a quarter of a wave behind, hue - 60');
    assert.deepStrictEqual(S.render(p, modules, 5000), sc, 'once round in 5 s');
    assert.strictEqual(sc['1:1'].brightness, 60);
    // a module is a light for Ambient Config: its group, where it sits front to back (its own table), its bus from 0
    assert.deepStrictEqual(S.lightOf(by(2, 1), 'bottom'), { part: 'upper', y: 0.15, bus: 1 }, 'dash line centre');
    assert.deepStrictEqual(S.lightOf(by(1, 7), 'bottom'), { part: 'lower', y: 0.54, bus: 0 }, 'footwell passenger rear');
    assert.ok(S.lightOf(by(2, 1)).y < S.lightOf(by(1, 3)).y && S.lightOf(by(1, 3)).y < S.lightOf(by(1, 6)).y, 'dash < front door < rear door');
});
test('a program saved by 0.5.0 (its own periods, palette and limits) still loads: its colours and brightness, normal speed', () => {
    assert.deepStrictEqual(S.normalise({ mode: 'rainbow', periodS: 20, brightness: 70, zone: 'all' }), { mode: 'rainbow', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 70 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 70 }, speed: 2, handlesTo: 'bottom', zone: 'all' });
    const b = S.normalise({ mode: 'breathing', colour: { r: 10, g: 20, b: 30 }, minBrightness: 10, maxBrightness: 90, periodS: 4, zone: 'dashboard' });
    assert.deepStrictEqual([b.top, b.bottom, b.zone], [{ colour: { r: 10, g: 20, b: 30 }, brightness: 90 }, { colour: { r: 10, g: 20, b: 30 }, brightness: 90 }, 'dashboard']);
    const f = S.normalise({ mode: 'fade', colours: [RED, BLUE, { r: 0, g: 254, b: 0 }], transitionMs: 2000, holdMs: 1000, brightness: 50 });
    assert.deepStrictEqual([f.top.colour, f.bottom.colour, f.top.brightness], [RED, BLUE, 50]);
    const w = S.normalise({ mode: 'wave', baseHue: 240, hueSpan: 60, periodS: 8, brightness: 100, speed: 3 });
    assert.deepStrictEqual([w.top.colour, w.speed], [{ r: 0, g: 0, b: 255 }, 3]);
    assert.strictEqual(S.normalise({ mode: 'wave', speed: 9 }).speed, 2, 'an unknown speed is normal');
    assert.deepStrictEqual(S.normalise(S.normalise(look('fade', { speed: 1 }))), S.normalise(look('fade', { speed: 1 })), 'normalise is stable');
    assert.ok(/^fade #FE0000 to #0000FE, slow$/.test(S.describe(look('fade', { speed: 1 }))));
    assert.ok(/^rainbow, normal, 60%$/.test(S.describe(look('rainbow'))));
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

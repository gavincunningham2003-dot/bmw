'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run, assert } = require('./t');
const { JS } = require('../../scripts/stage');
const { Favourites, OEM, MAX } = require(path.join(JS, 'favourites'));

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-fav-'));

test('the OEM six are the published 360A library colours', () => {
    assert.deepStrictEqual(OEM.map((o) => o.hex), ['#90E090', '#D76E14', '#931A01', '#0020FE', '#10FE32', '#783CFE']);
});
test('add, has, remove, persist, reload', () => {
    const d = dir();
    const f = new Favourites(d);
    assert.strictEqual(f.add('#ff0000', 'Red'), true);
    assert.strictEqual(f.add('ff0000'), false, 'no duplicates');
    assert.strictEqual(f.has('#FF0000'), true);
    assert.strictEqual(f.add('nope'), false);
    assert.ok(fs.existsSync(path.join(d, 'favourites.json')));
    const g = new Favourites(d);
    assert.deepStrictEqual(g.list(), [{ name: 'Red', hex: '#FF0000' }]);
    assert.strictEqual(g.remove('#ff0000'), true);
    assert.strictEqual(g.remove('#ff0000'), false);
    assert.strictEqual(new Favourites(d).list().length, 0);
});
test('at most MAX, oldest dropped; a damaged file is ignored', () => {
    const d = dir();
    const f = new Favourites(d);
    for (let i = 0; i < MAX + 3; i++) f.add('#' + ('000000' + (i * 1000).toString(16)).slice(-6));
    assert.strictEqual(f.list().length, MAX);
    fs.writeFileSync(path.join(d, 'favourites.json'), '{not json');
    assert.strictEqual(new Favourites(d).list().length, 0);
});
test('complete configurations: add, replace by name, remove, persist', () => {
    const d = dir();
    const f = new Favourites(d);
    const p = f.addPreset('Evening', { mode: 'dual', top: { colour: { r: 1, g: 2, b: 3 }, brightness: 70 } });
    assert.strictEqual(p.program.bottom.brightness, 45, 'defaults filled');
    f.addPreset('Evening', { mode: 'wave' });
    assert.strictEqual(f.presets().length, 1, 'replaced by name');
    assert.strictEqual(f.presets()[0].program.mode, 'wave');
    assert.strictEqual(new Favourites(d).presets()[0].name, 'Evening');
    assert.strictEqual(f.removePreset('Evening'), true);
    assert.strictEqual(f.removePreset('Evening'), false);
});
test('no data dir: works in memory', () => {
    const f = new Favourites(null);
    assert.strictEqual(f.add('#123456'), true);
    assert.strictEqual(f.list().length, 1);
});

module.exports = run('favourites');

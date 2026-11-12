'use strict';
const fs = require('fs');
const path = require('path');
const { test, run, assert } = require('./t');
const { STAGE, JS } = require('../../scripts/stage');
const { OemLighting, profileName, AMBIENT, COMFORT } = require(path.join(JS, 'oem_lighting'));
const { harness } = require('./ui_harness');

/** A signals module that records every call and feeds the handlers. */
function fakeSignals(values, errors) {
    const calls = [];
    const s = {
        calls,
        hasNative: () => true,
        loadConfig: () => { throw new Error('unused'); },
        proxy: async () => { calls.push('proxy'); throw new Error('unused'); },
        set: async () => { calls.push('set'); },
        call: async () => { calls.push('call'); },
        watch: async (iface, instance, handlers) => {
            calls.push('watch ' + iface + ' ' + instance + ' ' + Object.keys(handlers).join(','));
            if (errors && errors[iface]) return { iface, available: false, error: errors[iface], shutdown: async () => {} };
            Object.keys(handlers).forEach((f) => { if (values && f in values) handlers[f](values[f]); });
            return { iface, available: true, error: null, shutdown: async () => { calls.push('shutdown ' + iface); } };
        },
    };
    return s;
}

test('profile names: numbers, numeric strings and catalog names', () => {
    assert.strictEqual(profileName(6), 'Sky Blue (6)');
    assert.strictEqual(profileName('8'), 'Orange (8)');
    assert.strictEqual(profileName('SKYBLUE'), 'SKYBLUE');
    assert.strictEqual(profileName(99), 'profile (99)');
    assert.strictEqual(profileName(null), null);
});

test('reads both interfaces on instance 1 and decodes what came back', async () => {
    const sig = fakeSignals({
        ambientLightActive: true, brightnessAmbientLight: 5, brightnessAmbientContourLine: 3,
        currentInteriorLightProfile: { currentLightProfileId: 6 },
        statusAmbientLightInteriorColour: { statusHueInteriorLighting: 210, statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_4', statusModeAmbientePanoramicRoofInteriorLighting: 'EIN' },
    });
    const o = await new OemLighting(sig, null).start();
    assert.ok(sig.calls[0].startsWith('watch ' + AMBIENT + ' 1 '));
    assert.ok(sig.calls[1].startsWith('watch ' + COMFORT + ' 1 '));
    const s = o.state();
    assert.strictEqual(s.active, true);
    assert.strictEqual(s.brightness, 5);
    assert.strictEqual(s.profile, 6);
    assert.strictEqual(s.hue, 210);
    const [light, colour] = o.summary();
    assert.strictEqual(light, 'on, brightness 5, contour 3 (read-only)');
    assert.strictEqual(colour, 'Sky Blue (6), selection FARBAUSWAHL_4, hue 210, mode on');
});

test('never writes: only watch (and shutdown) is ever called', async () => {
    const sig = fakeSignals({ ambientLightActive: false });
    const o = await new OemLighting(sig, null).start();
    await o.start();                                   // a second start does nothing
    o.summary(); o.state();
    await o.shutdown();
    assert.deepStrictEqual(sig.calls.map((c) => c.split(' ')[0]), ['watch', 'watch', 'shutdown', 'shutdown']);
    assert.strictEqual(o.summary()[0], 'off (read-only)');
});

test('unreachable interfaces and a missing signals module are reported, not thrown', async () => {
    const o = await new OemLighting(fakeSignals({}, { [AMBIENT]: 'Error: no SOME/IP config', [COMFORT]: 'denied' }), null).start();
    assert.ok(/^not reachable \(no SOME\/IP config\)/.test(o.summary()[0]), o.summary()[0]);
    assert.ok(/^not reachable \(denied\)/.test(o.summary()[1]));
    const none = await new OemLighting(null, null).start();
    assert.ok(/not reachable/.test(none.summary()[0]));
    const quiet = await new OemLighting(fakeSignals({}), null).start();
    assert.strictEqual(quiet.summary()[0], 'no value yet');
});

test('app.json asks for these fields read-only: no "w" flag, both optional', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(STAGE, 'app.json'), 'utf8'));
    for (const iface of [AMBIENT, COMFORT]) {
        const sig = spec.signals[iface];
        assert.ok(sig && sig._optional, iface + ' must be optional');
        Object.keys(sig).filter((k) => k[0] !== '_').forEach((f) => assert.ok(!/w/.test(sig[f]), iface + '.' + f + ' must not be writable'));
        assert.ok(!sig._methods, 'no methods');
    }
    assert.ok(!('ambientLightInteriorColour' in spec.signals[COMFORT]), 'the control field is not requested');
});

test('the Diagnostics page shows the read-out', async () => {
    const sig = fakeSignals({ ambientLightActive: true, brightnessAmbientLight: 4, currentInteriorLightProfile: { currentLightProfileId: 8 } });
    const h = await harness({ signals: sig });
    await new Promise((r) => setTimeout(r, 20));
    h.app.setPage(4);
    const cv = await h.frame();
    const text = JSON.stringify(cv.ops || cv.cmds || cv.list || cv);
    assert.deepStrictEqual(h.app.oem.summary(), ['on, brightness 4 (read-only)', 'Orange (8)']);
    assert.ok(!sig.calls.some((c) => /^(set|call)/.test(c)), 'no writes');
    assert.ok(text.length > 0);
});

module.exports = run('oem_lighting');

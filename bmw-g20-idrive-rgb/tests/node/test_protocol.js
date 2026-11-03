'use strict';
const path = require('path');
const { test, run, assert } = require('./t');
const { JS } = require('../../scripts/stage');
const P = require(path.join(JS, 'lighting_protocol'));

test('layering write bytes follow the SGBD ARG order: DID NAD ZUSTAND HELLIGKEIT ROT GRUEN BLAU ZEIT', () => {
    const b = P.encodeLayeringWrite({ bus: 1, nad: 3, active: true, brightness: 100, r: 0xD7, g: 0x6E, b: 0x14, seconds: 10 });
    assert.deepStrictEqual(b, [0xDA, 0x5E, 3, 1, 100, 0xD7, 0x6E, 0x14, 10]);
    assert.strictEqual(P.hexBytes([0x2E].concat(b)), '2E DA 5E 03 01 64 D7 6E 14 0A');
});
test('bus 1 brightness is capped at 100, bus 2 at 255; seconds at 254; inactive = 0', () => {
    assert.strictEqual(P.encodeLayeringWrite({ bus: 1, nad: 1, brightness: 200, r: 1, g: 2, b: 3, seconds: 300 })[4], 100);
    const b2 = P.encodeLayeringWrite({ bus: 2, nad: 1, brightness: 200, r: 1, g: 2, b: 3, seconds: 300 });
    assert.deepStrictEqual(b2.slice(0, 2), [0xE3, 0xD1]);
    assert.strictEqual(b2[4], 200);
    assert.strictEqual(b2[8], 254);
    assert.strictEqual(P.encodeLayeringWrite({ bus: 1, nad: 1, active: false, r: 0, g: 0, b: 0, seconds: 0 })[3], 0);
    assert.strictEqual(P.encodeLayeringWrite({ bus: 1, nad: 1, r: 0, g: 0, b: 0 })[4], 100, 'default brightness is full');
});
test('NAD above 31 is refused by the encoder', () => {
    assert.throws(() => P.encodeLayeringWrite({ bus: 1, nad: 32, r: 0, g: 0, b: 0 }), RangeError);
});
test('other encoders', () => {
    assert.deepStrictEqual(P.encodeRead(0xDA5F), [0xDA, 0x5F]);
    assert.deepStrictEqual(P.encodeBrightnessOffset(300), [0xD5, 0x19, 255]);
    assert.deepStrictEqual(P.encodeModeWrite(0x1C, 5), [0x48, 0x04, 0x1C, 5]);
});
test('decodeReply: positive, negative, foreign, empty', () => {
    assert.deepStrictEqual(P.decodeReply(0x2E, 0xDA5E, [0x6E, 0xDA, 0x5E]), { ok: true, data: [] });
    const neg = P.decodeReply(0x2E, 0xDA5E, [0x7F, 0x2E, 0x7F]);
    assert.strictEqual(neg.ok, false); assert.strictEqual(neg.nrc, 0x7F); assert.strictEqual(neg.name, 'serviceNotSupportedInActiveSession');
    assert.strictEqual(P.decodeReply(0x22, 0xF150, [0x62, 0xF1, 0x90, 1]).ok, false, 'other identifier');
    assert.strictEqual(P.decodeReply(0x22, 0xF150, [0x62, 0xF4, 0x0C, 0x0B]).reason, 'unexpected identifier');
    assert.strictEqual(P.decodeReply(0x22, 0xF150, null).reason, 'no reply');
    assert.deepStrictEqual(P.decodeReply(0x22, 0xF150, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0x80]).data, [0x0F, 0x26, 0x80]);
});
test('SGBD index: known body controllers and unknown ones', () => {
    const v = P.decodeSgbdIndex([0x0F, 0x26, 0x80]);
    assert.strictEqual(v.index, '0F2680'); assert.strictEqual(v.sgbd, 'BDC_G05'); assert.strictEqual(v.rgbActuator, 'documented');
    assert.strictEqual(P.decodeSgbdIndex([0x0F, 0x20, 0x50]).rgbActuator, 'legacy');
    const u = P.decodeSgbdIndex([0x0F, 0x99, 0x99]);
    assert.strictEqual(u.sgbd, null); assert.strictEqual(u.rgbActuator, 'unknown');
    assert.strictEqual(P.decodeSgbdIndex([1]), null);
});
test('LIN 1 status: one location byte per NAD, FF and 00 are no slave', () => {
    const s = P.decodeLin1Status([0x13, 0xFF, 0x05, 0x00, 0x4B]);
    assert.deepStrictEqual(s.map((x) => [x.nad, x.locationId]), [[1, 0x13], [3, 0x05], [5, 0x4B]]);
    assert.strictEqual(s[0].location, 'Contour line dashboard driver');
    assert.strictEqual(s[2].location, 'Cupholder front');
    assert.strictEqual(P.decodeLin1Status([0x99])[0].location, 'location 0x99');
});
test('LIN 2 status: 5 bytes per slave in the documented BLUE, GREEN, RED, brightness order', () => {
    const s = P.decodeLin2Status([0x01, 10, 20, 30, 99, 0xFF, 0, 0, 0, 0, 0x03, 1, 2, 3, 4]);
    assert.strictEqual(s.length, 2);
    assert.deepStrictEqual([s[0].nad, s[0].b, s[0].g, s[0].r, s[0].brightness], [1, 10, 20, 30, 99]);
    assert.strictEqual(s[1].nad, 3); assert.strictEqual(s[1].bus, 2);
});
test('PWM status, FASTA, SVK', () => {
    const pwm = P.decodePwmStatus([0, 64, 64, 64, 64, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.strictEqual(pwm.length, 13); assert.strictEqual(pwm[1].name, 'INNENLICHT_LCI_0'); assert.strictEqual(pwm[1].pwm, 64);
    const f = P.decodeFasta([0, 0, 0x10, 0, 0, 0, 0, 5, 0, 0, 0, 1, 0x13, 0xFF]);
    assert.deepStrictEqual([f.bdcActiveSeconds, f.ambientOnSeconds, f.ambientReducedWhileDrivingSeconds], [0x1000, 5, 1]);
    assert.strictEqual(f.slaves.length, 1);
    const svk = P.decodeSvk([6, 0, 0, 0x3F, 0x36, 0, 15, 2, 5, 0, 0, 0x51, 0xDD, 0, 17, 72]);
    assert.deepStrictEqual(svk, [{ type: 'BTLD', id: '00003F36', version: '000.015.002' }, { type: 'CAFD', id: '000051DD', version: '000.017.072' }]);
});
test('checkRequest: the allow list', () => {
    const w = P.encodeLayeringWrite({ bus: 1, nad: 1, r: 1, g: 2, b: 3, seconds: 5 });
    assert.strictEqual(P.checkRequest(0x40, 0x2E, w), null, 'the layering write to the BDC');
    assert.ok(P.checkRequest(0x12, 0x2E, w), 'not to the DME');
    assert.ok(P.checkRequest(0x40, 0x2E, [0xD5, 0x19, 1]), 'not the brightness offset (not on the list)');
    assert.ok(P.checkRequest(0x40, 0x2E, w.slice(0, 8)), 'not a short write');
    assert.ok(P.checkRequest(0x40, 0x2E, [0x36, 0x0A, 1, 2, 3, 4, 5, 6, 7]), 'never coding data');
    assert.strictEqual(P.checkRequest(0x40, 0x22, [0xDA, 0x5F]), null);
    assert.strictEqual(P.checkRequest(0x12, 0x22, [0xF1, 0x50]), null, 'reads anywhere');
    assert.strictEqual(P.checkRequest(0xDF, 0x22, [0xF1, 0x50]), null, 'the discovery read to all units');
    assert.ok(P.checkRequest(0xDF, 0x22, [0xDA, 0x5F]), 'no other functional read');
    assert.ok(P.checkRequest(0x40, 0x22, [0xDA]), 'half an identifier');
    assert.strictEqual(P.checkRequest(0x40, 0x10, [0x03]), null, 'extended session to the BDC');
    assert.ok(P.checkRequest(0x40, 0x10, [0x02]), 'never the programming session');
    assert.ok(P.checkRequest(0x12, 0x10, [0x03]), 'no session elsewhere');
    [0x14, 0x11, 0x27, 0x2F, 0x31, 0x3E, 0x85, 0x34].forEach((sid) => assert.ok(P.checkRequest(0x40, sid, [0, 0, 0]), 'service ' + sid.toString(16)));
    assert.ok(P.checkRequest(0x40, 0x22, [0x1FF, 0]), 'bad byte');
});

module.exports = run('protocol');

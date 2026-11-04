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
test('LIN status: the 10-byte records the car sent (bus 1, 7 passenger-side slaves showing the Violet preset)', () => {
    const empty = [0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x03, 0x07, 0x07, 0x07, 0x07];
    let data = [];
    [0x0F, 0x0E, 0x0C, 0x12, 0x22, 0x10, 0x04].forEach((loc) => { data = data.concat([loc, 0xFE, 0x3C, 0x78, 0x64, 0, 0, 0, 0, 0]); });
    for (let i = 0; i < 19; i++) data = data.concat(empty);
    data.push(0x02);
    const s = P.decodeLin1Status(data);
    assert.strictEqual(s.length, 7);
    assert.deepStrictEqual(s.map((x) => x.nad), [1, 2, 3, 4, 5, 6, 7]);
    assert.strictEqual(s[0].location, 'Map pocket passenger door front');
    assert.strictEqual(s[6].location, 'Footwell passenger rear');
    assert.deepStrictEqual([s[0].r, s[0].g, s[0].b, s[0].brightness, s[0].white], [0x78, 0x3C, 0xFE, 100, 0]);
    assert.deepStrictEqual(s[0].faults, { shortCircuit: 0, overTemp: 0, openLoad: 0, internal: 0 });
    const s2 = P.decodeLin2Status(empty.concat([0x13, 1, 2, 3, 4, 5, 0, 0, 0, 0]));
    assert.strictEqual(s2.length, 1); assert.strictEqual(s2[0].bus, 2); assert.strictEqual(s2[0].nad, 2); assert.strictEqual(s2[0].r, 3);
    assert.strictEqual(P.decodeLin1Status([0x99, 0, 0, 0, 0, 0, 0, 0, 0, 0])[0].location, 'location 0x99');
    assert.strictEqual(P.decodeLin1Status([0x13, 1, 2]).length, 0, 'a partial record is not a slave');
});
test('PWM status, FASTA, SVK', () => {
    const pwm = P.decodePwmStatus([0, 64, 64, 64, 64, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.strictEqual(pwm.length, 13); assert.strictEqual(pwm[1].name, 'INNENLICHT_LCI_0'); assert.strictEqual(pwm[1].pwm, 64);
    const f = P.decodeFasta([0, 0, 0x10, 0, 1, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0, 7, 0, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0, 1, 0x13, 0xFF]);
    assert.deepStrictEqual([f.bdcActiveSeconds, f.lightSwordFitted, f.lightSwordOnSeconds, f.ambientOnSeconds, f.ambientReducedWhileDrivingSeconds], [0x1000, 1, 7, 9, 1]);
    assert.strictEqual(f.slaveLocations.length, 1);
    assert.strictEqual(P.decodeFasta([1, 2, 3]), null);
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

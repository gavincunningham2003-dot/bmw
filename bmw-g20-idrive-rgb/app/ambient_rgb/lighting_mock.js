'use strict';
/**
 * mock.js - a simulated BDC body controller and the MockLightingController on top of it.
 *
 * MockBdc answers UDS requests BYTE FOR BYTE the way the reference documents the BDC_G05 (protocol.js), so the
 * same encoders / decoders, the same Diag transport code (through tests/node/fake_tasu.js) and the same UI run
 * against it as against the car. It models:
 *   - the SGBD index (22 F1 50), SVK (22 F1 01), VIN (22 F1 90, a fake one)
 *   - LIN layering slaves with installation locations (22 DA 5F, 22 E3 D1 read-back)
 *   - the layering actuator (2E DA 5E / 2E E3 D1): a slave shows the colour for ZEIT seconds, then returns to OEM
 *   - the interior-light PWM status (22 48 00) and FASTA statistics (22 23 00)
 *   - faults to test against: needsExtendedSession (7F 2E 7F until 10 03, which lapses after s3Ms), rejectNrc,
 *     dropNext (no reply n times), busyOnce (7F 2E 21), offline (nothing answers)
 * Time is injectable (opts.now) so expiry can be tested without waiting.
 */
const P = require('./lighting_protocol');
const { LightingController } = require('./lighting_controller');

const DEFAULT_SLAVES = [0x13, 0x15, 0x17, 0x05, 0x06, 0x0C, 0x0D, 0x09, 0x10, 0x01, 0x03, 0x2B, 0x2D];   // a generic set, one bus (the tests count on 13)
/** The layout read from the car on 2026-11-04 (G20 330e, BDC 0F2680): 7 slaves on FI-LIN-1, 12 on FI-LIN-2, by NAD order. */
const G20_SLAVES = Object.freeze({
    bus1: [0x0F, 0x0E, 0x0C, 0x12, 0x22, 0x10, 0x04],
    bus2: [0x15, 0x17, 0x13, 0x01, 0x03, 0x08, 0x07, 0x05, 0x0B, 0x21, 0x09, 0x02],
});

class MockBdc {
    constructor(opts) {
        const o = opts || {};
        this.now = o.now || Date.now;
        this.sgbdIndex = o.sgbdIndex || '0F2680';
        this.oem = o.oem || { r: 0x90, g: 0xE0, b: 0x90 };          // "White" in the BDC's colour library
        this.oemOn = o.oemOn !== false;
        this.s3Ms = o.s3Ms || 5000;
        this.needsExtendedSession = !!o.needsExtendedSession;
        this.rejectNrc = o.rejectNrc || null;
        this.dropNext = o.dropNext || 0;
        this.busyOnce = !!o.busyOnce;
        this.busyEvery = o.busyEvery || 0;                           // every Nth write answers NRC 21 (0 = never)
        this.rejectKeys = new Set(o.rejectKeys || []);               // 'bus:nad' modules that refuse writes with NRC 31
        this.offline = !!o.offline;
        this.writes = 0;
        this.session = 1; this.sessionAt = 0;
        const mk = (bus) => (loc, i) => ({ bus, nad: i + 1, locationId: loc, active: false, r: 0, g: 0, b: 0, brightness: 0, until: 0 });
        const real = !o.slaves && !o.slaves2;                       // no layout given: the G20's own (19 modules)
        this.slaves = (o.slaves || (real ? G20_SLAVES.bus1 : [])).map(mk(1)).concat((o.slaves2 || (real ? G20_SLAVES.bus2 : [])).map(mk(2)));
        this.requests = [];                                          // every request seen: { target, sid, data }
    }
    _sessionOk() { if (this.session === 3 && this.now() - this.sessionAt > this.s3Ms) this.session = 1; return this.session === 3; }
    /** The colour a slave shows right now (the physical LEDs), for tests and the UI preview. */
    physical(nad, bus) {
        const s = this.slaves.find((x) => x.nad === nad && x.bus === (bus || 1)) || this.slaves[0];
        if (s && s.active && this.now() < s.until) return { r: s.r, g: s.g, b: s.b, source: 'custom', brightness: s.brightness };
        return this.oemOn ? Object.assign({ source: 'oem', brightness: 100 }, this.oem) : { r: 0, g: 0, b: 0, source: 'off', brightness: 0 };
    }
    /** RES_0xDA5F_D / RES_0xE3D1_D: 26 ten-byte records (location, b, g, r, brightness, white, 4 faults) + a trailing byte. */
    _linStatus(bus) {
        const b = [];
        const mine = this.slaves.filter((x) => x.bus === bus);
        for (let i = 0; i < 26; i++) {
            const s = mine[i];
            if (!s) { b.push(0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x03, 0x07, 0x07, 0x07, 0x07); continue; }
            const ph = this.physical(s.nad, bus);
            b.push(s.locationId, ph.b, ph.g, ph.r, ph.brightness, 0, 0, 0, 0, 0);
        }
        b.push(0x02);
        return b;
    }
    /** UDS request -> reply bytes (after the transport), or null for no reply. */
    uds(target, sid, data) {
        data = Array.prototype.slice.call(data);
        this.requests.push({ target, sid, data: data.slice() });
        if (this.offline) return null;
        if (target !== P.ADDR.BDC_BODY && target !== P.ADDR.ALL) return null;
        if (this.dropNext > 0) { this.dropNext--; return null; }
        const neg = (nrc) => [0x7F, sid, nrc];
        if (sid === P.SID.SESSION) {
            if (data[0] === 0x03 || data[0] === 0x01) { this.session = data[0]; this.sessionAt = this.now(); return [0x50, data[0], 0x00, 0x32, 0x01, 0xF4]; }
            return neg(0x12);
        }
        if (sid === P.SID.READ) {
            const did = (data[0] << 8) | data[1];
            const out = [0x62, data[0], data[1]];
            switch (did) {
                case P.DID.SGBD_INDEX: return out.concat([parseInt(this.sgbdIndex.slice(0, 2), 16), parseInt(this.sgbdIndex.slice(2, 4), 16), parseInt(this.sgbdIndex.slice(4, 6), 16)]);
                case P.DID.SVK: return out.concat([1, 0, 0, 0x8B, 0x1B, 0, 1, 1, 6, 0, 0, 0x3F, 0x36, 0, 15, 2, 5, 0, 0, 0x51, 0xDD, 0, 17, 72, 8, 0, 0, 0x9A, 0x01, 0, 15, 2]);
                case P.DID.VIN: return out.concat(Array.from('WBA0MOCK000000000').map((c) => c.charCodeAt(0)));
                case P.DID.LIN1_LAYERING_STATUS: return out.concat(this._linStatus(1));
                case P.DID.LIN2_LAYERING: return out.concat(this._linStatus(2));     // nothing on the second bus in this mock
                case P.DID.INNENLICHT_PWM: return out.concat([0, 64, 64, 64, 64, 0, 0, 0, 0, 0, 0, 0, 0]);
                case P.DID.FASTA_LIGHT: return out.concat([0, 0x12, 0x34, 0x56, 1, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0x20, 0, 0, 0, 0, 0x10, 0]).concat(this.slaves.map((s) => s.locationId));
                default: return neg(0x31);
            }
        }
        if (sid === P.SID.WRITE) {
            const did = (data[0] << 8) | data[1];
            if (did !== P.DID.LIN1_LAYERING_CTRL && did !== P.DID.LIN2_LAYERING) return neg(0x31);
            if (this.needsExtendedSession && !this._sessionOk()) return neg(0x7F);
            if (this.busyOnce) { this.busyOnce = false; return neg(0x21); }
            this.writes++;
            if (this.busyEvery && this.writes % this.busyEvery === 0) return neg(0x21);
            if (this.rejectNrc) return neg(this.rejectNrc);
            if (data.length !== 9) return neg(0x13);
            const nad = data[2];
            if (nad > 31) return neg(0x31);
            const s = this.slaves.find((x) => x.nad === nad && x.bus === (did === P.DID.LIN2_LAYERING ? 2 : 1));
            if (!s) return neg(0x31);
            if (this.rejectKeys.has(s.bus + ':' + s.nad)) return neg(0x31);
            // as the car: a colour byte of 0xFF leaves that channel unchanged
            s.active = data[3] === 1; s.brightness = data[4];
            if (data[5] !== 0xFF) s.r = data[5];
            if (data[6] !== 0xFF) s.g = data[6];
            if (data[7] !== 0xFF) s.b = data[7];
            s.until = data[3] === 1 ? this.now() + data[8] * 1000 : 0;
            return [0x6E, data[0], data[1]];
        }
        return neg(0x11);
    }
}

/** The full LightingController on a MockBdc: the UI and its tests run on this without a car. */
class MockLightingController extends LightingController {
    constructor(opts) {
        super(Object.assign({ kind: 'mock' }, opts));
        const o = opts || {};
        this.bdc = o.bdc instanceof MockBdc ? o.bdc : new MockBdc(Object.assign({ now: this._now }, o.bdc || {}, o.mock || {}));
        this.online = o.online !== false;
        this.sessionNeeded = false;
        this.latencyMs = o.latencyMs || 0;                           // simulated transport time per write (via the injected timers)
    }
    _available() { return this.online && !this.bdc.offline; }
    _delay() { return this.latencyMs ? new Promise((r) => this._setTimeout(r, this.latencyMs)) : Promise.resolve(); }
    _exchange(sid, data) {
        this.lastRequest = P.hexBytes([sid].concat(data));
        const r = this.bdc.uds(P.ADDR.BDC_BODY, sid, data);
        this.lastReply = r ? P.hexBytes(r) : null;
        return r ? Array.prototype.slice.call(r) : null;
    }
    async _probe() {
        if (!this._available()) return { available: false, reason: 'mock transport offline', transport: 'mock', slaves: [], rgbActuator: 'unknown' };
        const ident = P.decodeReply(P.SID.READ, P.DID.SGBD_INDEX, this._exchange(P.SID.READ, P.encodeRead(P.DID.SGBD_INDEX)));
        const variant = ident.ok ? P.decodeSgbdIndex(ident.data) : null;
        const st = P.decodeReply(P.SID.READ, P.DID.LIN1_LAYERING_STATUS, this._exchange(P.SID.READ, P.encodeRead(P.DID.LIN1_LAYERING_STATUS)));
        const st2 = P.decodeReply(P.SID.READ, P.DID.LIN2_LAYERING, this._exchange(P.SID.READ, P.encodeRead(P.DID.LIN2_LAYERING)));
        const slaves = (st.ok ? P.decodeLin1Status(st.data) : []).concat(st2.ok ? P.decodeLin2Status(st2.data) : []);
        return { available: true, transport: 'mock', bdcReachable: ident.ok, variant, rgbActuator: variant ? variant.rgbActuator : 'unknown', slaves, verified: { layeringWrite: 'simulated' }, notes: ['simulated BDC: nothing reaches a car'] };
    }
    async _readSlaves() {
        const st = P.decodeReply(P.SID.READ, P.DID.LIN1_LAYERING_STATUS, this._exchange(P.SID.READ, P.encodeRead(P.DID.LIN1_LAYERING_STATUS)));
        if (!st.ok) return null;
        const st2 = P.decodeReply(P.SID.READ, P.DID.LIN2_LAYERING, this._exchange(P.SID.READ, P.encodeRead(P.DID.LIN2_LAYERING)));
        const known = this.slaves;
        return P.decodeLin1Status(st.data).concat(st2.ok ? P.decodeLin2Status(st2.data) : []).map((s) => Object.assign({}, known.find((k) => k.nad === s.nad && k.bus === s.bus) || {}, s));
    }
    async _writeSlave(slave, params) {
        const bytes = P.encodeLayeringWrite({ bus: slave.bus, nad: slave.nad, active: params.active, brightness: params.brightness, r: params.r, g: params.g, b: params.b, seconds: params.seconds });
        const bad = P.checkRequest(P.ADDR.BDC_BODY, P.SID.WRITE, bytes);
        if (bad) return { ok: false, reason: 'blocked: ' + bad };
        await this._delay();
        if (!this._available()) return { ok: false, reason: 'transport lost' };
        const did = (bytes[0] << 8) | bytes[1];
        let reply = this._exchange(P.SID.WRITE, bytes);
        let dec = P.decodeReply(P.SID.WRITE, did, reply);
        if (!dec.ok && (dec.nrc === 0x7E || dec.nrc === 0x7F)) {          // not in this session: open the extended one and retry once
            const sess = this._exchange(P.SID.SESSION, [0x03]);
            this.sessionNeeded = true;
            if (sess && sess[0] === 0x50) { reply = this._exchange(P.SID.WRITE, bytes); dec = P.decodeReply(P.SID.WRITE, did, reply); }
        }
        if (!dec.ok && dec.reason === 'no reply') dec.reason = 'timeout';
        return Object.assign({ bytes: P.hexBytes([P.SID.WRITE].concat(bytes)) }, dec);
    }
    /** What the (simulated) LEDs show: one module (default the first) or, with key 'bus:nad', that one. */
    physicalColour(key) {
        if (key) { const m = /^(\d+):(\d+)$/.exec(key); if (m) return this.bdc.physical(+m[2], +m[1]); }
        return this.bdc.physical(this.slaves.length ? this.slaves[0].nad : 1, this.slaves.length ? this.slaves[0].bus : 1);
    }
    status() { return Object.assign(super.status(), { lastRequest: this.lastRequest || null, lastReply: this.lastReply || null }); }
}

module.exports = { MockBdc, MockLightingController, DEFAULT_SLAVES, G20_SLAVES };

'use strict';
/**
 * bdc_uds.js - Approach 2: the BDC's layering actuator over the head unit's own diagnostic link.
 *
 * Transport: kit/diag.js (UDS over the InternalTasu SOME/IP service, exactly as the Fault Scanner, Live Data
 * and Engine Config apps use it). Target: the BDC body, diagnostic address 0x40 (a G20 330e's own SVT,
 * kit/runtime/ecus.js). Request: 2E DA5E NAD ZUSTAND HELLIGKEIT ROT GRUEN BLAU ZEIT
 * (protocol.js, from the BDC_G05 SGBD reference). Expected positive reply: 6E DA 5E.
 *
 * Gates, in order, before a single write byte leaves the head unit:
 *   1. armed: the app setting "arm" must be on; otherwise every write is a DRY RUN (logged, nothing sent).
 *   2. the BDC answered 22 F1 50 with an SGBD index the reference documents with an RGB actuator
 *      ('documented'), or the setting allowUnknownVariant is on;
 *   3. the slave list came from the car (22 DA 5F), not from a default;
 *   4. protocol.checkRequest(): only 22 anywhere, 2E to 0x40 with DID DA5E/E3D1 and 9 bytes, 10 03 to 0x40.
 * Writes never exceed maxSeconds (ZEIT 30 s here), so even a crashed app leaves the car in OEM state
 * within that time. Session handling as Engine Config does it for the DSC: a 7E/7F refusal opens the
 * extended session (10 03) once and retries; the session lapses by itself (S3) when writes stop.
 */
const P = require('./lighting_protocol');
const { LightingController } = require('./lighting_controller');

class BdcUdsLightingController extends LightingController {
    /**
     * opts.diag: a kit/diag.js Diag (already init()ed), or opts.signals + opts.log to make one in init().
     * opts.diagModule: the kit's diag module (for replyTo); defaults to require('./kit/diag').
     * opts.armed: bool (writes allowed); opts.allowUnknownVariant: bool; opts.maxSeconds: cap on ZEIT (30).
     */
    constructor(opts) {
        super(Object.assign({ kind: 'bdc-uds' }, opts));
        const o = opts || {};
        this.diag = o.diag || null;
        this.diagModule = o.diagModule || null;
        this.signals = o.signals || null;
        this.armed = !!o.armed;
        this.allowUnknownVariant = !!o.allowUnknownVariant;
        this.maxSeconds = Math.min(254, o.maxSeconds || 30);
        this.refreshSeconds = Math.min(this.refreshSeconds, this.maxSeconds);
        this.timeoutMs = o.timeoutMs || 3000;
        this.dryRuns = 0;
        this.lastRequest = null;
        this.lastReply = null;
        this.ident = null;
        this.slavesFromCar = false;
    }

    _kitDiag() { if (!this.diagModule) this.diagModule = require('./kit/diag'); return this.diagModule; }

    async init() {
        if (!this.diag) {
            const { Diag } = this._kitDiag();
            this.diag = await new Diag(this.signals, this.log).init();
        }
        if (this.diag.on) this.diag.on('available', (a) => this._availability(!!a));
        return this;
    }

    _available() { return !!(this.diag && this.diag.p && this.diag.available); }

    /** One physical request to the BDC body through the gate. */
    async _request(sid, data, timeoutMs) {
        const bad = P.checkRequest(P.ADDR.BDC_BODY, sid, data);
        if (bad) { this.log.error('blocked a request: ' + bad); return { blocked: bad }; }
        const { replyTo } = this._kitDiag();
        this.lastRequest = P.hexBytes([sid].concat(data));
        let uds = null;
        try { uds = await this.diag.physical(P.ADDR.BDC_BODY, sid, data, timeoutMs || this.timeoutMs, replyTo(sid, data)); } catch (e) { return { error: String(e && e.message || e) }; }
        this.lastReply = uds ? P.hexBytes(uds) : null;
        return { uds };
    }
    async _read(did) {
        const r = await this._request(P.SID.READ, P.encodeRead(did));
        if (r.blocked || r.error) return { ok: false, reason: r.blocked || r.error, nrc: null };
        return P.decodeReply(P.SID.READ, did, r.uds);
    }

    async _probe() {
        const caps = { available: this._available(), transport: 'tasu', bdcReachable: false, variant: null, rgbActuator: 'unknown', slaves: [], verified: {}, notes: [], armed: this.armed };
        if (!caps.available) { caps.reason = this.diag && this.diag.error ? this.diag.error : 'TASU diagnostic link not available'; return caps; }
        const ident = await this._read(P.DID.SGBD_INDEX);
        if (ident.ok) { caps.bdcReachable = true; caps.variant = P.decodeSgbdIndex(ident.data); caps.rgbActuator = caps.variant.rgbActuator; this.ident = caps.variant; }
        else { caps.reason = 'BDC (0x40) did not answer 22 F1 50: ' + ident.reason; caps.notes.push(caps.reason); }
        const svk = await this._read(P.DID.SVK);
        if (svk.ok) caps.svk = P.decodeSvk(svk.data);
        const st = await this._read(P.DID.LIN1_LAYERING_STATUS);
        if (st.ok) { caps.slaves = P.decodeLin1Status(st.data); this.slavesFromCar = true; caps.verified.lin1Status = true; } else caps.notes.push('22 DA 5F: ' + st.reason);
        const st2 = await this._read(P.DID.LIN2_LAYERING);
        if (st2.ok) { const s2 = P.decodeLin2Status(st2.data); caps.slaves = caps.slaves.concat(s2); this.slavesFromCar = true; caps.verified.lin2Status = true; caps.lin2 = s2; } else caps.notes.push('22 E3 D1: ' + st2.reason);
        this.busRead = { 1: !!st.ok, 2: !!st2.ok };
        const pwm = await this._read(P.DID.INNENLICHT_PWM);
        if (pwm.ok) caps.pwm = P.decodePwmStatus(pwm.data);
        if (caps.rgbActuator !== 'documented' && caps.rgbActuator !== 'verified' && !this.allowUnknownVariant) caps.notes.push('writes disabled: body controller variant is ' + caps.rgbActuator + ' for the RGB layering actuator');
        if (!this.armed) caps.notes.push('not armed: writes are dry runs');
        return caps;
    }

    /**
     * Both LIN buses, read and merged. A bus whose read fails keeps the modules last known for it (a refresh must
     * never shrink the list to one bus); null only when neither bus answered. this.busRead says which bus the
     * current list actually comes from the car for.
     */
    async _readSlaves() {
        const known = this.slaves;
        const st = await this._read(P.DID.LIN1_LAYERING_STATUS);
        const st2 = await this._read(P.DID.LIN2_LAYERING);
        this.busRead = { 1: !!st.ok, 2: !!st2.ok };
        if (!st.ok && !st2.ok) return null;
        const merge = (list) => list.map((s) => Object.assign({}, known.find((k) => k.nad === s.nad && k.bus === s.bus) || {}, s));
        const bus1 = st.ok ? merge(P.decodeLin1Status(st.data)) : known.filter((k) => k.bus === 1);
        const bus2 = st2.ok ? merge(P.decodeLin2Status(st2.data)) : known.filter((k) => k.bus === 2);
        this.slavesFromCar = true;
        return bus1.concat(bus2);
    }

    /** A dry run writes nothing, so there is nothing to read back. */
    _canVerify() { return this.armed; }

    canControl() {
        const base = super.canControl();
        if (!base.ok) return base;
        if (!this.slavesFromCar) return { ok: false, reason: 'slave list not read from the car' };
        const rgb = this.capabilities && this.capabilities.rgbActuator;
        if (rgb !== 'documented' && rgb !== 'verified' && !this.allowUnknownVariant) return { ok: false, reason: 'body controller variant not documented with an RGB actuator (' + rgb + ')' };
        return { ok: true };
    }

    async _writeSlave(slave, params) {
        const bytes = P.encodeLayeringWrite({ bus: slave.bus, nad: slave.nad, active: params.active, brightness: params.brightness, r: params.r, g: params.g, b: params.b, seconds: Math.min(this.maxSeconds, params.seconds) });
        const shown = P.hexBytes([P.SID.WRITE].concat(bytes));
        if (!this.armed) { this.dryRuns++; this.log.info('DRY RUN (not armed): 0x40 <- ' + shown); return { ok: true, dryRun: true, bytes: shown }; }
        const did = (bytes[0] << 8) | bytes[1];
        let r = await this._request(P.SID.WRITE, bytes);
        if (r.blocked || r.error) return { ok: false, reason: r.blocked || r.error, bytes: shown };
        let dec = P.decodeReply(P.SID.WRITE, did, r.uds);
        if (!dec.ok && (dec.nrc === 0x7E || dec.nrc === 0x7F)) {
            const s = await this._request(P.SID.SESSION, [0x03]);
            if (s.uds && s.uds[0] === 0x50) { r = await this._request(P.SID.WRITE, bytes); if (!r.blocked && !r.error) dec = P.decodeReply(P.SID.WRITE, did, r.uds); }
        }
        if (!dec.ok && dec.reason === 'no reply') dec.reason = 'timeout';
        return Object.assign({ bytes: shown }, dec);
    }

    status() {
        return Object.assign(super.status(), { armed: this.armed, dryRuns: this.dryRuns, lastRequest: this.lastRequest, lastReply: this.lastReply, slavesFromCar: this.slavesFromCar, allowUnknownVariant: this.allowUnknownVariant });
    }
}

module.exports = { BdcUdsLightingController };

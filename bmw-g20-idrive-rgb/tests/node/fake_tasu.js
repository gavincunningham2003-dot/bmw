'use strict';
/**
 * fake_tasu.js - the head unit's diagnostic transport, faked: a real kit/diag.js Diag whose
 * signals.call() routes every sendTasuRequest into a MockBdc (or any uds(target, sid, data) function) and
 * emits the reply as a 'frame' the way diag.js parses TASU responses. Other apps' traffic can be mixed in
 * (foreign frames), as kit/tools/test_diag_replies.js does for Engine Config.
 *
 *   const { bus } = require('./fake_tasu');
 *   const b = bus(stageJs, mockBdc, { foreign: [[0x62, 0xF4, 0x0C, 0x0B, 0xB8]], delayMs: 2, available: true });
 *   const ctl = new BdcUdsLightingController({ diag: b.diag, diagModule: b.diagModule, armed: true, ... });
 */
const path = require('path');

function bus(stageJs, target, opts) {
    const o = opts || {};
    const diagModule = require(path.join(stageJs, 'kit', 'diag'));
    const { Diag } = diagModule;
    const log = o.log || { info() {}, warn() {}, error() {} };
    const sent = [];
    let online = o.available !== false;
    const d = new Diag({
        call: async (p, m, a) => {
            const data = Array.from(a.udsData);
            sent.push({ target: a.targetAddress, sid: a.serviceID, data });
            if (!online) return 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED';
            const reply = typeof target === 'function' ? target(a.targetAddress, a.serviceID, data) : target.uds(a.targetAddress, a.serviceID, data);
            const frames = (o.foreign || []).map((f) => ({ ecu: o.foreignEcu == null ? 0x12 : o.foreignEcu, uds: f }));
            if (reply) frames.push({ ecu: a.targetAddress, uds: Array.from(reply) });
            frames.forEach((f, i) => setTimeout(() => d.emit('frame', f), (o.delayMs == null ? 2 : o.delayMs) + i * 2));
            return 'NO_ERROR';
        },
    }, log);
    d.p = {}; d.available = online;
    d.busyMs = 1;                                    // retries fast in tests
    return {
        diag: d, diagModule, sent,
        /** the transport goes away / comes back (TASU availability event) */
        setAvailable(on) { online = on; d.available = on; d.emit('available', on); },
    };
}

module.exports = { bus };

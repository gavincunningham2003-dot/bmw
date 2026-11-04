'use strict';
/**
 * protocol.js - the bytes of the BDC's interior-light diagnostic functions. Pure: no transport.
 *
 * SOURCE OF THE IDENTIFIERS: the public EdiabasX SGBD reference for BDC_G05.prg ("Body Domain Controller
 * BDC-03 (from SP18)", revision 1.000): https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/BDC_G05/ -
 * table SG_FUNKTIONEN rows INNENLICHT_* and their ARG_/RES_ tables (see PROTOCOL_FINDINGS.md for the
 * verbatim rows). BDC-03 / SP18 is the G20's body controller generation, but WHICH SGBD this car's BDC
 * answers to (22 F1 50) must be read from the car before any write. Byte ORDER inside a DID follows the
 * SGBD table order (ARG rows top to bottom), as kit/tools/sgbd_catalog.py relies on for RES tables; it
 * is marked ASSUMED until a write is accepted and read back on a car.
 *
 * Nothing in here sends anything. Encoders return the bytes after the service id.
 */

const ADDR = Object.freeze({ BDC_BODY: 0x40, BDC_GATEWAY: 0x10, HEAD_UNIT: 0x63, DME: 0x12, ALL: 0xDF, TESTER: 0xF2 });
const SID = Object.freeze({ SESSION: 0x10, READ_DTC: 0x19, READ: 0x22, WRITE: 0x2E, IO: 0x2F, ROUTINE: 0x31, TESTER_PRESENT: 0x3E });

/** DIDs of BDC_G05's SG_FUNKTIONEN that concern the interior / ambient light, with the service each row lists. */
const DID = Object.freeze({
    LIN1_LAYERING_CTRL: 0xDA5E,     // INNENLICHT_FI_LIN_1_LAYERING_STEUERN  2E   "Ansteuerung der FI_LIN-Layering Slaves"
    LIN1_LAYERING_STATUS: 0xDA5F,   // INNENLICHT_FI_LIN_1_LAYERING          22   status of the LIN slaves in the layering system
    LIN2_LAYERING: 0xE3D1,          // INNENLICHT_FI_LIN_2_LAYERING          22;2E "Innenlicht Andere Bus Layering" (+ per-slave RGB read-back)
    AMBIENT_BRIGHTNESS_OFFSET: 0xD519, // INNENLICHT_HELLIGKEIT              2E   "Offset der Helligkeit des Ambientlicht" (0..255)
    INNENLICHT_PWM: 0x4800,         // _INNENBELEUCHTUNG_PWM                 22;2F element (TAB_INNENLICHT) + % (0x2F IO control)
    INNENLICHT_MODES: 0x4804,       // _INNENLICHT_FUNKTIONSMODI             2E   mode (TAB_INNENLICHT_FUNKTIONSMODI) + seconds
    INNENLICHT_ILE: 0xA621,         // INNENLICHT_ILE                        31   routine: ILE status (not used: routines are out of scope)
    FASTA_LIGHT: 0x2300,            // INNENLICHT_FASTA_DATEN                22   operating-time statistics of the ambient light
    SGBD_INDEX: 0xF150,             // ISO/BMW: 3-byte SGBD index (what BMW tools identify a unit by)
    SVK: 0xF101,                    // BMW: software version table (HWEL/BTLD/SWFL/CAFD records)
    VIN: 0xF190,                    // ISO: VIN (never logged unredacted by this project)
    ECU_SERIAL: 0xF18C,
    HW_NUMBER: 0xF191,
    SW_NUMBER: 0xF195,
});

/**
 * SGBD index -> what the public reference says about that body controller's interior-light functions.
 * rgbActuator: 'documented' = the SGBD lists DA5E/E3D1 with separate R/G/B bytes; 'legacy' = DA5E exists
 * but only switches all slaves to full brightness (no colour); 'none' = no layering function.
 * The indices come from idrive7-apps apps/live_data/builtin/sgbd_index.json (address 0x40 entries).
 */
const VARIANTS = Object.freeze({
    '0F2680': { sgbd: 'BDC_G05', description: 'Body Domain Controller BDC-03 (from SP18)', rgbActuator: 'documented' },
    '0F2050': { sgbd: 'BDC_G11', description: 'Body Domain Controller (G11 generation)', rgbActuator: 'legacy' },
    '0F19C0': { sgbd: 'BDC', description: 'Body Domain Controller (early)', rgbActuator: 'legacy' },
    '0F16B0': { sgbd: 'FEM_20', description: 'Front Electronic Module (F series)', rgbActuator: 'none' },
    '0F1001': { sgbd: 'CAS4_2', description: 'Car Access System', rgbActuator: 'none' },
});

/** ISO 14229 negative response codes. */
const NRC = Object.freeze({
    0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported', 0x13: 'incorrectMessageLengthOrInvalidFormat',
    0x14: 'responseTooLong', 0x21: 'busyRepeatRequest', 0x22: 'conditionsNotCorrect', 0x24: 'requestSequenceError',
    0x25: 'noResponseFromSubnetComponent', 0x26: 'failurePreventsExecutionOfRequestedAction', 0x31: 'requestOutOfRange',
    0x33: 'securityAccessDenied', 0x35: 'invalidKey', 0x36: 'exceededNumberOfAttempts', 0x37: 'requiredTimeDelayNotExpired',
    0x70: 'uploadDownloadNotAccepted', 0x71: 'transferDataSuspended', 0x72: 'generalProgrammingFailure', 0x73: 'wrongBlockSequenceCounter',
    0x78: 'requestCorrectlyReceivedResponsePending', 0x7E: 'subFunctionNotSupportedInActiveSession', 0x7F: 'serviceNotSupportedInActiveSession',
    0x81: 'rpmTooHigh', 0x82: 'rpmTooLow', 0x83: 'engineIsRunning', 0x84: 'engineIsNotRunning', 0x88: 'vehicleSpeedTooHigh', 0x92: 'voltageTooHigh', 0x93: 'voltageTooLow',
});

/** TAB_INNENLICHT_VERBAUORT_LIN (BDC_G05): LIN slave installation location -> English. */
const LOCATION = Object.freeze({
    0x01: 'Footwell driver front', 0x02: 'Footwell driver rear', 0x03: 'Footwell passenger front', 0x04: 'Footwell passenger rear',
    0x05: 'Contour line driver door front', 0x06: 'Indirect trim driver door front', 0x07: 'Door opener driver door front', 0x08: 'Map pocket driver door front',
    0x09: 'Contour line driver door rear', 0x0A: 'Indirect trim driver door rear', 0x0B: 'Map pocket driver door rear',
    0x0C: 'Contour line passenger door front', 0x0D: 'Indirect trim passenger door front', 0x0E: 'Door opener passenger door front', 0x0F: 'Map pocket passenger door front',
    0x10: 'Contour line passenger door rear', 0x11: 'Indirect trim passenger door rear', 0x12: 'Map pocket passenger door rear',
    0x13: 'Contour line dashboard driver', 0x14: 'Indirect trim dashboard driver', 0x15: 'Contour line dashboard centre', 0x16: 'Indirect trim dashboard centre',
    0x17: 'Contour line dashboard passenger', 0x18: 'Indirect trim dashboard passenger', 0x19: 'B-pillar driver', 0x1A: 'B-pillar passenger',
    0x1B: 'Back panel driver seat', 0x1C: 'Back panel passenger seat', 0x1D: 'Centre stack storage', 0x1E: 'Centre console storage',
    0x1F: 'Gear selector left', 0x20: 'Gear selector right', 0x21: 'Door opener driver door rear', 0x22: 'Door opener passenger door rear',
    0x23: 'Footwell driver 3rd row', 0x24: 'Footwell passenger 3rd row', 0x25: 'Map pocket driver door 3rd row', 0x26: 'Map pocket passenger door 3rd row',
    0x27: 'Contour line driver door 3rd row', 0x28: 'Contour line passenger door 3rd row', 0x29: 'Indirect trim driver door 3rd row', 0x2A: 'Indirect trim passenger door 3rd row',
    0x2B: 'Contour line centre console driver front', 0x2C: 'Contour line centre console driver rear', 0x2D: 'Contour line centre console passenger front', 0x2E: 'Contour line centre console passenger rear',
    0x2F: 'Indirect trim centre console driver front', 0x30: 'Indirect trim centre console driver rear', 0x31: 'Indirect trim centre console passenger front', 0x32: 'Indirect trim centre console passenger rear',
    0x33: 'Back panel driver seat 2nd row', 0x34: 'Back panel passenger seat 2nd row',
    0x35: 'Panorama roof glass front left front', 0x36: 'Panorama roof glass front left rear', 0x37: 'Panorama roof glass front right front', 0x38: 'Panorama roof glass front right rear',
    0x39: 'Panorama roof glass rear left front', 0x3A: 'Panorama roof glass rear left rear', 0x3B: 'Panorama roof glass rear right front', 0x3C: 'Panorama roof glass rear right rear',
    0x3D: 'Light sword left', 0x3E: 'Light sword right',
    0x3F: 'Backlit trim driver door front, front', 0x40: 'Backlit trim driver door front, rear', 0x41: 'Backlit trim driver door rear, front', 0x42: 'Backlit trim driver door rear, rear',
    0x43: 'Backlit trim passenger door front, front', 0x44: 'Backlit trim passenger door front, rear', 0x45: 'Backlit trim passenger door rear, front', 0x46: 'Backlit trim passenger door rear, rear',
    0x47: 'Backlit trim centre console driver front', 0x48: 'Backlit trim centre console driver rear', 0x49: 'Backlit trim centre console passenger front', 0x4A: 'Backlit trim centre console passenger rear',
    0x4B: 'Cupholder front', 0x4C: 'Cupholder rear', 0xFF: 'invalid / not fitted',
});

/** TAB_INNENLICHT_FUNKTIONSMODI (BDC_G05), the modes DID 0x4804 switches for a time. */
const MODES = Object.freeze({
    0x1C: 'Ambient Light - On', 0x1D: 'Light Sword - On', 0x1E: 'Trunk substitute light - On', 0x1F: 'Incoming Call - On',
    0x20: 'Welcome Approaching Light - On', 0x21: 'Welcome Unlock - On', 0x22: 'Goodbye', 0x27: 'Emergency Stop - HardOn',
});

/** TAB_INNENLICHT (BDC_G05): the elements DID 0x4800 reads / drives as PWM %. */
const PWM_ELEMENTS = Object.freeze([
    [38, 'INNENLICHT_WBL_LED'], [39, 'INNENLICHT_LCI_0'], [40, 'INNENLICHT_LCI_1'], [41, 'INNENLICHT_LCI_2'], [42, 'INNENLICHT_LCI_3'],
    [43, 'INNENLICHT_LCI_4'], [44, 'INNENLICHT_LCI_5'], [45, 'INNENLICHT_LCI_6'], [46, 'INNENLICHT_LCI_7'], [47, 'INNENLICHT_LCI_8'],
    [66, 'SPECIAL_FUNCTION_LED'], [67, 'MSA_LED'], [68, 'SST_LED'],
]);

const byte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
const hex = (n, w) => byte(n).toString(16).toUpperCase().padStart(w || 2, '0');
const hex16 = (n) => (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hexBytes = (b) => Array.prototype.map.call(b || [], (x) => hex(x)).join(' ');
const didBytes = (did) => [(did >> 8) & 0xFF, did & 0xFF];

/**
 * 2E DA5E / 2E E3D1: drive one RGB LIN slave for seconds (0..254).
 * p = { bus: 1|2, nad: 0..31, active: bool, brightness, r, g, b, seconds }
 * brightness is "elektrische Helligkeit aller Grundfarben": 0..100 on bus 1 (DA5E), 0..255 on bus 2 (E3D1).
 * Returns the request bytes after the service id (so diag.physical(0x40, 0x2E, bytes)).
 */
function encodeLayeringWrite(p) {
    const bus = p.bus === 2 ? 2 : 1;
    const did = bus === 2 ? DID.LIN2_LAYERING : DID.LIN1_LAYERING_CTRL;
    const nad = byte(p.nad);
    if (nad > 31) throw new RangeError('NAD must be 0..31 (SGBD ARG range), got ' + nad);
    const maxB = bus === 2 ? 255 : 100;
    const brightness = Math.min(maxB, byte(p.brightness == null ? maxB : p.brightness));
    const seconds = Math.min(254, byte(p.seconds == null ? 10 : p.seconds));
    return didBytes(did).concat([nad, p.active === false ? 0 : 1, brightness, byte(p.r), byte(p.g), byte(p.b), seconds]);
}

/** 2E D519: ambient brightness offset 0..255 (formula "laut LH (1109)" - unknown; read-only interest for now). */
function encodeBrightnessOffset(v) { return didBytes(DID.AMBIENT_BRIGHTNESS_OFFSET).concat([byte(v)]); }

/** 2E 4804: switch an interior-light function mode for seconds. */
function encodeModeWrite(mode, seconds) { return didBytes(DID.INNENLICHT_MODES).concat([byte(mode), Math.min(254, byte(seconds))]); }

/** 22 DID: read one identifier. */
function encodeRead(did) { return didBytes(did); }

/** A positive or negative reply to service sid for did. */
function decodeReply(sid, did, uds) {
    if (!uds || !uds.length) return { ok: false, reason: 'no reply', nrc: null };
    if (uds[0] === 0x7F) {
        const nrc = uds[2];
        return { ok: false, nrc, name: NRC[nrc] || ('NRC 0x' + hex(nrc)), reason: 'rejected: ' + (NRC[nrc] || hex(nrc)), forSid: uds[1] };
    }
    if (uds[0] !== sid + 0x40) return { ok: false, reason: 'unexpected service 0x' + hex(uds[0]), nrc: null };
    if (uds.length < 3 || ((uds[1] << 8) | uds[2]) !== did) return { ok: false, reason: 'unexpected identifier', nrc: null };
    return { ok: true, data: Array.prototype.slice.call(uds, 3) };
}

/** 62 F1 50: the SGBD index as 6 hex digits, plus what the reference says about it. */
function decodeSgbdIndex(data) {
    if (!data || data.length < 3) return null;
    const idx = hex(data[0]) + hex(data[1]) + hex(data[2]);
    return Object.assign({ index: idx }, VARIANTS[idx] || { sgbd: null, description: 'unknown body controller variant', rgbActuator: 'unknown' });
}

/**
 * 62 DA 5F / 62 E3 D1: RES_0xDA5F_D and RES_0xE3D1_D are identical: per NAD a 10-byte record
 * Verbauort, LED blue, LED green, LED red, brightness, white (footwell) LED, short-circuit, over-temperature,
 * open-load, internal fault. An empty slot reads FF FF FF FF 7F 03 07 07 07 07. A trailing byte follows the records.
 * CONFIRMED on the car (G20 330e, BDC 0F2680, 2026-11-04): 7 slaves on bus 1 read back 78 3C FE at 100 = the "Violet" preset.
 */
const SLAVE_RECORD = 10;
function decodeLinStatus(data, bus) {
    const slaves = [];
    const d = data || [];
    for (let i = 0; i + SLAVE_RECORD <= d.length; i += SLAVE_RECORD) {
        const loc = d[i];
        if (loc === 0xFF || loc === 0x00) continue;
        slaves.push({
            bus, nad: i / SLAVE_RECORD + 1, locationId: loc, location: LOCATION[loc] || ('location 0x' + hex(loc)),
            b: d[i + 1], g: d[i + 2], r: d[i + 3], brightness: d[i + 4], white: d[i + 5],
            faults: { shortCircuit: d[i + 6], overTemp: d[i + 7], openLoad: d[i + 8], internal: d[i + 9] },
        });
    }
    return slaves;
}
function decodeLin1Status(data) { return decodeLinStatus(data, 1); }
function decodeLin2Status(data) { return decodeLinStatus(data, 2); }

/** 62 48 00: PWM % per element in TAB_INNENLICHT order (RES_0x4800_D, 13 bytes). */
function decodePwmStatus(data) {
    return PWM_ELEMENTS.map((e, i) => ({ id: e[0], name: e[1], pwm: data && i < data.length ? data[i] : null }));
}

/**
 * 62 23 00: FASTA statistics (RES_0x2300_D): u32 reference time, u8 light sword fitted, u32 LS via HU, u32 LS via button,
 * u32 LS duration, u8 panorama roof light fitted, u32 PaDa via HU, u32 ambient/PaDa duration, u32 reduced while driving,
 * then one location byte per slave.
 */
function decodeFasta(data) {
    if (!data || data.length < 30) return null;
    const u32 = (i) => ((data[i] << 24) >>> 0) + (data[i + 1] << 16) + (data[i + 2] << 8) + data[i + 3];
    // On the car the record is ~290 bytes: the leading fields are followed by more counters than the rows read so far
    // name, and the 52 slave locations (26 per bus, NAD order) are its LAST 52 bytes. The leading values are TENTATIVE.
    const start = data.length > 30 + 52 ? data.length - 52 : 30;
    const locs = [];
    for (let i = start; i < data.length; i++) if (data[i] !== 0 && data[i] !== 0xFF) locs.push({ index: i - start + 1, bus: (i - start) < 26 ? 1 : 2, nad: ((i - start) % 26) + 1, locationId: data[i], location: LOCATION[data[i]] || ('location 0x' + hex(data[i])) });
    return { bdcActiveSeconds: u32(0), lightSwordFitted: data[4], lightSwordOnSeconds: u32(13), panoramaRoofLightFitted: data[17], ambientOnSeconds: u32(22), ambientReducedWhileDrivingSeconds: u32(26), leadingFieldsTentative: true, slaveLocations: locs };
}

/** 62 F1 01: SVK records (adapted from idrive7-8-ssh-root mgu7/diag.py, Unlicense). */
const SVK_TYPES = { 1: 'HWEL', 5: 'CAFD', 6: 'BTLD', 8: 'SWFL', 13: 'SWFK' };
function decodeSvk(data) {
    const out = [];
    for (let i = 0; i + 8 <= (data || []).length; i += 8) {
        if (!SVK_TYPES[data[i]]) continue;
        const version = ((data[i + 1] << 24) >>> 0) + (data[i + 2] << 16) + (data[i + 3] << 8) + data[i + 4];
        out.push({ type: SVK_TYPES[data[i]], id: version.toString(16).toUpperCase().padStart(8, '0'), version: [data[i + 5], data[i + 6], data[i + 7]].map((n) => String(n).padStart(3, '0')).join('.') });
    }
    return out;
}

/**
 * What this project lets leave the head unit towards the car. Everything else is refused before the
 * transport, the way kit/runtime/readonly-diag.js does it. Reads: 0x22 to any unit; the functional
 * 22 F1 50 discovery to 0xDF. Writes: only 2E to the BDC body (0x40), only the DIDs listed, and the
 * extended session 10 03 to the BDC when a write is refused with 7E/7F. No 14, 11, 27, 2F, 31, 3E, 85.
 * Returns null when allowed, else the reason.
 */
const WRITE_DIDS = Object.freeze([DID.LIN1_LAYERING_CTRL, DID.LIN2_LAYERING]);
function checkRequest(target, sid, data) {
    const d = Array.isArray(data) ? data : [];
    if (!d.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xFF)) return 'bad request bytes';
    if (sid === SID.READ) {
        if (d.length < 2 || d.length % 2) return '22 needs whole identifiers';
        if (target === ADDR.ALL && !(d.length === 2 && d[0] === 0xF1 && d[1] === 0x50)) return 'only 22 F1 50 may go to all units';
        return null;
    }
    if (sid === SID.WRITE) {
        if (target !== ADDR.BDC_BODY) return '2E only to the BDC body (0x40)';
        if (d.length < 3) return '2E needs an identifier and data';
        const did = (d[0] << 8) | d[1];
        if (WRITE_DIDS.indexOf(did) < 0) return 'DID 0x' + hex16(did) + ' is not a lighting actuator this project writes';
        if (d.length !== 9) return 'layering write is 9 bytes (DID + 7 arguments)';
        return null;
    }
    if (sid === SID.SESSION) {
        if (target !== ADDR.BDC_BODY) return '10 only to the BDC body';
        if (d.length !== 1 || d[0] !== 0x03) return 'only the extended session (10 03)';
        return null;
    }
    return 'service 0x' + hex(sid) + ' is not allowed';
}

module.exports = {
    ADDR, SID, DID, VARIANTS, NRC, LOCATION, MODES, PWM_ELEMENTS, SVK_TYPES, WRITE_DIDS,
    byte, hex, hex16, hexBytes, didBytes,
    encodeLayeringWrite, encodeBrightnessOffset, encodeModeWrite, encodeRead,
    decodeReply, decodeSgbdIndex, decodeLinStatus, decodeLin1Status, decodeLin2Status, decodePwmStatus, decodeFasta, decodeSvk, SLAVE_RECORD,
    checkRequest,
};

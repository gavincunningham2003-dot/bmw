"""uds.py - UDS replies decoded, and the BDC interior-light identifiers (mirror of app/ambient_rgb/lighting_protocol.js).

Identifiers and tables: the public EdiabasX SGBD reference for BDC_G05 (Body Domain Controller BDC-03,
from SP18), https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/BDC_G05/ . Unit names by diagnostic
address: a G20 330e's SVT as published in idrive7-apps kit/runtime/ecus.js.
"""
import struct

NRC = {
    0x10: "generalReject", 0x11: "serviceNotSupported", 0x12: "subFunctionNotSupported", 0x13: "incorrectMessageLengthOrInvalidFormat",
    0x14: "responseTooLong", 0x21: "busyRepeatRequest", 0x22: "conditionsNotCorrect", 0x24: "requestSequenceError",
    0x31: "requestOutOfRange", 0x33: "securityAccessDenied", 0x35: "invalidKey", 0x36: "exceededNumberOfAttempts",
    0x37: "requiredTimeDelayNotExpired", 0x78: "requestCorrectlyReceivedResponsePending",
    0x7E: "subFunctionNotSupportedInActiveSession", 0x7F: "serviceNotSupportedInActiveSession",
}

ECU_NAMES = {
    0x01: "ACSM airbag", 0x06: "ICAM cameras", 0x07: "SME HV battery", 0x08: "SRR corner radar", 0x0D: "HKFM tailgate",
    0x10: "BDC gateway", 0x12: "DME engine", 0x13: "DME 2", 0x14: "OBC charger", 0x18: "EGS gearbox", 0x1D: "TFM fuel tank",
    0x20: "SRR corner radar", 0x21: "FRR front radar", 0x23: "SAS assist sensors", 0x28: "SRR corner radar", 0x29: "DSC brakes",
    0x2A: "SRR corner radar", 0x2C: "USS park sensors", 0x30: "EPS steering", 0x37: "RAM audio", 0x38: "VTG xDrive",
    0x39: "DSC brake booster", 0x3A: "EME e-motor", 0x40: "BDC body", 0x43: "FLM headlight", 0x44: "FLM headlight",
    0x45: "DCS driver camera", 0x56: "FZD roof", 0x5D: "KAFAS camera", 0x5E: "GWS gear selector", 0x60: "KOMBI cluster",
    0x61: "ATM telematics", 0x63: "Head unit (MGU)", 0x64: "PDC parking", 0x67: "ZBE controller", 0x6D: "SM seat module",
    0x76: "VDP dampers", 0x78: "IHKA climate",
}

DID = {
    "SGBD_INDEX": 0xF150, "SVK": 0xF101, "VIN": 0xF190, "ECU_SERIAL": 0xF18C, "HW_NUMBER": 0xF191, "SW_NUMBER": 0xF195,
    "MGU_IP": 0x172A,
    "LIN1_LAYERING_CTRL": 0xDA5E, "LIN1_LAYERING_STATUS": 0xDA5F, "LIN2_LAYERING": 0xE3D1, "AMBIENT_BRIGHTNESS_OFFSET": 0xD519,
    "INNENLICHT_PWM": 0x4800, "INNENLICHT_MODES": 0x4804, "FASTA_LIGHT": 0x2300, "AMBIENT_STATUS_G11": 0xD5D3,
}
DID_NAME = {v: k for k, v in DID.items()}

VARIANTS = {
    "0F2680": {"sgbd": "BDC_G05", "description": "Body Domain Controller BDC-03 (from SP18)", "rgbActuator": "documented"},
    "0F2050": {"sgbd": "BDC_G11", "description": "Body Domain Controller (G11 generation)", "rgbActuator": "legacy"},
    "0F19C0": {"sgbd": "BDC", "description": "Body Domain Controller (early)", "rgbActuator": "legacy"},
    "0F16B0": {"sgbd": "FEM_20", "description": "Front Electronic Module (F series)", "rgbActuator": "none"},
    "0F1001": {"sgbd": "CAS4_2", "description": "Car Access System", "rgbActuator": "none"},
}

LOCATION = {
    0x01: "Footwell driver front", 0x02: "Footwell driver rear", 0x03: "Footwell passenger front", 0x04: "Footwell passenger rear",
    0x05: "Contour line driver door front", 0x06: "Indirect trim driver door front", 0x07: "Door opener driver door front", 0x08: "Map pocket driver door front",
    0x09: "Contour line driver door rear", 0x0A: "Indirect trim driver door rear", 0x0B: "Map pocket driver door rear",
    0x0C: "Contour line passenger door front", 0x0D: "Indirect trim passenger door front", 0x0E: "Door opener passenger door front", 0x0F: "Map pocket passenger door front",
    0x10: "Contour line passenger door rear", 0x11: "Indirect trim passenger door rear", 0x12: "Map pocket passenger door rear",
    0x13: "Contour line dashboard driver", 0x14: "Indirect trim dashboard driver", 0x15: "Contour line dashboard centre", 0x16: "Indirect trim dashboard centre",
    0x17: "Contour line dashboard passenger", 0x18: "Indirect trim dashboard passenger", 0x19: "B-pillar driver", 0x1A: "B-pillar passenger",
    0x1B: "Back panel driver seat", 0x1C: "Back panel passenger seat", 0x1D: "Centre stack storage", 0x1E: "Centre console storage",
    0x1F: "Gear selector left", 0x20: "Gear selector right", 0x21: "Door opener driver door rear", 0x22: "Door opener passenger door rear",
    0x23: "Footwell driver 3rd row", 0x24: "Footwell passenger 3rd row", 0x25: "Map pocket driver door 3rd row", 0x26: "Map pocket passenger door 3rd row",
    0x27: "Contour line driver door 3rd row", 0x28: "Contour line passenger door 3rd row", 0x29: "Indirect trim driver door 3rd row", 0x2A: "Indirect trim passenger door 3rd row",
    0x2B: "Contour line centre console driver front", 0x2C: "Contour line centre console driver rear", 0x2D: "Contour line centre console passenger front",
    0x2E: "Contour line centre console passenger rear", 0x2F: "Indirect trim centre console driver front", 0x30: "Indirect trim centre console driver rear",
    0x31: "Indirect trim centre console passenger front", 0x32: "Indirect trim centre console passenger rear", 0x33: "Back panel driver seat 2nd row",
    0x34: "Back panel passenger seat 2nd row", 0x35: "Panorama roof glass front left front", 0x36: "Panorama roof glass front left rear",
    0x37: "Panorama roof glass front right front", 0x38: "Panorama roof glass front right rear", 0x39: "Panorama roof glass rear left front",
    0x3A: "Panorama roof glass rear left rear", 0x3B: "Panorama roof glass rear right front", 0x3C: "Panorama roof glass rear right rear",
    0x3D: "Light sword left", 0x3E: "Light sword right", 0x3F: "Backlit trim driver door front, front", 0x40: "Backlit trim driver door front, rear",
    0x41: "Backlit trim driver door rear, front", 0x42: "Backlit trim driver door rear, rear", 0x43: "Backlit trim passenger door front, front",
    0x44: "Backlit trim passenger door front, rear", 0x45: "Backlit trim passenger door rear, front", 0x46: "Backlit trim passenger door rear, rear",
    0x47: "Backlit trim centre console driver front", 0x48: "Backlit trim centre console driver rear", 0x49: "Backlit trim centre console passenger front",
    0x4A: "Backlit trim centre console passenger rear", 0x4B: "Cupholder front", 0x4C: "Cupholder rear", 0xFF: "invalid / not fitted",
}
PWM_ELEMENTS = ["INNENLICHT_WBL_LED", "INNENLICHT_LCI_0", "INNENLICHT_LCI_1", "INNENLICHT_LCI_2", "INNENLICHT_LCI_3", "INNENLICHT_LCI_4",
                "INNENLICHT_LCI_5", "INNENLICHT_LCI_6", "INNENLICHT_LCI_7", "INNENLICHT_LCI_8", "SPECIAL_FUNCTION_LED", "MSA_LED", "SST_LED"]
SVK_TYPES = {1: "HWEL", 5: "CAFD", 6: "BTLD", 8: "SWFL", 13: "SWFK"}


def hexs(b):
    return bytes(b).hex(" ").upper()


def read_request(*dids):
    """22 + the identifiers (1..8)."""
    out = bytearray([0x22])
    for d in dids:
        out += struct.pack(">H", d)
    return bytes(out)


class Reply:
    """A decoded UDS reply: positive -> .data (bytes after the service id), negative -> .nrc / .nrc_name."""

    def __init__(self, payload):
        self.raw = bytes(payload or b"")
        self.positive = bool(self.raw) and self.raw[0] != 0x7F
        self.sid = self.raw[0] if self.raw else None
        self.nrc = self.raw[2] if (not self.positive and len(self.raw) >= 3) else None
        self.nrc_name = NRC.get(self.nrc, "NRC 0x%02X" % self.nrc) if self.nrc is not None else None
        self.data = self.raw[1:] if self.positive else b""

    def to_dict(self):
        return {"raw": hexs(self.raw), "positive": self.positive, "nrc": self.nrc, "nrcName": self.nrc_name}


def split_dids(data, requested):
    """A 62 reply to one or several DIDs: {did: bytes}. Lengths are not self-describing, so the split is by
    the requested order: each DID's data runs to the next requested DID marker. One DID: everything."""
    out = {}
    if not data:
        return out
    body = bytes(data)
    if len(requested) == 1:
        if len(body) >= 2 and struct.unpack(">H", body[:2])[0] == requested[0]:
            out[requested[0]] = body[2:]
        return out
    pos = 0
    for i, did in enumerate(requested):
        marker = struct.pack(">H", did)
        at = body.find(marker, pos)
        if at < 0:
            continue
        nxt = len(body)
        for d2 in requested[i + 1:]:
            j = body.find(struct.pack(">H", d2), at + 2)
            if j >= 0:
                nxt = min(nxt, j)
        out[did] = body[at + 2:nxt]
        pos = nxt
    return out


def decode_sgbd_index(data):
    if len(data) < 3:
        return None
    idx = "%02X%02X%02X" % (data[0], data[1], data[2])
    return dict({"index": idx}, **VARIANTS.get(idx, {"sgbd": None, "description": "unknown", "rgbActuator": "unknown"}))


def decode_svk(data):
    out = []
    for i in range(0, len(data) - 7, 8):
        if data[i] not in SVK_TYPES:
            continue
        version = struct.unpack(">I", data[i + 1:i + 5])[0]
        out.append({"type": SVK_TYPES[data[i]], "id": "%08X" % version, "version": "%03d.%03d.%03d" % (data[i + 5], data[i + 6], data[i + 7])})
    return out


SLAVE_RECORD = 10   # RES_0xDA5F_D / RES_0xE3D1_D per NAD: Verbauort, blue, green, red, brightness, white, 4 fault flags (CONFIRMED on the car 2026-11-04)


def decode_lin_status(data, bus):
    out = []
    for i in range(0, len(data) - (SLAVE_RECORD - 1), SLAVE_RECORD):
        loc = data[i]
        if loc in (0x00, 0xFF):
            continue
        out.append({"bus": bus, "nad": i // SLAVE_RECORD + 1, "locationId": loc, "location": LOCATION.get(loc, "location 0x%02X" % loc),
                    "b": data[i + 1], "g": data[i + 2], "r": data[i + 3], "brightness": data[i + 4], "white": data[i + 5],
                    "faults": {"shortCircuit": data[i + 6], "overTemp": data[i + 7], "openLoad": data[i + 8], "internal": data[i + 9]}})
    return out


def decode_lin1_status(data):
    return decode_lin_status(data, 1)


def decode_lin2_status(data):
    return decode_lin_status(data, 2)


def decode_pwm(data):
    return [{"name": n, "pwm": data[i] if i < len(data) else None} for i, n in enumerate(PWM_ELEMENTS)]


def decode_fasta(data):
    """RES_0x2300_D: u32 reference time, u8 light-sword fitted, u32 LS switched via HU, u32 via button, u32 LS duration,
    u8 panorama-roof light fitted, u32 PaDa via HU, u32 ambient/PaDa duration, u32 reduced-while-driving, then one
    location byte per slave (STAT_VERBAUORT_ID_SLAVE1..52)."""
    if len(data) < 30:
        return None
    ref, ls_fitted, ls_hu, ls_btn, ls_dur, pada_fitted, pada_hu, amb_dur, reduced = struct.unpack(">IBIIIBIII", data[:30])
    # on the car the record is ~290 bytes; the 52 slave locations (26 per bus, NAD order) are its LAST 52 bytes and the
    # leading counters are TENTATIVE (more fields than the rows read so far name)
    start = len(data) - 52 if len(data) > 30 + 52 else 30
    locs = [{"index": i + 1, "bus": 1 if i < 26 else 2, "nad": i % 26 + 1, "locationId": loc, "location": LOCATION.get(loc, "location 0x%02X" % loc)}
            for i, loc in enumerate(data[start:]) if loc not in (0x00, 0xFF)]
    return {"bdcActiveSeconds": ref, "lightSwordFitted": ls_fitted, "lightSwordSwitchedViaHu": ls_hu, "lightSwordSwitchedViaButton": ls_btn,
            "lightSwordOnSeconds": ls_dur, "panoramaRoofLightFitted": pada_fitted, "panoramaRoofSwitchedViaHu": pada_hu,
            "ambientOnSeconds": amb_dur, "ambientReducedWhileDrivingSeconds": reduced, "leadingFieldsTentative": True, "slaveLocations": locs}


def decode_mgu_ip(data):
    """62 17 2A 00 + four IPv4 addresses (idrive7-8-ssh-root mgu7/diag.py)."""
    if len(data) < 13:
        return None
    body = data[1:]
    return [".".join(str(x) for x in body[i:i + 4]) for i in range(0, 12, 4)][:3]


def decode_ascii(data):
    return bytes(b for b in data if 0x20 <= b < 0x7F).decode("ascii")

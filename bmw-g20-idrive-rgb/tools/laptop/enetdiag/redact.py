"""redact.py - what never leaves the laptop in a shared report: VINs, serial numbers, keys, tokens.

A VIN keeps its first three characters (the world manufacturer id, e.g. WBA) and loses the rest.
Serial numbers (DID F18C) are replaced by a short hash so two reports can be compared without
revealing them. PEM blocks and anything that looks like a credential are blanked.
"""
import hashlib
import re

VIN_RE = re.compile(r"\b(WB[A-HJ-NPR-Z0-9]|WMW|WBS|WBY|5UX|5YM|4US|3MW)([A-HJ-NPR-Z0-9]{14})\b")
PEM_RE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)
TOKEN_RE = re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b")


def redact_vin(vin):
    if not vin or len(vin) < 6:
        return "***"
    return vin[:3] + "*" * (len(vin) - 3)


def short_hash(s):
    return "h:" + hashlib.sha256(str(s).encode("utf-8")).hexdigest()[:10]


def redact_text(text):
    if not isinstance(text, str):
        return text
    text = PEM_RE.sub("[private key removed]", text)
    text = TOKEN_RE.sub("[token removed]", text)
    return VIN_RE.sub(lambda m: m.group(1) + "*" * 14, text)


def redact(obj, key=None):
    """Walk a report: VINs and serials by key name, VIN patterns in any string."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if kl in ("vin",) and isinstance(v, str):
                out[k] = redact_vin(v)
            elif kl in ("serial", "ecuserial", "serialnumber") and isinstance(v, str):
                out[k] = short_hash(v)
            else:
                out[k] = redact(v, k)
        return out
    if isinstance(obj, list):
        return [redact(x, key) for x in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj

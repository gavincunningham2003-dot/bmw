"""policy.py - the read-only rule, checked before every frame leaves the laptop.

Allowed: UDS 0x22 ReadDataByIdentifier with 1..8 whole identifiers to one unit, and the functional
discovery read 22 F1 50 to 0xDF. Everything else (sessions, resets, clears, security access, writes,
I/O control, routines, tester present, DTC control, downloads) is refused with PolicyError.
"""
from .hsfz import FUNCTIONAL

MAX_DIDS = 8
DISCOVER = b"\x22\xF1\x50"


class PolicyError(Exception):
    pass


def check(dst, payload):
    p = bytes(payload)
    if not p:
        raise PolicyError("empty request")
    sid = p[0]
    if sid != 0x22:
        raise PolicyError("service 0x%02X is not allowed: this tool only reads (0x22)" % sid)
    body = p[1:]
    if len(body) < 2 or len(body) % 2 or len(body) > 2 * MAX_DIDS:
        raise PolicyError("22 takes 1 to %d whole identifiers" % MAX_DIDS)
    if dst == FUNCTIONAL and p != DISCOVER:
        raise PolicyError("only 22 F1 50 may go to all units (0xDF)")
    if not 0 <= dst <= 0xFF:
        raise PolicyError("bad address")
    return True

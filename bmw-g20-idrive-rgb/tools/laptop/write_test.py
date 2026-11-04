#!/usr/bin/env python3
"""write_test.py - the ONE write this project sends before anything else: drive a single ambient LIN module with a
colour for a few seconds through the BDC's documented actuator (2E DA5E / 2E E3D1), and read it back.

This script is deliberately separate from the read-only enetdiag tool, which stays read-only. It runs ONE step per
invocation so that every frame is approved beforehand:

    python write_test.py --gateway 169.254.49.66 status              22 DA 5F (or E3 D1): the module's current colour
    python write_test.py --gateway 169.254.49.66 dtc                 19 02 0C: the BDC's stored faults (read-only)
    python write_test.py --gateway 169.254.49.66 write               2E DA 5E <nad> 01 64 <r> <g> <b> <zeit>
    python write_test.py --gateway 169.254.49.66 write --session     10 03 first, then the same write (only if asked)
    python write_test.py --gateway 169.254.49.66 release             2E DA 5E <nad> 00 00 00 00 00 00 (ZUSTAND 0, ZEIT 0)
    python write_test.py --gateway 169.254.49.66 cycle               the same write with each of --colours in turn, --hold s apart
                                                                     (ZEIT = hold + 2 so the module never goes dark between colours,
                                                                     and returns to OEM by itself after the last one)
    --bus 1 --nad 1 --rgb FF0000 --zeit 5                           defaults: bus 1, NAD 1 (map pocket passenger front), red, 5 s
    --simulate                                                       the loopback simulated car instead of a gateway

Hard limits built in: target 0x40 only; bus 1 NAD 1..7, bus 2 NAD 1..12 (the modules the car reported); ZEIT 1..10 s;
the only services are 22 (status), 19 02 (fault read), 2E to DA5E/E3D1 with exactly 7 argument bytes, and 10 03
when --session is given. Every frame is printed before it is sent and logged to out/write_test-<time>.log.
"""
import argparse
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enetdiag import uds                                              # noqa: E402
from enetdiag.hsfz import EnetClient, BDC_BODY, HsfzError           # noqa: E402

LOG = logging.getLogger("write_test")
MODULES = {1: list(range(1, 8)), 2: list(range(1, 13))}             # NADs the car reported on 2026-11-04
DID_STATUS = {1: 0xDA5F, 2: 0xE3D1}
DID_CTRL = {1: 0xDA5E, 2: 0xE3D1}
MAX_ZEIT = 10


def frame_text(payload):
    return uds.hexs(payload)


def send(client, payload, overall_ms=12000, quiet_ms=400):
    """One request to the BDC body, printed and logged before and after. Returns the reply payload or None."""
    LOG.info("TX 40 <- %s", frame_text(payload))
    print("  -> 0x40: %s" % frame_text(payload))
    t0 = time.monotonic()
    sid = payload[0]
    ours = lambda f: f.src == BDC_BODY and (f.payload[:1] == bytes([sid + 0x40]) or (len(f.payload) >= 3 and f.payload[0] == 0x7F and f.payload[1] == sid))
    frames = client.request(BDC_BODY, payload, overall_ms=overall_ms, quiet_ms=quiet_ms, until=ours)
    reply = None
    for f in frames:
        if f.src != BDC_BODY:
            continue
        p = f.payload
        if p[:1] == bytes([payload[0] + 0x40]) or (len(p) >= 3 and p[0] == 0x7F and p[1] == payload[0]):
            reply = p
    ms = int((time.monotonic() - t0) * 1000)
    LOG.info("RX 40 -> %s (%d ms)", frame_text(reply) if reply else "no reply", ms)
    print("  <- 0x40: %s  (%d ms)" % (frame_text(reply) if reply else "no reply", ms))
    return reply


def explain(reply, sid):
    if reply is None:
        return "no reply within the window"
    if reply[0] == 0x7F:
        return "REJECTED: NRC 0x%02X %s" % (reply[2], uds.NRC.get(reply[2], ""))
    if reply[0] == sid + 0x40:
        return "positive response"
    return "unexpected"


def show_module(reply, bus, nad):
    if not reply or reply[0] != 0x62:
        return
    recs = uds.decode_lin_status(reply[3:], bus)
    for r in recs:
        if r["nad"] == nad:
            print("  module bus %d NAD %d = %s: rgb %d %d %d, brightness %d, white %d, faults %s" % (
                bus, nad, r["location"], r["r"], r["g"], r["b"], r["brightness"], r["white"], r["faults"]))
            return
    print("  module bus %d NAD %d not present in the status reply" % (bus, nad))


def main(argv=None):
    ap = argparse.ArgumentParser(description="one gated write to one ambient module (see the file header)")
    ap.add_argument("step", choices=["status", "dtc", "write", "release", "cycle"])
    ap.add_argument("--colours", default="FE0000,FE6000,FEFE00,00FE00,00FEFE,0000FE,FE00FE", help="hex colours for cycle, comma separated (max 8)")
    ap.add_argument("--hold", type=int, default=3, help="seconds per colour in cycle (1..8)")
    ap.add_argument("--fade", type=float, default=0, help="cycle: seconds to glide between colours (0 = jump; 0.5..5)")
    ap.add_argument("--all", action="store_true", help="cycle: every module of both buses instead of one NAD (19 writes per step)")
    ap.add_argument("--gateway")
    ap.add_argument("--port", type=int, default=6801)
    ap.add_argument("--bus", type=int, default=1, choices=[1, 2])
    ap.add_argument("--nad", type=int, default=1)
    ap.add_argument("--rgb", default="FF0000")
    ap.add_argument("--zeit", type=int, default=5)
    ap.add_argument("--brightness", type=int, default=100)
    ap.add_argument("--session", action="store_true", help="send 10 03 before the write (only when a 7E/7F refusal was seen)")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--out", default="out")
    a = ap.parse_args(argv)

    if a.nad not in MODULES[a.bus]:
        sys.exit("bus %d has NADs %s on this car" % (a.bus, MODULES[a.bus]))
    if not 1 <= a.zeit <= MAX_ZEIT:
        sys.exit("ZEIT must be 1..%d s" % MAX_ZEIT)
    try:
        colours = [bytes(min(b, 0xFE) for b in bytes.fromhex(c)) for c in a.colours.split(",") if c]
    except ValueError:
        sys.exit("cycle: colours must be 6 hex digits each")
    if a.step == "cycle" and (not 1 <= len(colours) <= 8 or any(len(c) != 3 for c in colours) or not 1 <= a.hold <= 8):
        sys.exit("cycle: 1..8 colours of 6 hex digits, --hold 1..8 s")
    if not 0 <= a.brightness <= (100 if a.bus == 1 else 255):
        sys.exit("brightness out of the documented range for this bus")
    rgb = bytes.fromhex(a.rgb)
    if len(rgb) != 3:
        sys.exit("--rgb needs 6 hex digits")
    if 0xFF in rgb:
        rgb = bytes(min(b, 0xFE) for b in rgb)
        print("note: a colour byte of FF means 'no change' to the BDC (verified 2026-11-04); using FE instead")

    os.makedirs(a.out, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        handlers=[logging.FileHandler(os.path.join(a.out, "write_test-%s.log" % stamp), encoding="utf-8")])
    LOG.info("step=%s bus=%d nad=%d rgb=%s zeit=%d brightness=%d session=%s simulate=%s", a.step, a.bus, a.nad, a.rgb, a.zeit, a.brightness, a.session, a.simulate)

    car = None
    if a.simulate:
        from enetdiag.simulator import FakeCar, FakeBdc, G20_BUS1, G20_BUS2
        car = FakeCar(ecus={0x40: FakeBdc(slaves=G20_BUS1, slaves2=G20_BUS2)})
        car.start()
        gateway, port = "127.0.0.1", car.port
        print("SIMULATED car on 127.0.0.1:%d (its BDC refuses writes with NRC 11: it only models reads)" % port)
    else:
        if not a.gateway:
            sys.exit("--gateway is required (or --simulate)")
        gateway, port = a.gateway, a.port

    c = EnetClient(gateway, port)
    c_client = c
    try:
        c.connect()
        print("connected to %s:%d, target 0x40 (BDC body)" % (gateway, port))
        if a.step == "status":
            did = DID_STATUS[a.bus]
            reply = send(c, uds.read_request(did))
            print("  " + explain(reply, 0x22))
            show_module(reply, a.bus, a.nad)
        elif a.step == "dtc":
            reply = send(c, bytes([0x19, 0x02, 0x0C]), overall_ms=6000)
            print("  " + explain(reply, 0x19))
            if reply and reply[0] == 0x59:
                body = reply[3:]
                codes = ["%02X%02X%02X status %02X" % (body[i], body[i + 1], body[i + 2], body[i + 3]) for i in range(0, len(body) - 3, 4)]
                print("  stored faults (confirmed or pending): %s" % (", ".join(codes) if codes else "none"))
        elif a.step == "cycle":
            zeit = min(MAX_ZEIT, a.hold + 2)
            targets = [(b, n) for b in (1, 2) for n in MODULES[b]] if a.all else [(a.bus, a.nad)]
            if not 0 <= a.fade <= 5:
                sys.exit("--fade 0..5 s")
            print("cycle: %d colours, %d module(s), %d s each, fade %.1f s, ZEIT %d s" % (len(colours), len(targets), a.hold, a.fade, zeit))

            def step(col, quiet=False):
                for bus, nad in targets:
                    did = DID_CTRL[bus]
                    payload = bytes([0x2E, did >> 8, did & 0xFF, nad, 0x01, a.brightness, col[0], col[1], col[2], zeit])
                    assert len(payload) == 10 and payload[0] == 0x2E and did in (0xDA5E, 0xE3D1)
                    LOG.info("TX 40 <- %s", frame_text(payload))
                    frames = c_client.request(BDC_BODY, payload, overall_ms=3000, quiet_ms=300,
                                              until=lambda f: f.src == BDC_BODY and (f.payload[:1] == b"\x6E" or (len(f.payload) >= 3 and f.payload[0] == 0x7F and f.payload[1] == 0x2E)))
                    reply = next((f.payload for f in frames if f.src == BDC_BODY), None)
                    LOG.info("RX 40 -> %s", frame_text(reply) if reply else "no reply")
                    if not reply or reply[0] != 0x6E:
                        print("  bus %d NAD %d: %s" % (bus, nad, explain(reply, 0x2E)))
                        return False
                return True

            prev = None
            t_round = None
            for i, col in enumerate(colours):
                print("colour %d/%d #%s" % (i + 1, len(colours), col.hex().upper()))
                if a.fade > 0 and prev is not None:
                    # glide: as many in-between steps as the module count allows at ~14 ms per write
                    t0 = time.monotonic()
                    while True:
                        t = min(1.0, (time.monotonic() - t0) / a.fade)
                        mid = bytes(int(round(prev[k] + (col[k] - prev[k]) * t)) for k in range(3))
                        ts = time.monotonic()
                        if not step(mid):
                            print("  stopping the cycle")
                            return 2
                        t_round = time.monotonic() - ts
                        if t >= 1.0:
                            break
                else:
                    ts = time.monotonic()
                    if not step(col):
                        print("  stopping the cycle")
                        return 2
                    t_round = time.monotonic() - ts
                prev = col
                if i < len(colours) - 1:
                    time.sleep(a.hold)
            print("done (last round %d ms for %d module(s)); the modules return to OEM by themselves within %d s" % (int((t_round or 0) * 1000), len(targets), zeit))
        elif a.step in ("write", "release"):
            did = DID_CTRL[a.bus]
            if a.step == "write":
                args = bytes([a.nad, 0x01, a.brightness, rgb[0], rgb[1], rgb[2], a.zeit])
            else:
                args = bytes([a.nad, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
            payload = bytes([0x2E, did >> 8, did & 0xFF]) + args
            assert len(payload) == 10 and payload[0] == 0x2E and did in (0xDA5E, 0xE3D1)
            if a.session:
                r = send(c, bytes([0x10, 0x03]), overall_ms=4000)
                print("  session: " + explain(r, 0x10))
                if not r or r[0] != 0x50:
                    print("  extended session refused: stopping before the write")
                    return 2
            reply = send(c, payload)
            print("  " + explain(reply, 0x2E))
            if reply and reply[0] == 0x6E:
                print("  ACCEPTED. Watch the module now%s." % (" for about %d s" % a.zeit if a.step == "write" else ""))
                time.sleep(1.0)
                st = send(c, uds.read_request(DID_STATUS[a.bus]))
                print("  read-back: " + explain(st, 0x22))
                show_module(st, a.bus, a.nad)
            elif reply and reply[0] == 0x7F and reply[2] in (0x7E, 0x7F) and not a.session:
                print("  the BDC wants another session: rerun this step with --session if you want to try 10 03")
            elif reply and reply[0] == 0x7F and reply[2] == 0x33:
                print("  SECURITY ACCESS required: this project stops here by design")
    except HsfzError as e:
        print("transport error: %s" % e)
        return 1
    finally:
        c.close()
        if car:
            car.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())

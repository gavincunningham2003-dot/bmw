"""cli.py - the command line.

    python -m enetdiag discover                      find the gateway (UDP 6811)
    python -m enetdiag scan [--gateway IP] [--out DIR]
                                                     the read-only discovery; writes DIR/enetdiag-<time>.json (redacted)
                                                     and DIR/enetdiag-<time>.log
    python -m enetdiag read --target 40 --did DA5F   one identifier from one unit (0x22 only)
    python -m enetdiag selftest                      the same scan against the built-in simulated car on 127.0.0.1

Run it from tools/laptop (so that the enetdiag package is found), as Administrator on Windows so the
169.254.x.x link-local address of the ENET adapter is used.
"""
import argparse
import json
import logging
import os
import sys
import time

from . import __version__, uds
from .hsfz import EnetClient, discover
from .policy import PolicyError
from .redact import redact
from .scan import Scanner, run_scan


def setup_logging(out_dir, stamp):
    os.makedirs(out_dir, exist_ok=True)
    logger = logging.getLogger("enetdiag")
    logger.setLevel(logging.DEBUG)
    logger.handlers = []
    fh = logging.FileHandler(os.path.join(out_dir, "enetdiag-%s.log" % stamp), encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(fh)
    logger.addHandler(ch)
    return logger, fh.baseFilename


def write_report(report, out_dir, stamp):
    red = redact(report)
    red["meta"]["redacted"] = True
    path = os.path.join(out_dir, "enetdiag-%s.json" % stamp)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(red, f, indent=1)
    return path


def summary(report):
    lines = []
    if report.get("error"):
        lines.append("ERROR: " + report["error"])
    if report.get("gateway"):
        lines.append("gateway %s" % report["gateway"]["ip"])
    for u in report.get("units", []):
        lines.append("  %s %-20s %s" % (u["address"], u["name"], u.get("sgbdIndex") or "-"))
    a = report.get("analysis")
    if a:
        lines.append("analysis:")
        for v in a["verdicts"]:
            lines.append("  - " + v)
        lines.append("  ready for a gated write test: %s" % ("yes" if a["readyForGatedWriteTest"] else "no"))
        lines.append("  next: " + a["nextStep"])
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="enetdiag", description="read-only BMW ENET discovery (UDS 0x22 only)")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover", help="find the gateway on the ENET link")
    d.add_argument("--timeout", type=int, default=600, help="ms to wait for identification replies")
    s = sub.add_parser("scan", help="the read-only discovery scan")
    s.add_argument("--gateway", help="gateway IP (default: discover)")
    s.add_argument("--port", type=int, default=6801)
    s.add_argument("--out", default="out", help="output folder for the JSON report and the log")
    s.add_argument("--pace", type=int, default=50, help="ms between requests")
    r = sub.add_parser("read", help="read one identifier from one unit")
    r.add_argument("--gateway", required=True)
    r.add_argument("--port", type=int, default=6801)
    r.add_argument("--target", required=True, help="unit address in hex, e.g. 40")
    r.add_argument("--did", required=True, help="identifier in hex, e.g. DA5F")
    t = sub.add_parser("selftest", help="scan the built-in simulated car on 127.0.0.1")
    t.add_argument("--out", default="out")
    args = ap.parse_args(argv)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    if args.cmd == "discover":
        found = discover(timeout_ms=args.timeout, log=print)
        if not found:
            print("no gateway answered (cable in? ignition on? adapter on 169.254.x.x? run as Administrator)")
            return 1
        for ip, vin in found:
            print("gateway %s  VIN %s" % (ip, vin[:3] + "*" * 14))
        return 0

    if args.cmd == "read":
        dst = int(args.target, 16)
        did = int(args.did, 16)
        c = EnetClient(args.gateway, args.port)
        c.connect()
        try:
            sc = Scanner(c)
            try:
                rep = sc.read(dst, [did])
            except PolicyError as e:
                print("refused: %s" % e)
                return 2
        finally:
            c.close()
        if rep is None:
            print("no reply")
            return 1
        print(rep.to_dict()["raw"])
        if rep.positive:
            data = uds.split_dids(rep.data, [did]).get(did, b"")
            if did == 0xDA5F:
                for sl in uds.decode_lin1_status(data):
                    print("  NAD %2d  %s" % (sl["nad"], sl["location"]))
            elif did == 0xE3D1:
                for sl in uds.decode_lin2_status(data):
                    print("  NAD %2d  %s  rgb %d %d %d  brightness %d" % (sl["nad"], sl["location"], sl["r"], sl["g"], sl["b"], sl["brightness"]))
            elif did == 0xF150:
                print("  ", uds.decode_sgbd_index(data))
        return 0

    if args.cmd in ("scan", "selftest"):
        logger, logfile = setup_logging(args.out, stamp)
        logger.info("enetdiag %s: read-only scan (UDS 0x22 only)", __version__)
        if args.cmd == "selftest":
            from .simulator import FakeCar
            with FakeCar() as car:
                logger.info("simulated car on 127.0.0.1:%d", car.port)
                report = run_scan(gateway="127.0.0.1", port=car.port)
                report["meta"]["simulated"] = True
                sids = sorted(set(f.payload[0] for f in car.requests if f.payload))
                logger.info("services the simulated car saw: %s", " ".join("%02X" % x for x in sids))
                assert sids == [0x22], "the policy let something but 0x22 through: %s" % sids
        else:
            report = run_scan(gateway=args.gateway, port=args.port, pace_ms=args.pace)
        path = write_report(report, args.out, stamp)
        print(summary(report))
        print("report: %s\nlog:    %s" % (path, logfile))
        for h in list(logger.handlers):                 # release the log file (Windows keeps it locked otherwise)
            h.close()
            logger.removeHandler(h)
        return 0 if not report.get("error") else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())

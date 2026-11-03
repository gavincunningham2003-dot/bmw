"""scan.py - the read-only discovery: gateway -> units -> MGU / BDC identification -> BDC light identifiers -> report.

Every request goes through policy.check() first. The report is a dict (see report()); redaction is applied
by the CLI before anything is written. Logging: a logger named 'enetdiag' with one line per exchange.
"""
import logging
import time
from datetime import datetime, timezone

from . import __version__, uds
from .hsfz import EnetClient, FUNCTIONAL, GATEWAY, MGU, BDC_BODY, HsfzError, discover
from .policy import check

log = logging.getLogger("enetdiag")

IDENT_DIDS = [uds.DID["SGBD_INDEX"], uds.DID["SVK"], uds.DID["VIN"], uds.DID["ECU_SERIAL"], uds.DID["HW_NUMBER"], uds.DID["SW_NUMBER"]]
BDC_LIGHT_DIDS = [uds.DID["LIN1_LAYERING_STATUS"], uds.DID["LIN2_LAYERING"], uds.DID["INNENLICHT_PWM"], uds.DID["FASTA_LIGHT"], uds.DID["AMBIENT_STATUS_G11"]]


class Scanner:
    def __init__(self, client, pace_ms=50):
        self.client = client
        self.pace_ms = pace_ms
        self.exchanges = []          # every request / reply, for the report

    def read(self, dst, dids, overall_ms=3000, quiet_ms=250):
        """22 <dids> to one unit: uds.Reply (positive data split by DID) or None without an answer."""
        req = uds.read_request(*dids)
        check(dst, req)
        t0 = time.monotonic()
        try:
            frames = self.client.request(dst, req, overall_ms=overall_ms, quiet_ms=quiet_ms)
        except HsfzError as e:
            self._record(dst, req, None, t0, str(e))
            return None
        reply = None
        for f in frames:
            if f.src != dst:
                continue
            r = uds.Reply(f.payload)
            if not r.positive and r.nrc == 0x78:
                continue
            reply = r
        self._record(dst, req, reply, t0, None)
        time.sleep(self.pace_ms / 1000.0)
        return reply

    def discover_units(self, overall_ms=6000, quiet_ms=1500):
        """22 F1 50 to 0xDF: {address: sgbd index or ''} for every unit that answered."""
        req = uds.read_request(uds.DID["SGBD_INDEX"])
        check(FUNCTIONAL, req)
        t0 = time.monotonic()
        frames = self.client.request(FUNCTIONAL, req, overall_ms=overall_ms, quiet_ms=quiet_ms)
        units = {}
        for f in frames:
            r = uds.Reply(f.payload)
            if r.positive and len(r.data) >= 5 and r.data[:2] == b"\xF1\x50":
                units[f.src] = "%02X%02X%02X" % (r.data[2], r.data[3], r.data[4])
            elif f.src not in units:
                units[f.src] = ""
        self._record(FUNCTIONAL, req, None, t0, "%d units answered" % len(units))
        return units

    def _record(self, dst, req, reply, t0, note):
        e = {"dst": "%02X" % dst, "request": uds.hexs(req), "reply": reply.to_dict() if reply else None,
             "ms": int((time.monotonic() - t0) * 1000), "note": note}
        self.exchanges.append(e)
        log.info("uds %02X <- %s | %s%s", dst, e["request"], (reply.to_dict()["raw"] if reply else "no reply"), (" | " + note) if note else "")

    def identify(self, dst):
        """Identification of one unit, one DID per request (a unit may refuse multi-DID reads)."""
        out = {"address": "%02X" % dst, "name": uds.ECU_NAMES.get(dst, "ECU 0x%02X" % dst), "dids": {}}
        for did in IDENT_DIDS:
            r = self.read(dst, [did])
            if r is None:
                out["dids"]["%04X" % did] = None
                continue
            if not r.positive:
                out["dids"]["%04X" % did] = {"nrc": r.nrc, "nrcName": r.nrc_name}
                continue
            data = uds.split_dids(r.data, [did]).get(did, b"")
            entry = {"hex": uds.hexs(data)}
            if did == uds.DID["SGBD_INDEX"]:
                entry["decoded"] = uds.decode_sgbd_index(data)
                out["sgbdIndex"] = entry["decoded"]["index"] if entry["decoded"] else None
            elif did == uds.DID["SVK"]:
                entry["decoded"] = uds.decode_svk(data)
                out["svk"] = entry["decoded"]
            elif did == uds.DID["VIN"]:
                out["vin"] = uds.decode_ascii(data)
                entry["hex"] = "[vin]"
            elif did == uds.DID["ECU_SERIAL"]:
                out["serial"] = uds.decode_ascii(data) or uds.hexs(data)
                entry["hex"] = "[serial]"
            else:
                entry["text"] = uds.decode_ascii(data)
            out["dids"]["%04X" % did] = entry
        return out

    def bdc_lighting(self, dst=BDC_BODY):
        """The BDC's interior-light identifiers (all 0x22 reads)."""
        out = {"address": "%02X" % dst, "reads": {}}
        for did in BDC_LIGHT_DIDS:
            name = uds.DID_NAME.get(did, "%04X" % did)
            r = self.read(dst, [did])
            if r is None:
                out["reads"][name] = {"did": "%04X" % did, "result": "no reply"}
                continue
            if not r.positive:
                out["reads"][name] = {"did": "%04X" % did, "result": "rejected", "nrc": r.nrc, "nrcName": r.nrc_name}
                continue
            data = uds.split_dids(r.data, [did]).get(did, b"")
            entry = {"did": "%04X" % did, "result": "ok", "hex": uds.hexs(data), "length": len(data)}
            if did == uds.DID["LIN1_LAYERING_STATUS"]:
                entry["slaves"] = uds.decode_lin1_status(data)
            elif did == uds.DID["LIN2_LAYERING"]:
                entry["slaves"] = uds.decode_lin2_status(data)
            elif did == uds.DID["INNENLICHT_PWM"]:
                entry["elements"] = uds.decode_pwm(data)
            elif did == uds.DID["FASTA_LIGHT"]:
                entry["decoded"] = uds.decode_fasta(data)
            out["reads"][name] = entry
        return out

    def mgu_extra(self, dst=MGU):
        out = {}
        r = self.read(dst, [uds.DID["MGU_IP"]])
        if r is not None and r.positive:
            data = uds.split_dids(r.data, [uds.DID["MGU_IP"]]).get(uds.DID["MGU_IP"], b"")
            out["ipConfiguration"] = uds.decode_mgu_ip(data)
        elif r is not None:
            out["ipConfiguration"] = {"nrc": r.nrc, "nrcName": r.nrc_name}
        return out


def analyse(report):
    """What the readings say about the lighting-control paths (the same classification as the app)."""
    bdc = report.get("bdc") or {}
    ident = bdc.get("identification") or {}
    variant = None
    for did, e in (ident.get("dids") or {}).items():
        if did == "F150" and e and e.get("decoded"):
            variant = e["decoded"]
    light = (bdc.get("lighting") or {}).get("reads") or {}
    lin1 = light.get("LIN1_LAYERING_STATUS") or {}
    lin2 = light.get("LIN2_LAYERING") or {}
    slaves = (lin1.get("slaves") or []) + (lin2.get("slaves") or [])
    verdicts = []
    if not ident:
        verdicts.append("BDC body (0x40) not identified: nothing can be said about the actuator")
    elif variant is None:
        verdicts.append("BDC answered but 22 F1 50 was refused: variant unknown")
    elif variant.get("rgbActuator") == "documented":
        verdicts.append("BDC variant %s: the RGB layering actuator (2E DA5E) is documented in its SGBD" % variant["sgbd"])
    elif variant.get("rgbActuator") == "legacy":
        verdicts.append("BDC variant %s: DA5E exists but only as full-brightness on/off in the reference (no colour)" % variant["sgbd"])
    else:
        verdicts.append("BDC variant %s is not in the reference: do not write" % variant.get("index"))
    if lin1.get("result") == "ok":
        verdicts.append("22 DA 5F answered: %d RGB LIN slaves on bus 1 with locations" % len(lin1.get("slaves") or []))
    else:
        verdicts.append("22 DA 5F: %s" % (lin1.get("result") or "not read"))
    if lin2.get("result") == "ok":
        verdicts.append("22 E3 D1 answered: %d slaves on bus 2, with per-slave R/G/B read-back" % len(lin2.get("slaves") or []))
    ready = bool(variant and variant.get("rgbActuator") == "documented" and slaves)
    return {"variant": variant, "slaveCount": len(slaves), "verdicts": verdicts,
            "readyForGatedWriteTest": ready,
            "nextStep": ("a single armed write of 2E DA5E to one slave with ZEIT 5 s, parked, then 22 E3D1/DA5F read-back" if ready
                         else "share this report; no write until the variant and the slave list are established")}


def run_scan(gateway=None, port=6801, discovery_ms=600, pace_ms=50, log_fn=None, client=None):
    """The whole discovery. Returns the (unredacted) report dict."""
    started = datetime.now(timezone.utc).isoformat()
    report = {"meta": {"tool": "enetdiag", "version": __version__, "started": started, "readOnly": True, "redacted": False}}
    gateways = []
    if gateway is None:
        gateways = discover(timeout_ms=discovery_ms, log=log.info)
        report["discovery"] = [{"ip": ip, "vin": vin} for ip, vin in gateways]
        if not gateways:
            report["error"] = "no gateway answered the UDP 6811 identification probe (ENET cable in, ignition on, 169.254.x.x adapter?)"
            return report
        gateway = gateways[0][0]
    report["gateway"] = {"ip": gateway, "port": port}
    c = client or EnetClient(gateway, port, log=lambda d, f: log.debug("%s %r", d, f))
    try:
        c.connect()
    except OSError as e:
        report["error"] = "cannot connect to %s:%d: %s" % (gateway, port, e)
        return report
    s = Scanner(c, pace_ms=pace_ms)
    try:
        units = s.discover_units()
        report["units"] = [{"address": "%02X" % a, "name": uds.ECU_NAMES.get(a, "ECU 0x%02X" % a), "sgbdIndex": idx or None} for a, idx in sorted(units.items())]
        report["gatewayUnit"] = s.identify(GATEWAY)
        report["mgu"] = s.identify(MGU)
        report["mgu"]["extra"] = s.mgu_extra(MGU)
        bdc_ident = s.identify(BDC_BODY)
        report["bdc"] = {"identification": bdc_ident, "lighting": s.bdc_lighting(BDC_BODY)}
        report["analysis"] = analyse(report)
    except HsfzError as e:
        report["error"] = str(e)
    finally:
        report["exchanges"] = s.exchanges
        c.close()
    report["meta"]["finished"] = datetime.now(timezone.utc).isoformat()
    return report

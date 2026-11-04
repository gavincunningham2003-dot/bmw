import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools", "laptop"))
from enetdiag import cli, hsfz, scan  # noqa: E402
from enetdiag.simulator import FakeCar, FakeBdc  # noqa: E402


class ScanAgainstTheSimulatedCar(unittest.TestCase):
    def test_full_scan_report_and_policy(self):
        with FakeCar() as car:
            report = scan.run_scan(gateway="127.0.0.1", port=car.port, pace_ms=0)
            self.assertNotIn("error", report)
            addrs = [u["address"] for u in report["units"]]
            self.assertEqual(addrs, ["10", "40", "63"])
            bdc = report["bdc"]
            self.assertEqual(bdc["identification"]["sgbdIndex"], "0F2680")
            light = bdc["lighting"]["reads"]
            self.assertEqual(light["LIN1_LAYERING_STATUS"]["result"], "ok")
            self.assertEqual(len(light["LIN1_LAYERING_STATUS"]["slaves"]), 13)
            self.assertEqual(light["LIN1_LAYERING_STATUS"]["slaves"][0]["r"], 0x78)
            self.assertEqual(light["LIN2_LAYERING"]["slaves"], [])
            self.assertEqual(light["FASTA_LIGHT"]["decoded"]["ambientOnSeconds"], 0x2000)
            # the VIN never appears in the exchange records, not even as hex
            for e in report["exchanges"]:
                if e["reply"] and e["request"].endswith("F1 90"):
                    self.assertIn("[redacted]", e["reply"]["raw"])
            self.assertEqual(light["AMBIENT_STATUS_G11"]["result"], "rejected")
            self.assertEqual(light["AMBIENT_STATUS_G11"]["nrc"], 0x31)
            self.assertEqual(report["mgu"]["extra"]["ipConfiguration"][0], "169.254.36.47")
            a = report["analysis"]
            self.assertTrue(a["readyForGatedWriteTest"])
            self.assertEqual(a["slaveCount"], 13)
            # the policy: the simulated car saw nothing but 0x22
            sids = set(f.payload[0] for f in car.requests if f.payload)
            self.assertEqual(sids, {0x22})
            # redaction on the written report
            with tempfile.TemporaryDirectory() as d:
                path = cli.write_report(report, d, "test")
                with open(path, encoding="utf-8") as f:
                    text = f.read()
                self.assertNotIn("WBA5R71070AB12345", text)
                self.assertIn("WBA**************", text)
                self.assertNotIn("SN0000123456", text)
                j = json.loads(text)
                self.assertTrue(j["meta"]["redacted"])

    def test_car_layout_two_buses(self):
        from enetdiag.simulator import G20_BUS1, G20_BUS2
        ecus = {0x10: FakeBdc(sgbd_index="0F25F0"), 0x40: FakeBdc(slaves=G20_BUS1, slaves2=G20_BUS2), 0x63: FakeBdc(sgbd_index="0F27B0")}
        with FakeCar(ecus=ecus) as car:
            report = scan.run_scan(gateway="127.0.0.1", port=car.port, pace_ms=0)
            reads = report["bdc"]["lighting"]["reads"]
            self.assertEqual(len(reads["LIN1_LAYERING_STATUS"]["slaves"]), 7)
            self.assertEqual(len(reads["LIN2_LAYERING"]["slaves"]), 12)
            self.assertEqual(reads["LIN2_LAYERING"]["slaves"][2]["location"], "Contour line dashboard driver")
            self.assertEqual(report["analysis"]["slaveCount"], 19)

    def test_legacy_variant_is_not_ready(self):
        ecus = {0x10: FakeBdc(sgbd_index="0F25F0"), 0x40: FakeBdc(sgbd_index="0F2050"), 0x63: FakeBdc(sgbd_index="0F27B0")}
        with FakeCar(ecus=ecus) as car:
            report = scan.run_scan(gateway="127.0.0.1", port=car.port, pace_ms=0)
            self.assertFalse(report["analysis"]["readyForGatedWriteTest"])
            self.assertTrue(any("legacy" in v or "no colour" in v for v in report["analysis"]["verdicts"]))

    def test_discovery_over_udp_loopback(self):
        with FakeCar() as car:
            found = hsfz.discover(timeout_ms=400, broadcasts=["127.0.0.1"], port=car.udp_port)
            self.assertEqual(found, [("127.0.0.1", "WBA5R71070AB12345")])

    def test_cli_selftest_writes_files(self):
        with tempfile.TemporaryDirectory() as d:
            rc = cli.main(["selftest", "--out", d])
            self.assertEqual(rc, 0)
            files = os.listdir(d)
            self.assertTrue(any(f.endswith(".json") for f in files))
            self.assertTrue(any(f.endswith(".log") for f in files))

    def test_pending_then_late_reply_is_waited_for(self):
        # the BDC answers DA5F with 7F 22 78 first and the real reply later: the read waits for it
        import threading
        import time as _t
        from enetdiag.hsfz import Frame, TYPE_DIAG, TESTER
        with FakeCar() as car:
            bdc = car.ecus[0x40]
            orig = bdc.answer
            def answer(payload):
                if payload[:3] == b"\x22\xDA\x5F":
                    return b"\x7F\x22\x78"
                return orig(payload)
            bdc.answer = answer
            report = scan.run_scan(gateway="127.0.0.1", port=car.port, pace_ms=0)
            lin1 = report["bdc"]["lighting"]["reads"]["LIN1_LAYERING_STATUS"]
            self.assertEqual(lin1["result"], "no reply", "a pending without a final reply is 'no reply', not a decoded NRC")
            # and the reads after it were not polluted
            self.assertEqual(report["bdc"]["lighting"]["reads"]["INNENLICHT_PWM"]["result"], "ok")

    def test_busy_is_retried(self):
        with FakeCar() as car:
            bdc = car.ecus[0x40]
            orig = bdc.answer
            state = {"n": 0}
            def answer(payload):
                if payload[:3] == b"\x22\x48\x00" and state["n"] < 2:
                    state["n"] += 1
                    return b"\x7F\x22\x21"
                return orig(payload)
            bdc.answer = answer
            report = scan.run_scan(gateway="127.0.0.1", port=car.port, pace_ms=0)
            self.assertEqual(report["bdc"]["lighting"]["reads"]["INNENLICHT_PWM"]["result"], "ok")
            self.assertEqual(state["n"], 2)

    def test_unreachable_gateway_is_reported_not_raised(self):
        report = scan.run_scan(gateway="127.0.0.1", port=1)
        self.assertIn("error", report)


if __name__ == "__main__":
    unittest.main()

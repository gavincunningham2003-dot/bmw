import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools", "laptop"))
from enetdiag import uds  # noqa: E402


class UdsTests(unittest.TestCase):
    def test_read_request(self):
        self.assertEqual(uds.read_request(0xF150), b"\x22\xF1\x50")
        self.assertEqual(uds.read_request(0xDA5F, 0x4800), b"\x22\xDA\x5F\x48\x00")

    def test_reply_positive_and_negative(self):
        r = uds.Reply(b"\x62\xF1\x50\x0F\x26\x80")
        self.assertTrue(r.positive)
        self.assertEqual(r.data, b"\xF1\x50\x0F\x26\x80")
        n = uds.Reply(b"\x7F\x22\x31")
        self.assertFalse(n.positive)
        self.assertEqual((n.nrc, n.nrc_name), (0x31, "requestOutOfRange"))
        self.assertEqual(uds.Reply(b"").positive, False)

    def test_split_dids(self):
        one = uds.split_dids(b"\xDA\x5F\x13\x15", [0xDA5F])
        self.assertEqual(one[0xDA5F], b"\x13\x15")
        two = uds.split_dids(b"\xF1\x50\x0F\x26\x80\xF1\x91\x41\x42", [0xF150, 0xF191])
        self.assertEqual(two[0xF150], b"\x0F\x26\x80")
        self.assertEqual(two[0xF191], b"\x41\x42")

    def test_decoders(self):
        v = uds.decode_sgbd_index(b"\x0F\x26\x80")
        self.assertEqual((v["index"], v["sgbd"], v["rgbActuator"]), ("0F2680", "BDC_G05", "documented"))
        self.assertEqual(uds.decode_sgbd_index(b"\x0F\x99\x99")["rgbActuator"], "unknown")
        empty = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x03, 0x07, 0x07, 0x07, 0x07])
        car = b"".join(bytes([loc, 0xFE, 0x3C, 0x78, 0x64, 0, 0, 0, 0, 0]) for loc in (0x0F, 0x0E, 0x0C, 0x12, 0x22, 0x10, 0x04)) + empty * 19 + b"\x02"
        s = uds.decode_lin1_status(car)
        self.assertEqual([x["nad"] for x in s], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(s[0]["location"], "Map pocket passenger door front")
        self.assertEqual((s[0]["r"], s[0]["g"], s[0]["b"], s[0]["brightness"], s[0]["white"]), (0x78, 0x3C, 0xFE, 100, 0))
        self.assertEqual(s[0]["faults"], {"shortCircuit": 0, "overTemp": 0, "openLoad": 0, "internal": 0})
        s2 = uds.decode_lin2_status(empty + bytes([0x13, 1, 2, 3, 4, 5, 0, 0, 0, 0]))
        self.assertEqual((s2[0]["bus"], s2[0]["nad"], s2[0]["r"]), (2, 2, 3))
        self.assertEqual(len(uds.decode_pwm(bytes(13))), 13)
        import struct
        f = uds.decode_fasta(struct.pack(">IBIIIBIII", 0x1000, 1, 5, 6, 7, 0, 8, 9, 1) + b"\x13\xFF")
        self.assertEqual((f["bdcActiveSeconds"], f["lightSwordFitted"], f["lightSwordOnSeconds"], f["ambientOnSeconds"], f["ambientReducedWhileDrivingSeconds"]), (0x1000, 1, 7, 9, 1))
        self.assertEqual(len(f["slaveLocations"]), 1)
        self.assertIsNone(uds.decode_fasta(b"\x01\x02"))
        svk = uds.decode_svk(bytes([6, 0, 0, 0x3F, 0x36, 0, 15, 2, 5, 0, 0, 0x51, 0xDD, 0, 17, 72]))
        self.assertEqual(svk, [{"type": "BTLD", "id": "00003F36", "version": "000.015.002"}, {"type": "CAFD", "id": "000051DD", "version": "000.017.072"}])
        self.assertEqual(uds.decode_mgu_ip(b"\x00" + bytes([169, 254, 36, 47, 169, 254, 254, 36, 172, 16, 222, 97])), ["169.254.36.47", "169.254.254.36", "172.16.222.97"])

    def test_did_tables_match_the_app(self):
        self.assertEqual(uds.DID["LIN1_LAYERING_CTRL"], 0xDA5E)
        self.assertEqual(uds.DID["LIN2_LAYERING"], 0xE3D1)
        self.assertEqual(uds.ECU_NAMES[0x40], "BDC body")
        self.assertEqual(uds.LOCATION[0x4C], "Cupholder rear")


if __name__ == "__main__":
    unittest.main()

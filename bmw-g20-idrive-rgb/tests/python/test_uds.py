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
        s = uds.decode_lin1_status(b"\x13\xFF\x05\x00\x4B")
        self.assertEqual([(x["nad"], x["locationId"]) for x in s], [(1, 0x13), (3, 0x05), (5, 0x4B)])
        self.assertEqual(s[0]["location"], "Contour line dashboard driver")
        s2 = uds.decode_lin2_status(b"\x01\x0A\x14\x1E\x63\xFF\x00\x00\x00\x00")
        self.assertEqual((s2[0]["nad"], s2[0]["b"], s2[0]["g"], s2[0]["r"], s2[0]["brightness"]), (1, 10, 20, 30, 99))
        self.assertEqual(len(uds.decode_pwm(bytes(13))), 13)
        f = uds.decode_fasta(b"\x00\x00\x10\x00" + b"\x00\x00\x00\x05" + b"\x00\x00\x00\x01" + b"\x13\xFF")
        self.assertEqual((f["bdcActiveSeconds"], f["ambientOnSeconds"], f["ambientReducedWhileDrivingSeconds"]), (0x1000, 5, 1))
        self.assertEqual(len(f["slaves"]), 1)
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

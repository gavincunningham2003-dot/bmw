import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools", "laptop"))
from enetdiag import policy, redact  # noqa: E402


class PolicyTests(unittest.TestCase):
    def test_reads_allowed(self):
        self.assertTrue(policy.check(0x40, b"\x22\xDA\x5F"))
        self.assertTrue(policy.check(0x63, b"\x22\xF1\x50\xF1\x01"))
        self.assertTrue(policy.check(0xDF, b"\x22\xF1\x50"))

    def test_everything_else_refused(self):
        for req in (b"\x2E\xDA\x5E\x01\x01\x64\xFF\x00\x00\x0A", b"\x10\x03", b"\x14\xFF\xFF\xFF", b"\x27\x01", b"\x2F\x48\x00\x03\x32",
                    b"\x31\x01\xA6\x21", b"\x3E\x00", b"\x11\x01", b"\x85\x02", b"\x34", b""):
            with self.assertRaises(policy.PolicyError, msg=req.hex()):
                policy.check(0x40, req)
        with self.assertRaises(policy.PolicyError):
            policy.check(0xDF, b"\x22\xDA\x5F")
        with self.assertRaises(policy.PolicyError):
            policy.check(0x40, b"\x22\xDA")
        with self.assertRaises(policy.PolicyError):
            policy.check(0x40, b"\x22" + b"\xF1\x50" * 9)


class RedactTests(unittest.TestCase):
    def test_vin_in_text_and_keys(self):
        self.assertEqual(redact.redact_text("vin WBA5R71070AB12345 seen"), "vin WBA************** seen")
        r = redact.redact({"vin": "WBA5R71070AB12345", "serial": "SN0000123456", "nested": [{"note": "car WBA5R71070AB12345"}]})
        self.assertEqual(r["vin"], "WBA**************")
        self.assertTrue(r["serial"].startswith("h:"))
        self.assertNotIn("12345", r["nested"][0]["note"])

    def test_keys_and_tokens(self):
        t = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- and ghp_abcdefghijklmnopqrstuvwxyz0123"
        out = redact.redact_text(t)
        self.assertNotIn("abc", out)
        self.assertNotIn("ghp_", out)

    def test_non_strings_untouched(self):
        self.assertEqual(redact.redact({"n": 5, "b": True, "l": [1, 2]}), {"n": 5, "b": True, "l": [1, 2]})


if __name__ == "__main__":
    unittest.main()

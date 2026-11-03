import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools", "laptop"))
from enetdiag import hsfz  # noqa: E402


class FrameTests(unittest.TestCase):
    def test_raw_and_parse_round_trip(self):
        f = hsfz.Frame(hsfz.TYPE_DIAG, hsfz.TESTER, 0x40, b"\x22\xF1\x50")
        raw = f.raw()
        self.assertEqual(raw[:6], b"\x00\x00\x00\x05\x00\x01")
        self.assertEqual(raw[6:], b"\xF4\x40\x22\xF1\x50")
        g = hsfz.Frame.parse(raw)
        self.assertEqual((g.type, g.src, g.dst, g.payload), (1, 0xF4, 0x40, b"\x22\xF1\x50"))

    def test_parse_rejects_bad_lengths(self):
        with self.assertRaises(hsfz.HsfzError):
            hsfz.Frame.parse(b"\x00\x00\x00\x05\x00\x01\xF4")
        with self.assertRaises(hsfz.HsfzError):
            hsfz.Frame.total_length(b"\x00\x00\x00\x01\x00\x01")

    def test_split_frames_handles_partials(self):
        a = hsfz.Frame(1, 0x40, 0xF4, b"\x62\xF1\x50\x0F\x26\x80").raw()
        b = hsfz.Frame(2, 0xF4, 0x40, b"\x22").raw()
        frames, rest = hsfz.split_frames(a + b + a[:7])
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0].payload, b"\x62\xF1\x50\x0F\x26\x80")
        self.assertEqual(frames[1].type, hsfz.TYPE_ACK)
        self.assertEqual(rest, a[:7])

    def test_discovery_reply_parse(self):
        self.assertEqual(hsfz.parse_discovery_reply(b"DIAGADR10BMWMAC0011BMWVINWBA5R71070AB12345"), "WBA5R71070AB12345")
        self.assertIsNone(hsfz.parse_discovery_reply(b"nothing here"))
        self.assertIsNone(hsfz.parse_discovery_reply(b""))


if __name__ == "__main__":
    unittest.main()

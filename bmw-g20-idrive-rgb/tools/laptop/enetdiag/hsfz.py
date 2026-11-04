"""hsfz.py - BMW's HSFZ framing over TCP 6801 and the UDP 6811 gateway discovery.

Frame: u32 length (of control type + body), u16 control type, then the body = src, dst, payload.
Control types: 1 = diagnostic request/response, 2 = acknowledge (the gateway echoes the request),
0xFF = reject. Tester address 0xF4, gateway 0x10, functional 0xDF, MGU 0x63, BDC body 0x40.

Adapted from cauliflowermossgrape/idrive7-8-ssh-root mgu7/hsfz.py + mgu7/discovery.py (Unlicense),
trimmed to what a read-only tool needs: connect, one request -> every frame that answers within a
window, discovery. No routines, no resets, no flashing.
"""
import socket
import struct
import time

ENET_PORT = 6801
DISCOVERY_PORT = 6811
TESTER = 0xF4
GATEWAY = 0x10
FUNCTIONAL = 0xDF
MGU = 0x63
BDC_BODY = 0x40
TYPE_DIAG = 1
TYPE_ACK = 2
TYPE_REJECT = 0xFF
MAX_FRAME = 1 << 20
PROBE = b"\x00\x00\x00\x00\x00\x11"
FALLBACK_BROADCASTS = ("255.255.255.255", "169.254.255.255")


class HsfzError(Exception):
    pass


class Frame:
    __slots__ = ("type", "src", "dst", "payload")

    def __init__(self, ftype, src, dst, payload):
        self.type = ftype
        self.src = src
        self.dst = dst
        self.payload = bytes(payload)

    def raw(self):
        body = bytes((self.src, self.dst)) + self.payload
        if len(body) > MAX_FRAME:
            raise HsfzError("frame too large")
        return struct.pack(">IH", len(body), self.type) + body

    @staticmethod
    def parse(data):
        if len(data) < 8:
            raise HsfzError("frame shorter than its header")
        length, ftype = struct.unpack(">IH", data[:6])
        if length < 2 or length > MAX_FRAME or len(data) != 6 + length:
            raise HsfzError("frame length does not match its header")
        return Frame(ftype, data[6], data[7], data[8:])

    @staticmethod
    def total_length(header):
        if len(header) < 6:
            raise HsfzError("truncated header")
        length = struct.unpack(">I", header[:4])[0]
        if length < 2 or length > MAX_FRAME:
            raise HsfzError("invalid frame length")
        return 6 + length

    def __repr__(self):
        return "Frame(type=%d, %02X->%02X, %s)" % (self.type, self.src, self.dst, self.payload.hex(" ").upper())


def split_frames(buf):
    """(frames, rest) from a byte buffer that may hold several frames and a partial one."""
    frames = []
    pos = 0
    while pos + 6 <= len(buf):
        total = Frame.total_length(buf[pos:pos + 6])
        if pos + total > len(buf):
            break
        frames.append(Frame.parse(buf[pos:pos + total]))
        pos += total
    return frames, buf[pos:]


class EnetClient:
    """One TCP connection to the gateway. request() returns every DIAG frame that answered within the window."""

    def __init__(self, gateway, port=ENET_PORT, log=None, connect_timeout=5.0):
        self.gateway = gateway
        self.port = port
        self.log = log or (lambda direction, frame: None)
        self.connect_timeout = connect_timeout
        self.sock = None
        self.buf = b""

    def connect(self):
        self.close()
        s = socket.create_connection((self.gateway, self.port), timeout=self.connect_timeout)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock = s
        self.buf = b""

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.buf = b""

    @property
    def connected(self):
        return self.sock is not None

    def request(self, dst, payload, overall_ms=4000, quiet_ms=400, first_ms=None, pending_ms=15000):
        """Send one diagnostic request and collect replies until quiet_ms pass without data
        (or overall_ms in all). A 'response pending' (7F sid 78) from the unit extends the wait by
        pending_ms (the BDC polls its LIN bus before answering DA5F, which takes seconds) and is not
        returned. Returns the DIAG frames addressed to the tester, in order."""
        if not self.connected:
            raise HsfzError("not connected")
        frame = Frame(TYPE_DIAG, TESTER, dst, payload)
        self.sock.sendall(frame.raw())
        self.log("tx", frame)
        frames = []
        deadline = time.monotonic() + overall_ms / 1000.0
        first_deadline = time.monotonic() + (first_ms or overall_ms) / 1000.0
        last_data = None
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            if frames and last_data is not None and now - last_data >= quiet_ms / 1000.0:
                break
            if not frames and now >= first_deadline:
                break
            remain = min(deadline - now, 0.1)
            self.sock.settimeout(max(remain, 0.01))
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError as e:
                raise HsfzError("connection error: %s" % e)
            if not chunk:
                raise HsfzError("connection closed by the gateway")
            self.buf += chunk
            last_data = time.monotonic()
            got, self.buf = split_frames(self.buf)
            for f in got:
                self.log("rx", f)
                if f.type == TYPE_REJECT:
                    raise HsfzError("the gateway rejected the request")
                if f.type == TYPE_DIAG and f.dst == TESTER:
                    p = f.payload
                    if len(p) >= 3 and p[0] == 0x7F and p[2] == 0x78 and p[1] == payload[0]:
                        deadline = max(deadline, time.monotonic() + pending_ms / 1000.0)
                        first_deadline = deadline
                        last_data = None
                        continue
                    frames.append(f)
        return frames


def parse_discovery_reply(data):
    """The VIN from a 6811 identification reply (the text after 'BMWVIN'), or None."""
    if not data:
        return None
    text = data.replace(b"\x00", b"").decode("ascii", "replace")
    i = text.find("BMWVIN")
    if i < 0:
        return None
    return text[i + 6:i + 6 + 17]


def discover(timeout_ms=600, broadcasts=None, port=DISCOVERY_PORT, log=None):
    """Broadcast the identification probe and return [(ip, vin)] of every gateway that answered."""
    log = log or (lambda msg: None)
    targets = list(broadcasts or []) + [b for b in FALLBACK_BROADCASTS if b not in (broadcasts or [])]
    results = []
    seen = set()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for t in targets:
            try:
                sock.sendto(PROBE, (t, port))
                log("discovery probe -> %s:%d" % (t, port))
            except OSError as e:
                log("discovery probe to %s failed: %s" % (t, e))
        deadline = time.monotonic() + timeout_ms / 1000.0
        sock.settimeout(0.1)
        while time.monotonic() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            vin = parse_discovery_reply(data)
            if vin is None or addr[0] in seen:
                continue
            seen.add(addr[0])
            results.append((addr[0], vin))
    finally:
        sock.close()
    return results

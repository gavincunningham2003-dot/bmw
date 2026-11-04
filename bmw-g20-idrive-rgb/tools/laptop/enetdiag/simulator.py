"""simulator.py - a pretend car on the loopback interface: the HSFZ gateway on a TCP port and the UDP
identification responder, with a gateway (0x10), an MGU (0x63) and a BDC_G05-like body controller
(0x40) that answers the identifiers the scan reads. For the self-test and the unit tests; it never
touches a network adapter other than 127.0.0.1. Only 0x22 is answered positively; any other service
gets NRC 11 so a policy slip would be visible in a report.
"""
import socket
import struct
import threading

from .hsfz import Frame, TYPE_ACK, TYPE_DIAG, TESTER, FUNCTIONAL, split_frames, PROBE

FAKE_VIN = "WBA5R71070AB12345"
DEFAULT_SLAVES = [0x13, 0x15, 0x17, 0x05, 0x06, 0x0C, 0x0D, 0x09, 0x10, 0x01, 0x03, 0x2B, 0x2D]
# the real G20 330e layout (2026-11-04): FI-LIN-1 passenger side, FI-LIN-2 dashboard + front footwells + driver side
G20_BUS1 = [0x0F, 0x0E, 0x0C, 0x12, 0x22, 0x10, 0x04]
G20_BUS2 = [0x15, 0x17, 0x13, 0x01, 0x03, 0x08, 0x07, 0x05, 0x0B, 0x21, 0x09, 0x02]


def _svk():
    return bytes([1, 0, 0, 0x8B, 0x1B, 0, 1, 1, 6, 0, 0, 0x3F, 0x36, 0, 15, 2, 5, 0, 0, 0x51, 0xDD, 0, 17, 72, 8, 0, 0, 0x9A, 0x01, 0, 15, 2])


class FakeEcu:
    def __init__(self, address, sgbd_index, extra=None):
        self.address = address
        self.sgbd = bytes.fromhex(sgbd_index)
        self.extra = extra or {}

    def answer(self, payload):
        if not payload or payload[0] != 0x22:
            return bytes([0x7F, payload[0] if payload else 0, 0x11])
        body = payload[1:]
        if len(body) < 2 or len(body) % 2:
            return bytes([0x7F, 0x22, 0x13])
        out = bytearray([0x62])
        answered = 0
        for i in range(0, len(body), 2):
            did = struct.unpack(">H", body[i:i + 2])[0]
            data = self.did(did)
            if data is None:
                continue
            out += body[i:i + 2] + data
            answered += 1
        if not answered:
            return bytes([0x7F, 0x22, 0x31])
        return bytes(out)

    def did(self, did):
        if did == 0xF150:
            return self.sgbd
        if did == 0xF101:
            return _svk()
        if did == 0xF190:
            return FAKE_VIN.encode("ascii")
        if did == 0xF18C:
            return b"SN0000123456"
        if did == 0xF191:
            return b"8710123"
        if did == 0xF195:
            return b"0001"
        return self.extra.get(did)


class FakeBdc(FakeEcu):
    def __init__(self, slaves=None, sgbd_index="0F2680", slaves2=None):
        self.slaves = slaves or DEFAULT_SLAVES
        self.slaves2 = slaves2 or []
        super().__init__(0x40, sgbd_index)

    @staticmethod
    def _records(locs):
        out = bytearray()
        for i in range(26):
            out += bytes([locs[i], 0xFE, 0x3C, 0x78, 0x64, 0, 0, 0, 0, 0]) if i < len(locs) else bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x03, 0x07, 0x07, 0x07, 0x07])
        return bytes(out) + b"\x02"

    def did(self, did):
        if did == 0xDA5F:
            return self._records(self.slaves)
        if did == 0xE3D1:
            return self._records(self.slaves2)
        if did == 0x4800:
            return bytes([0, 64, 64, 64, 64, 0, 0, 0, 0, 0, 0, 0, 0])
        if did == 0x2300:
            return struct.pack(">IBIIIBIII", 0x123456, 1, 5, 6, 0x1000, 0, 0, 0x2000, 0x10) + bytes(self.slaves)
        return super().did(did)


class FakeCar:
    """The TCP gateway + UDP responder, on 127.0.0.1 and free ports. with FakeCar() as car: car.port / car.udp_port"""

    def __init__(self, ecus=None, port=0, udp_port=0):
        self.ecus = ecus or {0x10: FakeEcu(0x10, "0F25F0"), 0x63: FakeEcu(0x63, "0F27B0", {0x172A: b"\x00" + bytes([169, 254, 36, 47, 169, 254, 254, 36, 172, 16, 222, 97])}), 0x40: FakeBdc()}
        self.port = port
        self.udp_port = udp_port
        self.requests = []
        self._stop = threading.Event()
        self._threads = []

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *a):
        self.stop()

    def start(self):
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp.bind(("127.0.0.1", self.port))
        self.tcp.listen(2)
        self.tcp.settimeout(0.2)
        self.port = self.tcp.getsockname()[1]
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("127.0.0.1", self.udp_port))
        self.udp.settimeout(0.2)
        self.udp_port = self.udp.getsockname()[1]
        for fn in (self._serve_tcp, self._serve_udp):
            t = threading.Thread(target=fn, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self):
        self._stop.set()
        for t in self._threads:
            t.join(timeout=1)
        for s in (self.tcp, self.udp):
            try:
                s.close()
            except OSError:
                pass

    def _serve_udp(self):
        while not self._stop.is_set():
            try:
                data, addr = self.udp.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            if data == PROBE:
                self.udp.sendto(b"DIAGADR10BMWMAC001122334455BMWVIN" + FAKE_VIN.encode("ascii"), addr)

    def _serve_tcp(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.tcp.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._serve_conn, args=(conn,), daemon=True).start()

    def _serve_conn(self, conn):
        buf = b""
        conn.settimeout(0.2)
        while not self._stop.is_set():
            try:
                chunk = conn.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            frames, buf = split_frames(buf)
            for f in frames:
                self.requests.append(f)
                if f.type != TYPE_DIAG:
                    continue
                try:
                    conn.sendall(Frame(TYPE_ACK, f.src, f.dst, f.payload[:1]).raw())
                    targets = list(self.ecus.values()) if f.dst == FUNCTIONAL else [self.ecus[f.dst]] if f.dst in self.ecus else []
                    for ecu in targets:
                        reply = ecu.answer(f.payload)
                        if f.dst == FUNCTIONAL and reply[0] == 0x7F:
                            continue
                        conn.sendall(Frame(TYPE_DIAG, ecu.address, TESTER, reply).raw())
                except OSError:
                    break
        try:
            conn.close()
        except OSError:
            pass

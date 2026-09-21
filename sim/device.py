#!/usr/bin/env python3
"""模拟一台采集设备：TCP 长连接上报 + 心跳 + 应答下行指令。

用法：
    python3 sim/device.py [--host 127.0.0.1] [--port 9000] [--interval 0.5]
                          [--src-ip 127.0.0.2] [--no-ack] [--garbage]

--src-ip 可以绑定不同的本地回环地址（127.0.0.x），用来模拟多台设备。
"""

import argparse
import random
import socket
import struct
import sys
import threading
import time
import zlib

MAGIC = b"\xeb\x90"
VERSION = 0x01
T_REPORT, T_HEARTBEAT, T_ACK, T_COMMAND = 0x01, 0x02, 0x03, 0x81

seq_lock = threading.Lock()
seq = 0


def next_seq():
    global seq
    with seq_lock:
        seq += 1
        return seq


def tlv(t, v):
    return bytes([t]) + struct.pack(">H", len(v)) + v


def frame(ftype, payload=b"", flags=0, fseq=None):
    s = next_seq() if fseq is None else fseq
    head = MAGIC + bytes([VERSION, ftype, flags]) + struct.pack(">II", s, len(payload))
    body = head + payload
    return body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF), s


def report_payload():
    temp = int(random.uniform(180, 350))          # 0.1 度
    hum = int(random.uniform(300, 700))           # 0.1 %RH
    volt = int(random.uniform(225, 245))          # 0.1 V
    status = random.choice([0, 0, 0, 1])
    return (
        tlv(0x01, struct.pack(">h", temp))
        + tlv(0x02, struct.pack(">H", hum))
        + tlv(0x03, struct.pack(">H", volt))
        + tlv(0x04, struct.pack(">H", status))
    )


def read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def command_loop(sock, no_ack):
    """读下行指令（0x81）并回 0x03 应答，序号与指令一致。"""
    try:
        while True:
            magic = read_exact(sock, 2)
            if magic != MAGIC:
                continue
            ver, ftype, flags, s, plen = struct.unpack(">BBBII", read_exact(sock, 11))
            payload = read_exact(sock, plen)
            read_exact(sock, 4)  # crc
            if ftype == T_COMMAND:
                print(f"[sim] got command seq={s} payload={payload.hex()}", flush=True)
                if not no_ack:
                    ack_payload = tlv(0x04, struct.pack(">H", 0))  # 状态码 0 = OK
                    pkt, _ = frame(T_ACK, ack_payload, fseq=s)
                    sock.sendall(pkt)
                    print(f"[sim] sent ack seq={s}", flush=True)
    except (ConnectionError, OSError):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--src-ip", default=None, help="绑定源地址，模拟多台设备")
    ap.add_argument("--no-ack", action="store_true", help="收到指令不应答（测超时）")
    ap.add_argument("--garbage", action="store_true", help="先发一段畸形字节（测重同步）")
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if args.src_ip:
        sock.bind((args.src_ip, 0))
    sock.connect((args.host, args.port))
    print(f"[sim] connected to {args.host}:{args.port} from {sock.getsockname()}", flush=True)

    threading.Thread(target=command_loop, args=(sock, args.no_ack), daemon=True).start()

    if args.garbage:
        # 模拟固件 bug：畸形长度 + 随机字节，之后恢复正常帧。
        bad = MAGIC + bytes([VERSION, T_REPORT, 0]) + struct.pack(">II", 0, 0x7FFFFFFF) + b"\x00" * 8
        sock.sendall(bad + b"\xde\xad\xbe\xef" + MAGIC[:1])
        print("[sim] sent garbage bytes", flush=True)

    n = 0
    try:
        while True:
            n += 1
            if n % 10 == 0:
                pkt, s = frame(T_HEARTBEAT)
                kind = "heartbeat"
            else:
                pkt, s = frame(T_REPORT, report_payload())
                kind = "report"
            # 模拟粘包：攒两帧一起发。
            pkt2, s2 = frame(T_REPORT, report_payload())
            sock.sendall(pkt + pkt2)
            print(f"[sim] sent {kind} seq={s} + report seq={s2} (coalesced)", flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()


if __name__ == "__main__":
    sys.exit(main())

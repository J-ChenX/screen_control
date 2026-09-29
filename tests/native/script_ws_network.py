#!/usr/bin/env python3
"""在回环地址驱动完整代理的脚本 WebSocket 事件循环；不加载代理身份。"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import zlib


def frame(opcode, payload, fin=True, compressed=False, mask=False):
    lead = opcode | (128 if fin else 0) | (64 if compressed else 0)
    length = len(payload)
    if length < 126:
        header = bytes([lead, length | (128 if mask else 0)])
    elif length <= 65535:
        header = bytes([lead, 126 | (128 if mask else 0)]) + length.to_bytes(2, "big")
    else:
        header = bytes([lead, 127 | (128 if mask else 0)]) + length.to_bytes(8, "big")
    if mask:
        key = b"\x11\x22\x33\x44"
        return header + key + bytes(x ^ key[i % 4] for i, x in enumerate(payload))
    return header + payload


def cases():
    payload = b"a" * 10000 + b"bbb"
    compressor = zlib.compressobj(wbits=-15)
    packed = compressor.compress(payload) + compressor.flush(zlib.Z_SYNC_FLUSH)
    second = zlib.compressobj(wbits=-15)
    packed_second = second.compress(b"z" * 4096) + second.flush(zlib.Z_SYNC_FLUSH)
    shared = zlib.compressobj(wbits=-15)
    repeated = b"abcdefghijklmnopqrstuvwxyz" * 300
    shared_first = shared.compress(repeated) + shared.flush(zlib.Z_SYNC_FLUSH)
    shared_second = shared.compress(repeated) + shared.flush(zlib.Z_SYNC_FLUSH)
    return [
        ("empty-leading-fragment", [frame(2, b"", fin=False), frame(0, b"x")], b"x", False),
        ("empty-trailing-fragment", [frame(2, b"x", fin=False), frame(0, b"")], b"x", False),
        ("empty-fragmented-message", [frame(2, b"", fin=False), frame(0, b"")], b"", False),
        ("fragment-10003", [frame(2, payload[:10000], fin=False), frame(0, payload[10000:])], payload, False),
        ("masked-fragment-10003", [frame(2, payload[:10000], fin=False, mask=True), frame(0, payload[10000:], mask=True)], payload, False),
        ("control-between-fragments", [frame(2, payload[:10000], fin=False), frame(9, b""), frame(0, payload[10000:])], payload, False),
        ("compressed-10003", [frame(2, packed[:-4], compressed=True)], payload, True),
        ("compressed-fragment", [frame(2, packed[:5], fin=False, compressed=True), frame(0, packed[5:-4])], payload, True),
        ("compressed-consecutive", [frame(2, packed[:-4], compressed=True), frame(2, packed_second[:-4], compressed=True)], payload + b"z" * 4096, True),
        ("compressed-shared-window", [frame(2, shared_first[:-4], compressed=True), frame(2, shared_second[:-4], compressed=True)], repeated + repeated, True),
        ("coalesced-two-messages", [frame(2, b"first") + frame(2, b"second")], b"firstsecond", False),
        ("full-65536", [frame(2, b"x" * 65536)], b"x" * 65536, False),
    ]


def run_case(binary, label, frames, expected, compressed):
    server_errors = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-ws-") as work:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        server.settimeout(8)
        port = server.getsockname()[1]

        def peer():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(8)
                    request = b""
                    while b"\r\n\r\n" not in request:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise RuntimeError("handshake ended")
                        request += chunk
                    lines = request.split(b"\r\n")
                    key = next(line.split(b":", 1)[1].strip() for line in lines if line.lower().startswith(b"sec-websocket-key:"))
                    if compressed and b"permessage-deflate" not in request.lower():
                        raise RuntimeError("compression was not requested")
                    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                    response = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n"
                    if compressed:
                        response += b"Sec-WebSocket-Extensions: permessage-deflate\r\n"
                    connection.sendall(response + b"\r\n")
                    for packet in frames:
                        connection.sendall(packet)
                    while connection.recv(4096):
                        pass
            except Exception as exc:
                server_errors.append(str(exc))

        worker = threading.Thread(target=peer)
        worker.start()
        script = Path(work) / "probe.js"
        expected_b64 = base64.b64encode(expected).decode("ascii")
        expected_events = 2 if label in ("compressed-consecutive", "compressed-shared-window", "coalesced-two-messages") else 1
        script.write_text(f"""var http=require('http');var count=0;var events=0;var match=true;
var expected=Buffer.from('{expected_b64}','base64');
var opt=http.parseUri('ws://127.0.0.1:{port}/probe');opt.perMessageDeflate={'true' if compressed else 'false'};
var req=http.request(opt);
req.on('upgrade',function(r,s,h){{s.on('data',function(b){{events++;for(var i=0;i<b.length;i++){{if(count+i>=expected.length||b[i]!==expected[count+i])match=false;}}count+=b.length;
if(count==={len(expected)}){{console.log('received='+count+',events='+events+',match='+match);process.exit(match&&events==={expected_events}?0:4);}}}});}});
req.on('error',function(e){{console.log('request-error');process.exit(2);}});req.end();
setTimeout(function(){{console.log('timeout='+count);process.exit(3);}},5000);""")
        try:
            result = subprocess.run([str(binary), str(script)], cwd=work, capture_output=True, text=True, timeout=7)
        finally:
            worker.join(9)
        if result.returncode != 0 or server_errors or f"received={len(expected)},events={expected_events},match=true" not in result.stdout:
            raise RuntimeError(json.dumps({"case": label, "exit": result.returncode, "stdout": result.stdout[-3000:], "stderr": result.stderr[:3000], "peerErrors": server_errors}))
        print(label, "passed")


def run_reentrant_close_case(binary, compressed, close_mode):
    """在数据回调内关闭连接，覆盖 C 回调返回前 Rust 解码器被释放的路径。"""
    errors = []
    saw_eof = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-ws-reentrant-") as work:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        server.settimeout(5)
        port = server.getsockname()[1]

        def peer():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(5)
                    request = b""
                    while b"\r\n\r\n" not in request:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise RuntimeError("handshake ended")
                        request += chunk
                    key = next(line.split(b":", 1)[1].strip() for line in request.split(b"\r\n")
                               if line.lower().startswith(b"sec-websocket-key:"))
                    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                    response = (b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                                b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n")
                    if compressed:
                        response += b"Sec-WebSocket-Extensions: permessage-deflate\r\n"
                    payload = b"abc"
                    if compressed:
                        encoder = zlib.compressobj(wbits=-15)
                        payload = (encoder.compress(payload) + encoder.flush(zlib.Z_SYNC_FLUSH))[:-4]
                    connection.sendall(response + b"\r\n" + frame(2, payload, compressed=compressed))
                    while connection.recv(4096):
                        pass
                    saw_eof.append(True)
            except Exception as exc:
                errors.append(str(exc))

        worker = threading.Thread(target=peer)
        worker.start()
        script = Path(work) / "probe.js"
        close_call = "s.end();" if close_mode == "end" else "req.abort();"
        script.write_text(f"""var http=require('http'),seen=0;
var opt=http.parseUri('ws://127.0.0.1:{port}/probe');opt.perMessageDeflate={'true' if compressed else 'false'};
var req=http.request(opt);
req.on('upgrade',function(r,s,h){{s.on('data',function(b){{seen++;if(b.length!==3||b[0]!==97||b[1]!==98||b[2]!==99)process.exit(4);
{close_call}setTimeout(function(){{console.log('seen='+seen);process.exit(seen===1?0:5);}},100);}});}});
req.on('error',function(){{process.exit(2);}});req.end();
setTimeout(function(){{process.exit(3);}},3000);""")
        try:
            result = subprocess.run([str(binary), str(script)], cwd=work, capture_output=True, text=True, timeout=5)
        finally:
            worker.join(6)
        label = f"reentrant-{close_mode}-{'compressed' if compressed else 'plain'}"
        if result.returncode != 0 or errors or not saw_eof or "seen=1" not in result.stdout:
            raise RuntimeError(json.dumps({"case": label, "exit": result.returncode,
                                           "stdout": result.stdout[-1000:], "stderr": result.stderr[-3000:],
                                           "peerErrors": errors, "eof": bool(saw_eof)}))
        print(label, "passed")


def run_terminal_case(binary, label, packet, compressed=False, process_timeout=5):
    """保持脚本事件循环存活，确认对端确实收到 EOF。"""
    errors = []
    saw_eof = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-ws-end-") as work:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        server.settimeout(5)
        port = server.getsockname()[1]

        def peer():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(2)
                    request = b""
                    while b"\r\n\r\n" not in request:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise RuntimeError("handshake ended")
                        request += chunk
                    key = next(line.split(b":", 1)[1].strip() for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
                    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                    response = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n"
                    if compressed:
                        response += b"Sec-WebSocket-Extensions: permessage-deflate\r\n"
                    connection.sendall(response + b"\r\n")
                    connection.sendall(packet)
                    while True:
                        if not connection.recv(4096):
                            saw_eof.append(True)
                            break
            except Exception as exc:
                errors.append(str(exc))

        worker = threading.Thread(target=peer)
        worker.start()
        script = Path(work) / "probe.js"
        script.write_text(f"""var http=require('http');var opt=http.parseUri('ws://127.0.0.1:{port}/probe');opt.perMessageDeflate={'true' if compressed else 'false'};
var req=http.request(opt);req.on('upgrade',function(r,s,h){{s.on('end',function(){{console.log('socket-end');}});
s.on('error',function(){{console.log('socket-error');}});s.on('close',function(){{console.log('socket-close');}});
s.on('data',function(b){{console.log('unexpected-data='+b.length);}});}});
req.on('error',function(){{console.log('request-error');}});req.end();
setTimeout(function(){{process.exit(0);}},3000);""")
        try:
            result = subprocess.run([str(binary), str(script)], cwd=work, capture_output=True, text=True, timeout=process_timeout)
        finally:
            worker.join(4)
        if result.returncode != 0 or errors or not saw_eof or "socket-end" not in result.stdout or "unexpected-data=" in result.stdout:
            raise RuntimeError(json.dumps({"case": label, "exit": result.returncode, "stdout": result.stdout[-1000:], "stderr": result.stderr[-1000:], "peerErrors": errors, "eof": bool(saw_eof)}))
        print(label, "passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--process-timeout", type=int, default=5)
    args = parser.parse_args()
    for label, frames, expected, compressed in cases():
        run_case(args.binary.resolve(), label, frames, expected, compressed)
    for compressed in (False, True):
        for close_mode in ("end", "abort"):
            run_reentrant_close_case(args.binary.resolve(), compressed, close_mode)
    for label, packet in [
        ("close-eof", frame(8, b"")),
        ("invalid-reserved-eof", b"\xa2\x00"),
        ("orphan-continuation-eof", frame(0, b"a")),
        ("over-budget-header-eof", b"\x82\x7f" + (67108865).to_bytes(8, "big")),
    ]:
        run_terminal_case(args.binary.resolve(), label, packet, process_timeout=args.process_timeout)
    compressor = zlib.compressobj(wbits=-15)
    over_budget = compressor.compress(b"a" * ((64 << 20) + 1)) + compressor.flush(zlib.Z_SYNC_FLUSH)
    run_terminal_case(args.binary.resolve(), "decompressed-over-budget-eof", frame(2, over_budget[:-4], compressed=True), compressed=True, process_timeout=args.process_timeout)
    run_terminal_case(args.binary.resolve(), "invalid-deflate-eof", frame(2, b"\xff", compressed=True), compressed=True, process_timeout=args.process_timeout)


if __name__ == "__main__":
    main()

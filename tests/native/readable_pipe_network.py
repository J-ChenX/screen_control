#!/usr/bin/env python3
"""在无代理身份的回环脚本中验证可读流逐个 unpipe 后的链表行为。"""
import argparse
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading


CASES = (
    ("middle-then-tail", "s.unpipe(b);s.unpipe(c);", "events[1]===1&&events[2]===1", (0, 1, 1), (5, 0, 0), (5, 0, 5)),
    ("head-then-middle", "s.unpipe(a);s.unpipe(b);", "events[0]===1&&events[1]===1", (1, 1, 0), (0, 0, 5), (0, 5, 5)),
)


def run_case(binary, label, unpipe, ready_events, expected_events, expected):
    peer_errors = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-pipe-") as directory:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        server.settimeout(5)
        port = server.getsockname()[1]

        def peer():
            try:
                connection, _ = server.accept()
                with connection:
                    connection.settimeout(5)
                    ready = b""
                    while len(ready) < 5:
                        part = connection.recv(5 - len(ready))
                        if not part:
                            raise RuntimeError("代理未完成 unpipe 就关闭连接")
                        ready += part
                    if ready != b"ready":
                        raise RuntimeError("代理就绪标记不正确")
                    connection.sendall(b"hello")
                    connection.shutdown(socket.SHUT_WR)
            except Exception as error:
                peer_errors.append(type(error).__name__ + ": " + str(error))

        worker = threading.Thread(target=peer)
        worker.start()
        script = Path(directory) / "probe.js"
        script.write_text(f"""var net=require('net'),W=require('stream').Writable;
var counts=[0,0,0],events=[0,0,0],connected=false,sent=false,s;
function ready(){{if(connected&&{ready_events}&&!sent){{sent=true;s.write('ready');}}}}
function make(i){{var w=new W({{write:function(chunk,flush){{counts[i]+=chunk.length;flush();}}}});
w.on('unpipe',function(){{events[i]++;ready();}});return w;}}
var a=make(0),b=make(1),c=make(2);s=net.createConnection({port},'127.0.0.1');
s.on('connect',function(){{connected=true;ready();}});
s.pipe(a,{{end:false}});s.pipe(b,{{end:false}});s.pipe(c,{{end:false}});
{unpipe}
s.on('end',function(){{console.log('counts='+counts.join(',')+',events='+events.join(','));process.exit(0);}});
s.on('error',function(){{console.log('socket-error');process.exit(2);}});
setTimeout(function(){{console.log('timeout');process.exit(3);}},4000);
""")
        environment = os.environ.copy()
        environment.setdefault("ASAN_OPTIONS", "detect_leaks=0:halt_on_error=1")
        environment.setdefault("UBSAN_OPTIONS", "halt_on_error=1")
        try:
            result = subprocess.run([str(binary), str(script)], cwd=directory, env=environment,
                                    capture_output=True, text=True, timeout=6)
        finally:
            worker.join(timeout=6)
        if worker.is_alive() or peer_errors or result.returncode != 0:
            raise RuntimeError(f"{label}: exit={result.returncode}, peer={peer_errors}, "
                               f"stdout={result.stdout[-400:]}, stderr={result.stderr[-500:]}")
        match = re.search(r"counts=(\d+),(\d+),(\d+),events=(\d+),(\d+),(\d+)", result.stdout)
        if match is None:
            raise RuntimeError(f"{label}: 未取得完整计数")
        counts = tuple(int(value) for value in match.groups()[:3])
        events = tuple(int(value) for value in match.groups()[3:])
        if counts != expected or events != expected_events:
            raise RuntimeError(f"{label}: 数据与 unpipe 事件不符，counts={counts}, events={events}")
        print(f"{label}: counts={counts}, events={events}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--expect-legacy-defect", action="store_true")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    for label, unpipe, ready_events, expected_events, fixed, legacy in CASES:
        run_case(binary, label, unpipe, ready_events, expected_events,
                 legacy if args.expect_legacy_defect else fixed)


if __name__ == "__main__":
    main()

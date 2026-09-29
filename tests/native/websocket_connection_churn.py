#!/usr/bin/env python3
"""在回环地址反复关闭和取消脚本 WebSocket，采样完整代理的驻留内存。"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import socket
import subprocess
import tempfile
import threading
import time


PSS_LIMIT_KIB = 256 * 1024
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def candidate_binary(path):
    metadata = json.loads((path / "candidate.json").read_text())
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        raise RuntimeError("仅接受未部署的 ASan/UBSan 候选")
    binary = path / f"MeshAgent-{metadata['baselineCommit']}" / "DEBUG_meshagent_x86-64"
    if sha256(binary) != metadata.get("binarySha256") or \
            sha256(path / "source.tar.gz") != metadata.get("archiveSha256"):
        raise RuntimeError("候选二进制或固定源码摘要不一致")
    return binary


def process_memory(pid):
    text = Path(f"/proc/{pid}/smaps_rollup").read_text()
    values = {}
    for line in text.splitlines():
        if line.startswith("Pss:"):
            values["pss_kib"] = int(line.split()[1])
        elif line.startswith("Anonymous:"):
            values["anonymous_kib"] = int(line.split()[1])
    if set(values) != {"pss_kib", "anonymous_kib"}:
        raise RuntimeError("进程内存字段不完整")
    return values


def client_script(port, mode, iterations, track_request_finalizers=False):
    interval = max(1, iterations // 10)
    if mode in ("close", "close-end", "close-wait", "close-rooted", "close-root-req", "close-root-socket"):
        completion = """socket.on('data',function(){});
setTimeout(finish,25);
socket.on('error',function(){console.log('socket-error');process.exit(3);});"""
        if mode in ("close-end", "close-wait"):
            completion = """socket.on('end',function(){finish();});
socket.on('error',function(){console.log('socket-error');process.exit(3);});"""
        retain_socket = "retained.push(socket);" if mode in ("close-rooted", "close-root-socket") else ""
        release = ("socket.on('end',function(){dropRetained(socket);dropRetained(req);});"
                   if mode in ("close-rooted", "close-root-req", "close-root-socket") else "")
        on_upgrade = "req.on('upgrade',function(response,socket,head){" + retain_socket + release + completion + "});"
        on_abort = ""
    else:
        on_upgrade = "req.on('upgrade',function(){console.log('unexpected-upgrade');process.exit(4);});"
        on_abort = "setTimeout(function(){req.abort();finish();},20);"
    finalizer_listener = "req.on('~',function(){requestFinalizers++;});" if track_request_finalizers else ""
    finalizer_sample = "stage+=',requestFinalizers='+requestFinalizers;" if track_request_finalizers else ""
    return f"""var http=require('http'), completed=0, watchdog, retained=[], requestFinalizers=0;
function dropRetained(item){{var index=retained.indexOf(item);if(index>=0)retained.splice(index,1);}}
function finish(){{
 completed++;
 if(completed%{interval}===0||completed==={iterations})setTimeout(function(){{
  _debugGC();setTimeout(function(){{_debugGC();setTimeout(function(){{
   var stage='stage='+completed;
   if(typeof __scNetRoots==='function')stage+=',roots='+__scNetRoots();
   if(typeof __scChainLinks==='function')stage+=',links='+__scChainLinks();
   if(typeof __scAllocatedKB==='function')stage+=',allocated='+__scAllocatedKB();
   if(typeof __scTimerRoots==='function')stage+=',timerRoots='+__scTimerRoots();
   if(typeof __scStashCount==='function')stage+=',stashCount='+__scStashCount();
   if(typeof __scStashNested==='function')stage+=',stashNested='+__scStashNested();
   if(typeof __scFinalizerCounts==='function')stage+=',finalizerCounts='+__scFinalizerCounts();
   {finalizer_sample}
   console.log(stage);
   if(completed==={iterations})setTimeout(function(){{process.exit(0);}},200);
   else setTimeout(connect,1);
  }},100);}},100);
 }},50);
 else setTimeout(connect,1);
}}
function connect(){{
 var opt=http.parseUri('ws://127.0.0.1:{port}/probe');opt.perMessageDeflate=false;
 if('{mode}'!=='close-end')opt.agent=false;
 var req=http.request(opt);
 {finalizer_listener}
 if('{mode}'==='close-rooted'||'{mode}'==='close-root-req')retained.push(req);
 {on_upgrade}
 req.on('error',function(){{console.log('request-error');process.exit(2);}});
 req.end();
 {on_abort}
}}
watchdog=setTimeout(function(){{console.log('watchdog='+completed);process.exit(5);}},
                    {max(55000, iterations * 800)});
connect();
"""


def run_mode(binary, mode, iterations, track_request_finalizers=False):
    errors = []
    eof_count = []
    accepted_count = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-ws-churn-") as temporary:
        server.bind(("127.0.0.1", 0))
        server.listen(64)
        server.settimeout(5)
        port = server.getsockname()[1]

        def peer():
            try:
                for _ in range(iterations):
                    connection, _ = server.accept()
                    accepted_count.append(True)
                    with connection:
                        connection.settimeout(5)
                        request = b""
                        while b"\r\n\r\n" not in request:
                            piece = connection.recv(4096)
                            if not piece and mode == "abort":
                                eof_count.append(True)
                                break
                            if not piece or len(request) + len(piece) > 16384:
                                raise RuntimeError("握手请求缺失或过长")
                            request += piece
                        if mode == "abort" and b"\r\n\r\n" not in request:
                            continue
                        if mode in ("close", "close-end", "close-wait", "close-rooted", "close-root-req", "close-root-socket"):
                            key = next(line.split(b":", 1)[1].strip() for line in request.split(b"\r\n")
                                       if line.lower().startswith(b"sec-websocket-key:"))
                            accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
                            response = (b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                                        b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                            if mode == "close-end":
                                connection.sendall(response + b"\x88\x00")
                            else:
                                connection.sendall(response)
                                connection.sendall(b"\x88\x00")
                        while connection.recv(4096):
                            pass
                        eof_count.append(True)
            except Exception as error:
                errors.append(str(error))

        worker = threading.Thread(target=peer)
        worker.start()
        work = Path(temporary)
        script = work / "churn.js"
        script.write_text(client_script(port, mode, iterations, track_request_finalizers))
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        expected = [count for count in range(1, iterations + 1)
                    if count % max(1, iterations // 10) == 0 or count == iterations]
        samples = []
        with (work / "agent.stderr").open("wb") as error_stream:
            process = subprocess.Popen([str(binary), str(script)], cwd=work, env=environment,
                                       stdout=subprocess.PIPE, stderr=error_stream, bufsize=0)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            pending = b""
            deadline = time.monotonic() + max(60, iterations * 0.8 + 5)
            try:
                while len(samples) < len(expected):
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"{mode}: 客户端未按时完成 {iterations} 次连接")
                    events = selector.select(timeout=1)
                    if not events:
                        if process.poll() is not None:
                            raise RuntimeError(f"{mode}: 代理提前退出：{process.returncode}")
                        continue
                    chunk = os.read(process.stdout.fileno(), 4096)
                    if not chunk:
                        error_text = (work / "agent.stderr").read_text(errors="replace")
                        raise RuntimeError(f"{mode}: 标准输出提前结束，状态 {process.poll()}，"
                                           f"服务端 {len(eof_count)}/{iterations}，错误 {errors}，"
                                           f"stderr={error_text[:12000]}")
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if not line.startswith(b"stage="):
                            if line:
                                error_text = (work / "agent.stderr").read_text(errors="replace")
                                raise RuntimeError(f"{mode}: 脚本失败：{line.decode(errors='replace')}，"
                                                   f"已接受 {len(accepted_count)}，EOF {len(eof_count)}，"
                                                   f"服务端错误 {errors}，stderr={error_text[-1000:]}")
                            continue
                        fields = line.split(b",")
                        count = int(fields[0].split(b"=", 1)[1])
                        if count != expected[len(samples)]:
                            raise RuntimeError(f"{mode}: 阶段编号异常：{count}")
                        memory = process_memory(process.pid)
                        if memory["pss_kib"] > PSS_LIMIT_KIB:
                            raise RuntimeError(f"{mode}: 超过测试进程内存预算")
                        sample = {"connections": count, **memory}
                        for field in fields[1:]:
                            if field.startswith(b"roots="):
                                sample["active_socket_roots"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"links="):
                                sample["chain_links"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"allocated="):
                                sample["allocated_kib"] = float(field.split(b"=", 1)[1])
                            elif field.startswith(b"timerRoots="):
                                sample["timer_roots"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"stashCount="):
                                sample["heap_stash_entries"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"stashNested="):
                                sample["heap_stash_nested_entries"] = field.split(b"=", 1)[1].decode()
                            elif field.startswith(b"finalizerCounts="):
                                sample["native_finalizer_counts"] = field.split(b"=", 1)[1].decode()
                            elif field.startswith(b"abortEvents="):
                                sample["abort_events"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"socketCloseEvents="):
                                sample["socket_close_events"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"socketEndEvents="):
                                sample["socket_end_events"] = int(field.split(b"=", 1)[1])
                            elif field.startswith(b"requestFinalizers="):
                                sample["request_finalizers"] = int(field.split(b"=", 1)[1])
                        samples.append(sample)
                process.wait(timeout=5)
                if process.returncode != 0:
                    raise RuntimeError(f"{mode}: 代理退出状态 {process.returncode}")
            finally:
                selector.close()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
        worker.join(timeout=6)
        if worker.is_alive() or errors or len(eof_count) != iterations:
            raise RuntimeError(f"{mode}: 服务端终止次数 {len(eof_count)}/{iterations}，错误 {errors}")
        stderr = (work / "agent.stderr").read_bytes()
        if b"ERROR: AddressSanitizer" in stderr or b"runtime error:" in stderr:
            raise RuntimeError(f"{mode}: 消毒器报告：{stderr[-300:].decode(errors='replace')}")
    if track_request_finalizers and (mode != "abort" or samples[-1].get("request_finalizers") != iterations):
        raise RuntimeError(f"{mode}: 请求终结次数与创建次数不符：{samples[-1]}")
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--mode", choices=("both", "close", "close-end", "close-wait", "close-rooted",
                                           "close-root-req", "close-root-socket", "abort"), default="both")
    args = parser.parse_args()
    if not 10 <= args.iterations <= 1000:
        parser.error("--iterations 必须介于 10 和 1000 之间")
    binary = candidate_binary(args.candidate.resolve(strict=True))
    modes = ("close", "abort") if args.mode == "both" else (args.mode,)
    for mode in modes:
        samples = run_mode(binary, mode, args.iterations)
        print(json.dumps({"mode": mode, "samples": samples,
                          "pss_growth_kib": samples[-1]["pss_kib"] - samples[0]["pss_kib"]},
                         ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""用直接事件转发和完整代理 HTTP 回环验证监听钩子的生命周期。"""

import argparse
import http.client
import json
import os
from pathlib import Path
import selectors
import shutil
import socket
import subprocess
import tempfile
import time

from websocket_connection_churn import candidate_binary, process_memory

ROOT = Path(__file__).resolve().parents[2]
HOOK = r'''
static duk_ret_t ScreenControl_Test_ForwardEx(duk_context *ctx)
{
	if (!duk_is_object(ctx, 0) || !duk_is_object(ctx, 1)) { return(0); }
	duk_push_boolean(ctx, ILibDuktape_EventEmitter_ForwardEventEx(ctx, 0, 1, "ping") == 0);
	return(1);
}
static duk_ret_t ScreenControl_Test_Pss(duk_context *ctx)
{
	FILE *stream = fopen("/proc/self/smaps_rollup", "r");
	char line[256];
	long pss = -1;
	if (stream != NULL)
	{
		while (fgets(line, sizeof(line), stream) != NULL)
		{
			if (sscanf(line, "Pss: %ld kB", &pss) == 1) { break; }
		}
		fclose(stream);
	}
	duk_push_int(ctx, (int)pss);
	return(1);
}
'''


def wait_ready(process, timeout):
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    pending = b""
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"代理在监听前退出：{process.returncode}")
            if not selector.select(1):
                continue
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                raise RuntimeError("代理标准输出提前结束")
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if line.strip() == b"ready":
                    return
                raise RuntimeError(f"代理输出异常：{line[:200]!r}")
        raise TimeoutError("本地 HTTP 服务未就绪")
    finally:
        selector.close()


def request(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"HTTP 状态异常：{response.status}")
        return body
    finally:
        connection.close()


def run_http(binary, iterations):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="screen-control-forward-lifetime-") as temporary:
        work = Path(temporary)
        script = work / "server.js"
        script.write_text(f"""var http=require('http');
var server=http.createServer(function(req,res){{
 if(req.url==='/sample'){{
  _debugGC();_debugGC();
  res.end(JSON.stringify({{newHooks:server.listenerCount('newListener'),
                           removeHooks:server.listenerCount('removeListener'),
                           activeSocketRoots:typeof __scNetRoots==='function'?__scNetRoots():null}}));
 }}else{{res.end('ok');}}
}});
server.listen({{port:{port},host:'127.0.0.1'}});
setTimeout(function(){{console.log('ready');}},200);
setTimeout(function(){{process.exit(0);}},120000);
""")
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        with (work / "agent.stderr").open("wb") as error_stream:
            process = subprocess.Popen([str(binary), str(script)], cwd=work, env=environment,
                                       stdout=subprocess.PIPE, stderr=error_stream, bufsize=0)
            try:
                wait_ready(process, 8)
                before = json.loads(request(port, "/sample"))
                for _ in range(iterations):
                    if request(port, "/probe") != b"ok":
                        raise RuntimeError("响应正文异常")
                after = json.loads(request(port, "/sample"))
                memory = process_memory(process.pid)
                print(json.dumps({"iterations": iterations, "before": before,
                                  "after": after, "memory": memory}, ensure_ascii=False))
                if after["newHooks"] > before["newHooks"] + 5 or \
                        after["removeHooks"] > before["removeHooks"] + 5:
                    raise RuntimeError("长驻服务对象的转发钩子持续累积")
                if after["activeSocketRoots"] is not None and after["activeSocketRoots"] > 1:
                    raise RuntimeError("已结束请求的服务端 socket 根引用未释放")
            except Exception as error:
                stderr = (work / "agent.stderr").read_text(errors="replace")
                raise RuntimeError(f"服务测试失败：{error}；代理状态 {process.poll()}；"
                                   f"stderr={stderr[:12000]}") from error
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
        stderr = (work / "agent.stderr").read_bytes()
        if b"ERROR: AddressSanitizer" in stderr or b"runtime error:" in stderr:
            raise RuntimeError(f"消毒器报告：{stderr[:1600].decode(errors='replace')}")


def build_direct_probe(candidate, destination):
    metadata = json.loads((candidate / "candidate.json").read_text())
    source = candidate / f"MeshAgent-{metadata['baselineCommit']}"
    shutil.copytree(source, destination)
    file = destination / "microscript/ILibDuktape_Polyfills.c"
    code = file.read_text()
    anchor = "void ILibDuktape_Polyfills_Init(duk_context *ctx)"
    registration = '\tILibDuktape_CreateInstanceMethod(ctx, "_debugGC", ILibDuktape_Polyfills_debugGC, 0);'
    if code.count(anchor) != 1 or code.count(registration) != 1:
        raise RuntimeError("测试钩子插入点已变化")
    code = code.replace(anchor, HOOK + "\n" + anchor)
    code = code.replace(registration, registration +
                        '\n\tILibDuktape_CreateInstanceMethod(ctx, "__scForward", ScreenControl_Test_ForwardEx, 2);' +
                        '\n\tILibDuktape_CreateInstanceMethod(ctx, "__scPss", ScreenControl_Test_Pss, 0);')
    file.write_text(code)
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    flags = f"-fsanitize=address,undefined -fno-omit-frame-pointer -no-pie -L. {library} -lpthread -lutil -lm"
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(destination.parent))
    environment["CPATH"] = str(destination / "lib-jpeg-turbo/includes") + os.pathsep + \
        environment.get("CPATH", "")
    with (destination.parent / "build.log").open("wb") as log:
        result = subprocess.run(["make", "linux", "ARCHID=6", "-j4", f"LDFLAGS={flags}",
                                 "CC=gcc -fsanitize=address,undefined -fno-omit-frame-pointer"],
                                cwd=destination, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                timeout=180)
    if result.returncode:
        tail = (destination.parent / "build.log").read_text(errors="replace")[-1500:]
        raise RuntimeError(f"测试钩子构建失败：{tail}")
    return destination / "DEBUG_meshagent_x86-64"


def run_direct(candidate, iterations, attach_listener=True, emit_close=True, gc_rounds=20):
    with tempfile.TemporaryDirectory(prefix="screen-control-forward-direct-") as temporary:
        work = Path(temporary)
        binary = build_direct_probe(candidate, work / "source")
        script = work / "probe.js"
        script.write_text(f"""var events=require('events'), target={{}}, finalized=0, count=0, created=0;
events.EventEmitter.call(target,true).createEvent('ping');
var baselineNew=target.listenerCount('newListener');
var baselineRemove=target.listenerCount('removeListener');
function createOne(){{
 var source={{}}, emitter=events.EventEmitter.call(source,true);
 emitter.createEvent('ping');emitter.createEvent('close');
 source.on('~',function(){{finalized++;}});
 if(!__scForward(source,target)){{console.log('forward-failed');process.exit(2);}}
 if({str(attach_listener).lower()}){{
  var listener=function(){{}};
  target.on('ping',listener);target.removeListener('ping',listener);
 }}
 if({str(emit_close).lower()})source.emit('close');
 created++;
}}
function batch(){{
 for(var i=0;i<100;i++)createOne();count+=100;
 function collect(remaining){{
  if(remaining>0){{_debugGC();setTimeout(function(){{collect(remaining-1);}},20);return;}}
  console.log('batch='+count+',new='+target.listenerCount('newListener')+
              ',remove='+target.listenerCount('removeListener')+
              ',ping='+target.listenerCount('ping')+
              ',finalized='+finalized+',pss='+__scPss());
  if(count==={iterations})process.exit(0);else batch();
 }}
 collect({gc_rounds});
}}
console.log('baseline='+baselineNew+','+baselineRemove);
batch();
""")
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        try:
            result = subprocess.run([str(binary), str(script)], cwd=work, env=environment,
                                    capture_output=True, text=True, timeout=max(30, iterations // 10))
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"隔离转发测试超时：stdout={(error.stdout or b'')[-1200:]!r}；"
                               f"stderr={(error.stderr or b'')[:1600]!r}") from error
        if result.returncode != 0 or "ERROR: AddressSanitizer" in result.stderr or "runtime error:" in result.stderr:
            raise RuntimeError(f"隔离转发测试失败：exit={result.returncode}；"
                               f"stdout={result.stdout[-1200:]}；stderr={result.stderr[:1600]}")
        lines = result.stdout.splitlines()
        if not lines or not lines[0].startswith("baseline="):
            raise RuntimeError(f"缺少基线计数：{lines[:3]}")
        initial = tuple(int(value) for value in lines[0].split("=", 1)[1].split(","))
        samples = []
        for line in lines[1:]:
            if not line.startswith("batch="):
                raise RuntimeError(f"脚本输出异常：{line}")
            values = dict(part.split("=", 1) for part in line.split(","))
            samples.append({key: int(value) for key, value in values.items()})
        if len(samples) != iterations // 100 or samples[-1]["batch"] != iterations:
            raise RuntimeError(f"批次数量异常：{samples}")
        if any(sample["new"] > initial[0] or sample["remove"] > initial[1] or
               sample["finalized"] > sample["batch"] or sample["pss"] > 256 * 1024
               for sample in samples):
            raise RuntimeError(f"源对象或目标钩子未回收：{samples}")
        if not emit_close and any(sample["finalized"] != sample["batch"] for sample in samples):
            raise RuntimeError(f"无 close 时源对象未全部终结：{samples}")
        print(json.dumps({"baseline": initial, "samples": samples}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--mode", choices=("direct", "http"), default="direct")
    parser.add_argument("--skip-listener", action="store_true")
    parser.add_argument("--skip-close", action="store_true")
    parser.add_argument("--gc-rounds", type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 1000 or (args.mode == "direct" and args.iterations % 100):
        parser.error("direct 模式需 100 的倍数，且次数必须介于 1 和 1000 之间")
    if not 1 <= args.gc_rounds <= 200:
        parser.error("--gc-rounds 必须介于 1 和 200 之间")
    candidate = args.candidate.resolve(strict=True)
    binary = candidate_binary(candidate)
    if args.mode == "direct":
        run_direct(candidate, args.iterations, not args.skip_listener, not args.skip_close, args.gc_rounds)
    else:
        run_http(binary, args.iterations)


if __name__ == "__main__":
    main()

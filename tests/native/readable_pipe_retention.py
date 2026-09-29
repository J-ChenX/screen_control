#!/usr/bin/env python3
"""用仅限隔离构建的 Duktape 计数钩子核对 pipe 节点引用的释放。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HOOK = r'''
extern duk_ret_t ILibDuktape_ReadableStream_PipeLockFinalizer(duk_context *ctx);
static duk_ret_t ScreenControl_Test_StashCount(duk_context *ctx)
{
	int count = 0;
	duk_dup(ctx, 0);
	ILibDuktape_Push_ObjectStash(ctx);
	duk_enum(ctx, -1, DUK_ENUM_OWN_PROPERTIES_ONLY | DUK_ENUM_INCLUDE_HIDDEN);
	while (duk_next(ctx, -1, 0)) { ++count; duk_pop(ctx); }
	duk_push_int(ctx, count);
	return(1);
}
static duk_ret_t ScreenControl_Test_FinalizeReadable(duk_context *ctx)
{
	duk_push_c_function(ctx, ILibDuktape_ReadableStream_PipeLockFinalizer, 0);
	duk_dup(ctx, 0);
	duk_call_method(ctx, 0);
	return(0);
}
'''
PROBES = {
    "repeat": r'''
var S=require('stream'),r=new S.Readable(),w=new S.Writable({write:function(x,f){f();}}),n=0,seen=[];
w.on('unpipe',function(){n++;setImmediate(function(){seen.push(__screenControlTestStashCount(w));if(n===10){console.log('stash='+seen.join(','));process.exit(0);}else tick();});});
function tick(){r.pipe(w);r.unpipe(w);}setTimeout(tick,20);
''',
    "specific": r'''
var S=require('stream'),r=new S.Readable(),a=new S.Writable({write:function(x,f){f();}}),b=new S.Writable({write:function(x,f){f();}}),c=new S.Writable({write:function(x,f){f();}});
r.pipe(a);r.pipe(b);r.pipe(c);b.on('unpipe',function(){setImmediate(function(){console.log('stash='+[a,b,c].map(__screenControlTestStashCount).join(','));process.exit(0);});});r.unpipe(b);
''',
    "all": r'''
var S=require('stream'),r=new S.Readable(),a=new S.Writable({write:function(x,f){f();}}),b=new S.Writable({write:function(x,f){f();}}),c=new S.Writable({write:function(x,f){f();}});
r.pipe(a);r.pipe(b);r.pipe(c);r.unpipe();setTimeout(function(){console.log('stash='+[a,b,c].map(__screenControlTestStashCount).join(','));process.exit(0);},50);
''',
    "finalizer": r'''
var S=require('stream'),r=new S.Readable(),w=new S.Writable({write:function(x,f){f();}});r.pipe(w);
setImmediate(function(){__screenControlTestFinalizeReadable(r);console.log('stash='+__screenControlTestStashCount(w));process.exit(0);});
''',
}
EXPECTED = {
    "legacy": {"repeat": tuple(range(1, 11)), "specific": (1, 1, 1),
               "all": (1, 1, 1), "finalizer": (1,)},
    "fixed": {"repeat": (0,) * 10, "specific": (1, 0, 1),
              "all": (0, 0, 0), "finalizer": (0,)},
}


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def instrument(candidate, destination):
    metadata = json.loads((candidate / "candidate.json").read_text())
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        raise RuntimeError(f"{candidate}: 需要已构建的 ASan/UBSan 隔离候选")
    source = candidate / f"MeshAgent-{metadata['baselineCommit']}"
    original = source / "DEBUG_meshagent_x86-64"
    if digest(original) != metadata["binarySha256"]:
        raise RuntimeError(f"{candidate}: 候选二进制摘要不符")
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    if digest(library) != metadata["librarySha256"]:
        raise RuntimeError("Rust 静态库摘要与候选不符")
    shutil.copytree(source, destination)
    polyfill = destination / "microscript/ILibDuktape_Polyfills.c"
    code = polyfill.read_text()
    anchor = "void ILibDuktape_Polyfills_Init(duk_context *ctx)"
    registration = '\tILibDuktape_CreateInstanceMethod(ctx, "_debugGC", ILibDuktape_Polyfills_debugGC, 0);'
    if code.count(anchor) != 1 or code.count(registration) != 1:
        raise RuntimeError("固定源码中的测试钩子位置已变化")
    code = code.replace(anchor, HOOK + "\n" + anchor)
    code = code.replace(registration, registration + '\n\tILibDuktape_CreateInstanceMethod(ctx, "__screenControlTestStashCount", ScreenControl_Test_StashCount, 1);' +
                        '\n\tILibDuktape_CreateInstanceMethod(ctx, "__screenControlTestFinalizeReadable", ScreenControl_Test_FinalizeReadable, 1);')
    polyfill.write_text(code)
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(destination))
    environment["CPATH"] = str(destination / "lib-jpeg-turbo/includes") + os.pathsep + environment.get("CPATH", "")
    flags = f"-fsanitize=address,undefined -fno-omit-frame-pointer -no-pie -L. {library} -lpthread -lutil -lm"
    command = ["make", "linux", "ARCHID=6", "-j4", f"LDFLAGS={flags}",
               "CC=gcc -fsanitize=address,undefined -fno-omit-frame-pointer"]
    log_path = destination.parent / (destination.name + "-build.log")
    with log_path.open("w") as log:
        built = subprocess.run(command, cwd=destination, env=environment, stdout=log,
                               stderr=subprocess.STDOUT, timeout=180)
    if built.returncode != 0:
        raise RuntimeError(f"测试钩子构建失败：{log_path}，末尾：{log_path.read_text()[-800:]}")
    return destination / "DEBUG_meshagent_x86-64"


def probe(binary, label, name, script_dir):
    script = script_dir / (label + "-" + name + ".js")
    script.write_text(PROBES[name])
    environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                       UBSAN_OPTIONS="halt_on_error=1")
    result = subprocess.run([str(binary), str(script)], cwd=script_dir, env=environment,
                            capture_output=True, text=True, timeout=8)
    match = re.search(r"stash=([0-9,]+)", result.stdout)
    if result.returncode != 0 or match is None:
        raise RuntimeError(f"{label}/{name}: exit={result.returncode}, stdout={result.stdout[-400:]}, stderr={result.stderr[-400:]}")
    actual = tuple(int(value) for value in match.group(1).split(","))
    if actual != EXPECTED[label][name]:
        raise RuntimeError(f"{label}/{name}: 缓存计数 {actual}，预期 {EXPECTED[label][name]}")
    print(f"{label}/{name}: {actual}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-candidate", type=Path, required=True)
    parser.add_argument("--fixed-candidate", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args()
    temporary = None
    if args.work_dir:
        work = args.work_dir.resolve()
        work.mkdir(parents=True, exist_ok=False)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="screen-control-pipe-stash-")
        work = Path(temporary.name)
    try:
        for label, candidate in (("legacy", args.legacy_candidate), ("fixed", args.fixed_candidate)):
            binary = instrument(candidate.resolve(strict=True), work / label)
            for name in PROBES:
                probe(binary, label, name, work)
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""在无代理身份的完整进程中核对计时器触发、取消和隐藏根引用。"""

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
static duk_ret_t ScreenControl_Test_TimerRoots(duk_context *ctx)
{
	int count = 0;
	duk_push_heap_stash(ctx);
	duk_enum(ctx, -1, DUK_ENUM_OWN_PROPERTIES_ONLY | DUK_ENUM_INCLUDE_HIDDEN);
	while (duk_next(ctx, -1, 1))
	{
		if (duk_is_object(ctx, -1) && duk_has_prop_string(ctx, -1, ILibDuktape_Timer_Ptrs)) { ++count; }
		duk_pop_2(ctx);
	}
	duk_push_int(ctx, count);
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
NESTED_LEGACY = "setTimeout(function(){console.log('first');setTimeout(function(){console.log('second');process.exit(0);},30);},30);\n"
NESTED_HELD = "var first,second;first=setTimeout(function(){console.log('first');second=setTimeout(function(){console.log('second');process.exit(0);},30);},30);\n"
PROBES = {
    "nested": (r'''
console.log('roots-initial='+__screenControlTestTimerRoots());
setTimeout(function(){console.log('first');console.log('roots-first='+__screenControlTestTimerRoots());
setTimeout(function(){console.log('roots-inner='+__screenControlTestTimerRoots());console.log('second');process.exit(0);},30);
console.log('roots-second-scheduled='+__screenControlTestTimerRoots());},30);
console.log('roots-first-scheduled='+__screenControlTestTimerRoots());
''', {"roots-initial": 0, "roots-first-scheduled": 1, "roots-first": 0,
      "roots-second-scheduled": 1, "roots-inner": 0}),
    "clear": (r'''
console.log('roots-initial='+__screenControlTestTimerRoots());
var t=setTimeout(function(){console.log('unexpected');process.exit(3);},1000);
console.log('roots-scheduled='+__screenControlTestTimerRoots());clearTimeout(t);
console.log('roots-cleared='+__screenControlTestTimerRoots());
setImmediate(function(){console.log('roots-after-immediate='+__screenControlTestTimerRoots());process.exit(0);});
''', {"roots-initial": 0, "roots-scheduled": 1, "roots-cleared": 0,
      "roots-after-immediate": 1}),
    "invalid": (r'''
var caught=0;try{setTimeout(function(){},'bad');}catch(e){caught++;}
console.log('roots-bad-delay='+__screenControlTestTimerRoots());
try{setTimeout(null,10);}catch(e){caught++;}
console.log('roots-bad-callback='+__screenControlTestTimerRoots());
console.log('caught='+caught);process.exit(0);
''', {"roots-bad-delay": 0, "roots-bad-callback": 0, "caught": 2}),
    "interval": (r'''
var n=0,h=setInterval(function(){n++;if(n===3){clearInterval(h);
console.log('roots-cleared='+__screenControlTestTimerRoots());
setTimeout(function(){console.log('ticks='+n);console.log('roots-after='+__screenControlTestTimerRoots());process.exit(0);},40);}},10);
console.log('roots-scheduled='+__screenControlTestTimerRoots());
''', {"roots-scheduled": 1, "roots-cleared": 0, "ticks": 3, "roots-after": 0}),
    "immediate": (r'''
var runs=0,peak=0;function tick(){runs++;var current=__screenControlTestTimerRoots();if(current>peak)peak=current;
if(runs===5){console.log('roots-fired='+current);console.log('peak='+peak);console.log('runs='+runs);process.exit(0);}else setImmediate(tick);}
setImmediate(tick);
console.log('roots-scheduled='+__screenControlTestTimerRoots());
''', {"roots-scheduled": 1, "roots-fired": 0, "peak": 1, "runs": 5}),
}
CHURN = r'''
var cancelled=0,fired=0,next;
function sample(kind,n) {
 var before=__screenControlTestTimerRoots(),pss=__screenControlTestPss();
 if(before!==0||pss<=0||pss>262144){console.log('invalid='+before+','+pss);process.exit(4);}
 _debugGC();
 var after=__screenControlTestTimerRoots();
 if(after>1){console.log('invalid-after-gc='+after);process.exit(4);}
 console.log(kind+'='+n+',roots-before='+before+',roots-after-gc='+after+',pss='+__screenControlTestPss());
}
function cancelBatch() {
 for(var i=0;i<1000;i++){
  var h=setTimeout(function(){console.log('unexpected');process.exit(3);},60000);
  clearTimeout(h);
 }
 cancelled+=1000;sample('cancel',cancelled);
 next=setTimeout(cancelled<10000?cancelBatch:fireBatch,10);
}
function fireBatch() {
 var pending=1000;
 for(var i=0;i<1000;i++){
  setTimeout(function(){if(--pending===0){
   fired+=1000;sample('fire',fired);
   next=setTimeout(fired<10000?fireBatch:function(){process.exit(0);},10);
  }},0);
 }
 if(__screenControlTestTimerRoots()!==1000){console.log('scheduled-roots='+__screenControlTestTimerRoots());process.exit(5);}
}
next=setTimeout(cancelBatch,10);
'''


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def candidate_source(path):
    meta = json.loads((path / "candidate.json").read_text())
    if meta.get("status") != "built-not-deployed" or "address,undefined" not in meta.get("sanitizers", ""):
        raise RuntimeError(f"{path}: 需要已构建的 ASan/UBSan 隔离候选")
    source = path / f"MeshAgent-{meta['baselineCommit']}"
    binary = source / "DEBUG_meshagent_x86-64"
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    if digest(binary) != meta["binarySha256"] or digest(library) != meta["librarySha256"]:
        raise RuntimeError(f"{path}: 候选与 Rust 静态库摘要不符")
    return source, binary, library


def run_script(binary, script, work, timeout):
    environment = dict(os.environ,
                       ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                       UBSAN_OPTIONS="halt_on_error=1")
    return subprocess.run([str(binary), str(script)], cwd=work, env=environment,
                          capture_output=True, text=True, timeout=timeout)


def build_instrumented(source, destination, library):
    shutil.copytree(source, destination)
    file = destination / "microscript/ILibDuktape_Polyfills.c"
    code = file.read_text()
    anchor = "void ILibDuktape_Polyfills_Init(duk_context *ctx)"
    registration = '\tILibDuktape_CreateInstanceMethod(ctx, "_debugGC", ILibDuktape_Polyfills_debugGC, 0);'
    if code.count(anchor) != 1 or code.count(registration) != 1:
        raise RuntimeError("固定源码中的测试钩子位置已变化")
    code = code.replace(anchor, HOOK + "\n" + anchor)
    code = code.replace(registration, registration + '\n\tILibDuktape_CreateInstanceMethod(ctx, "__screenControlTestTimerRoots", ScreenControl_Test_TimerRoots, 0);' +
                        '\n\tILibDuktape_CreateInstanceMethod(ctx, "__screenControlTestPss", ScreenControl_Test_Pss, 0);')
    file.write_text(code)
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(destination))
    environment["CPATH"] = str(destination / "lib-jpeg-turbo/includes") + os.pathsep + environment.get("CPATH", "")
    flags = f"-fsanitize=address,undefined -fno-omit-frame-pointer -no-pie -L. {library} -lpthread -lutil -lm"
    command = ["make", "linux", "ARCHID=6", "-j4", f"LDFLAGS={flags}",
               "CC=gcc -fsanitize=address,undefined -fno-omit-frame-pointer"]
    log_path = destination.parent / "timer-hook-build.log"
    with log_path.open("w") as log:
        result = subprocess.run(command, cwd=destination, env=environment,
                                stdout=log, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"测试钩子构建失败：{log_path}，末尾：{log_path.read_text()[-800:]}")
    return destination / "DEBUG_meshagent_x86-64"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-candidate", type=Path)
    parser.add_argument("--fixed-candidate", type=Path)
    parser.add_argument("--binary", type=Path, help="仅验证已构建候选的完整进程计时器行为")
    parser.add_argument("--work-dir", type=Path)
    args = parser.parse_args()
    temporary = None
    if args.work_dir:
        work = args.work_dir.resolve()
        work.mkdir(parents=True, exist_ok=False)
    else:
        temporary = tempfile.TemporaryDirectory(prefix="screen-control-timer-")
        work = Path(temporary.name)
    try:
        if args.binary:
            binary = args.binary.resolve(strict=True)
            script = work / "nested.js"
            script.write_text(NESTED_LEGACY)
            result = run_script(binary, script, work, 3)
            if result.returncode != 0 or "first\nsecond\n" not in result.stdout:
                raise RuntimeError(f"候选嵌套计时器失败：exit={result.returncode}, stdout={result.stdout[-300:]}, stderr={result.stderr[-300:]}")
            print("candidate/nested: 两层未保存句柄的计时器均触发")
            return
        if args.legacy_candidate is None or args.fixed_candidate is None:
            parser.error("需要 --binary，或同时指定 --legacy-candidate 与 --fixed-candidate")
        _, legacy, _ = candidate_source(args.legacy_candidate.resolve(strict=True))
        source, _, library = candidate_source(args.fixed_candidate.resolve(strict=True))
        script = work / "nested-legacy.js"
        script.write_text(NESTED_LEGACY)
        try:
            old = run_script(legacy, script, work, 2)
        except subprocess.TimeoutExpired as error:
            old_output = error.stdout or b""
            if isinstance(old_output, bytes):
                old_output = old_output.decode(errors="replace")
            if "first" not in old_output or "second" in old_output:
                raise RuntimeError(f"旧候选复现不符：{old_output[-300:]}") from error
            print("legacy/nested: 首层触发，内层计时器未触发")
        else:
            raise RuntimeError(f"旧候选未复现失效：exit={old.returncode}, stdout={old.stdout[-300:]}")
        script.write_text(NESTED_HELD)
        held = run_script(legacy, script, work, 2)
        if held.returncode != 0 or "first\nsecond\n" not in held.stdout:
            raise RuntimeError(f"旧候选保存句柄的对照失败：exit={held.returncode}, stdout={held.stdout[-300:]}")
        print("legacy/held: 保存两个句柄后两层均触发")

        fixed = build_instrumented(source, work / "fixed", library)
        for name, (code, expected) in PROBES.items():
            script = work / (name + ".js")
            script.write_text(code)
            result = run_script(fixed, script, work, 5)
            if result.returncode != 0:
                raise RuntimeError(f"{name}: exit={result.returncode}, stdout={result.stdout[-400:]}, stderr={result.stderr[-400:]}")
            actual = {key: int(value) for key, value in re.findall(r"([a-z-]+)=(\d+)", result.stdout)}
            if actual != expected or "unexpected" in result.stdout:
                raise RuntimeError(f"{name}: 实际 {actual}，预期 {expected}，stdout={result.stdout[-400:]}")
            print(f"fixed/{name}: {actual}")
        script = work / "churn.js"
        script.write_text(CHURN)
        result = run_script(fixed, script, work, 60)
        if result.returncode != 0 or "invalid=" in result.stdout or "unexpected" in result.stdout:
            raise RuntimeError(f"churn: exit={result.returncode}, stdout={result.stdout[-600:]}, stderr={result.stderr[-600:]}")
        samples = [(kind, int(count), int(before), int(after), int(pss))
                   for kind, count, before, after, pss in
                   re.findall(r"(cancel|fire)=(\d+),roots-before=(\d+),roots-after-gc=(\d+),pss=(\d+)",
                              result.stdout)]
        expected_stages = [(kind, count) for kind in ("cancel", "fire")
                           for count in range(1000, 10001, 1000)]
        if [(kind, count) for kind, count, _, _, _ in samples] != expected_stages or \
                any(before != 0 or after > 1 or pss <= 0 or pss > 262144
                    for _, _, before, after, pss in samples):
            raise RuntimeError(f"churn: 根引用或内存采样异常：{samples}")
        print("fixed/churn: " + json.dumps({
            "cancel_pss_kib": [pss for kind, _, _, _, pss in samples if kind == "cancel"],
            "fire_pss_kib": [pss for kind, _, _, _, pss in samples if kind == "fire"],
            "roots_before_gc": [before for _, _, before, _, _ in samples],
            "roots_after_gc": [after for _, _, _, after, _ in samples],
        }))
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    main()

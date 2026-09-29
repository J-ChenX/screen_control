#!/usr/bin/env python3
"""验证普通、密封和冻结对象的 Duktape 终结事件均恰好执行一次。"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from websocket_connection_churn import process_memory


SCRIPT = r"""
var events=require('events'), counts={plain:0,sealed:0,frozen:0};
function create(kind){
 var object={};
 events.EventEmitter.call(object,true);
 object.on('~',function(){counts[kind]++;});
 if(kind==='sealed')Object.seal(object);
 if(kind==='frozen')Object.freeze(object);
}
for(var n=0;n<__COUNT__;n++){
 create('plain');create('sealed');create('frozen');
}
function collect(remaining){
 if(remaining===0){console.log('counts='+JSON.stringify(counts));process.exit(0);}
 _debugGC();setTimeout(function(){collect(remaining-1);},20);
}
collect(__GC_ROUNDS__);
"""

CHURN_SCRIPT = r"""
var events=require('events'), batch=0, finalized=0;
function create(){
 var object={};
 events.EventEmitter.call(object,true);
 object.on('~',function(){finalized++;});
 Object.freeze(object);
}
function next(){
 for(var n=0;n<100;n++)create();
 batch++;
 function collect(remaining){
  if(remaining===0){
   console.log('churn='+JSON.stringify({created:batch*100,finalized:finalized}));
   if(batch<10)setTimeout(next,1);
   else setTimeout(function(){process.exit(0);},300);
  }else{_debugGC();setTimeout(function(){collect(remaining-1);},20);}
 }
 collect(30);
}
next();
"""


def run(binary: Path, count: int, gc_rounds: int, expect_frozen_regression: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="screen-control-finalizer-freeze-") as temporary:
        script = Path(temporary) / "finalizer-freeze.js"
        script.write_text(SCRIPT.replace("__COUNT__", str(count))
                          .replace("__GC_ROUNDS__", str(gc_rounds)))
        environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=0:halt_on_error=1",
                           UBSAN_OPTIONS="halt_on_error=1")
        process = subprocess.run([str(binary), str(script)], cwd=temporary, env=environment,
                                 capture_output=True, text=True, timeout=max(20, gc_rounds * 0.4))
        if process.returncode != 0 or "ERROR: AddressSanitizer" in process.stderr or \
                "runtime error:" in process.stderr:
            raise RuntimeError(f"终结测试进程失败：exit={process.returncode}，"
                               f"stdout={process.stdout[-300:]}，stderr={process.stderr[-1200:]}")
        lines = [line for line in process.stdout.splitlines() if line.startswith("counts=")]
        if len(lines) != 1:
            raise RuntimeError(f"终结计数缺失：{process.stdout[-500:]}")
        counts = json.loads(lines[0].split("=", 1)[1])
        if expect_frozen_regression:
            if counts["frozen"] >= count and counts["sealed"] >= count:
                raise RuntimeError(f"旧补丁未复现冻结对象清理缺失：{counts}")
            print(f"旧补丁已复现冻结或密封对象清理缺失：{counts}")
        elif counts != {"plain": count, "sealed": count, "frozen": count}:
            raise RuntimeError(f"终结次数异常：{counts}，每类预期 {count}")
        else:
            print(f"三类对象各 {count} 个均终结一次，无 ASan/UBSan 报告")


def run_churn(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="screen-control-finalizer-churn-") as temporary:
        script = Path(temporary) / "finalizer-churn.js"
        script.write_text(CHURN_SCRIPT)
        environment = dict(os.environ,
                           ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
                           UBSAN_OPTIONS="halt_on_error=1")
        with (Path(temporary) / "stderr").open("w+") as stderr:
            process = subprocess.Popen([str(binary), str(script)], cwd=temporary,
                                       env=environment, stdout=subprocess.PIPE,
                                       stderr=stderr, text=True)
            samples = []
            try:
                for line in process.stdout:
                    if not line.startswith("churn="):
                        continue
                    record = json.loads(line.split("=", 1)[1])
                    memory = process_memory(process.pid)["anonymous_kib"]
                    samples.append((record, memory))
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            stderr.seek(0)
            errors = stderr.read()
            if process.returncode != 0 or "ERROR: AddressSanitizer" in errors or \
                    "runtime error:" in errors:
                raise RuntimeError(f"冻结对象压力测试失败：exit={process.returncode}，"
                                   f"stderr={errors[-1200:]}")
            if len(samples) != 10 or any(record["created"] != (index + 1) * 100 or
                                         record["finalized"] != record["created"]
                                         for index, (record, _) in enumerate(samples)):
                raise RuntimeError(f"冻结对象终结次数异常：{samples}")
            late_growth = samples[-1][1] - samples[2][1]
            if late_growth > 4096:
                raise RuntimeError(f"关闭 ASan 隔离区后，冻结对象后段匿名内存增长 {late_growth} KiB：{samples}")
            print(f"1,000 个冻结对象均终结一次；后段匿名内存变化 {late_growth} KiB，"
                  "无 ASan/UBSan 报告")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--gc-rounds", type=int, default=60)
    parser.add_argument("--expect-frozen-regression", action="store_true")
    parser.add_argument("--churn", action="store_true", help="检查 1,000 个冻结对象的回收趋势")
    args = parser.parse_args()
    if not 1 <= args.count <= 100 or not 1 <= args.gc_rounds <= 300:
        parser.error("对象数必须介于 1 和 100、GC 轮数必须介于 1 和 300")
    binary = args.binary.resolve(strict=True)
    if args.churn:
        run_churn(binary)
    else:
        run(binary, args.count, args.gc_rounds, args.expect_frozen_regression)


if __name__ == "__main__":
    main()

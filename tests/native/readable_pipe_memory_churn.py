#!/usr/bin/env python3
"""在无代理身份的完整进程中对照可读流缓存清理前后的驻留内存。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
BATCH_SIZE = 1000
BATCHES = 10
PSS_LIMIT_KIB = 256 * 1024
SCRIPT = r"""
var Stream = require('stream');
var readable = new Stream.Readable();
var writable = new Stream.Writable({write:function(data,done){done();}});
var count = 0, handle;
function step() {
    for (var i = 0; i < 1000; i++) { readable.pipe(writable); readable.unpipe(writable); }
    count += 1000;
    _debugGC();
    console.log('stage=' + count);
    if (count < 10000) { handle = setTimeout(step, 20); }
    else { handle = setTimeout(function(){process.exit(0);}, 500); }
}
handle = setTimeout(step, 20);
"""


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def candidate(path):
    metadata = json.loads((path / "candidate.json").read_text())
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        raise RuntimeError(f"{path}: 仅接受未部署的 ASan/UBSan 候选")
    binary = path / f"MeshAgent-{metadata['baselineCommit']}" / "DEBUG_meshagent_x86-64"
    if sha256(binary) != metadata.get("binarySha256"):
        raise RuntimeError(f"{path}: 候选二进制摘要不一致")
    if sha256(path / "source.tar.gz") != metadata.get("archiveSha256"):
        raise RuntimeError(f"{path}: 固定源码摘要不一致")
    return metadata, binary


def process_memory(pid):
    rollup = Path(f"/proc/{pid}/smaps_rollup").read_text()
    values = {}
    for line in rollup.splitlines():
        if line.startswith("Pss:"):
            values["pss_kib"] = int(line.split()[1])
        elif line.startswith("Anonymous:"):
            values["anonymous_kib"] = int(line.split()[1])
    if set(values) != {"pss_kib", "anonymous_kib"}:
        raise RuntimeError("无法读取进程内存采样字段")
    return values


def run_churn(binary, script, work, label):
    environment = dict(
        os.environ,
        ASAN_OPTIONS="detect_leaks=0:halt_on_error=1:quarantine_size_mb=0:thread_local_quarantine_size_kb=0",
        UBSAN_OPTIONS="halt_on_error=1",
    )
    samples = []
    with (work / f"{label}.stderr").open("wb") as error_stream:
        process = subprocess.Popen([str(binary), str(script)], cwd=work, env=environment,
                                   stdout=subprocess.PIPE, stderr=error_stream, bufsize=0)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        pending = b""
        deadline = time.monotonic() + 60
        try:
            while len(samples) < BATCHES:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"{label}: 进程未按时报告 {BATCHES} 批")
                events = selector.select(timeout=1)
                if not events:
                    if process.poll() is not None:
                        raise RuntimeError(f"{label}: 进程提前退出，状态 {process.returncode}")
                    continue
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk:
                    raise RuntimeError(f"{label}: 标准输出提前结束")
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line.startswith(b"stage="):
                        continue
                    stage = int(line.split(b"=", 1)[1])
                    if stage != (len(samples) + 1) * BATCH_SIZE:
                        raise RuntimeError(f"{label}: 批次编号异常：{stage}")
                    memory = process_memory(process.pid)
                    if memory["pss_kib"] > PSS_LIMIT_KIB:
                        raise RuntimeError(f"{label}: 超过隔离内存预算")
                    samples.append({"operations": stage, **memory})
            process.wait(timeout=5)
            if process.returncode != 0:
                raise RuntimeError(f"{label}: 进程退出状态 {process.returncode}")
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
    stderr = (work / f"{label}.stderr").read_bytes()
    if b"ERROR: AddressSanitizer" in stderr or b"runtime error:" in stderr:
        raise RuntimeError(f"{label}: 消毒器报告错误：{stderr[-300:].decode(errors='replace')}")
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-candidate", type=Path, required=True)
    parser.add_argument("--fixed-candidate", type=Path, required=True)
    parser.add_argument("--current-candidate", type=Path, required=True)
    args = parser.parse_args()
    old_meta, old_binary = candidate(args.legacy_candidate.resolve(strict=True))
    new_meta, new_binary = candidate(args.fixed_candidate.resolve(strict=True))
    current_meta, current_binary = candidate(args.current_candidate.resolve(strict=True))
    expected_patch = sha256(ROOT / "deploy/g0/meshagent/rust-native/readable-stream-stash.patch")
    expected_timer = sha256(ROOT / "deploy/g0/meshagent/rust-native/timer-lifetime.patch")
    if old_meta.get("readablePipeStashPatchSha256") is not None or \
            new_meta.get("readablePipeStashPatchSha256") != expected_patch:
        raise RuntimeError("候选未构成缓存清理前后的对照")
    excluded = {"binarySha256", "readablePipeStashPatchSha256"}
    if {key: value for key, value in old_meta.items() if key not in excluded} != \
            {key: value for key, value in new_meta.items() if key not in excluded}:
        raise RuntimeError("两个候选存在缓存清理以外的构建差异")
    if current_meta.get("timerPatchSha256") != expected_timer:
        raise RuntimeError("当前候选未包含固定的计时器补丁")
    current_excluded = {"binarySha256", "timerPatchSha256", "timerHarness"}
    if {key: value for key, value in current_meta.items() if key not in current_excluded} != \
            {key: value for key, value in new_meta.items() if key not in current_excluded}:
        raise RuntimeError("当前候选还存在计时器补丁以外的构建差异")
    with tempfile.TemporaryDirectory(prefix="screen-control-pipe-memory-") as temporary:
        work = Path(temporary)
        script = work / "churn.js"
        script.write_text(SCRIPT)
        old = run_churn(old_binary, script, work, "legacy")
        fixed = run_churn(new_binary, script, work, "fixed")
        current = run_churn(current_binary, script, work, "current")
    old_growth = old[-1]["pss_kib"] - old[0]["pss_kib"]
    fixed_growth = fixed[-1]["pss_kib"] - fixed[0]["pss_kib"]
    current_growth = current[-1]["pss_kib"] - current[0]["pss_kib"]
    output = {"operations": BATCHES * BATCH_SIZE, "legacy": old, "fixed": fixed,
              "current": current, "legacy_pss_growth_kib": old_growth,
              "fixed_pss_growth_kib": fixed_growth, "current_pss_growth_kib": current_growth}
    print(json.dumps(output, ensure_ascii=False))
    if old_growth < 4096 or fixed_growth > 2048 or current_growth > 2048 or \
            fixed_growth * 2 >= old_growth or current_growth * 2 >= old_growth:
        raise RuntimeError("修复前后的内存增长未形成预期对照")


if __name__ == "__main__":
    main()

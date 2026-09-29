#!/usr/bin/env python3
"""在隔离目录测量普通用户文件进程处理不同载荷时的峰值 RSS。"""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


def measure(binary: Path, size_mib: int, root: Path) -> dict:
    directory = root / f"screen-control-perf-local-{size_mib}"
    directory.mkdir(mode=0o700)
    peak = root / f"peak-{size_mib}.txt"
    wrapper = root / f"timed-worker-{size_mib}"
    wrapper.write_text(
        "#!/bin/sh\nexec /usr/bin/time -f %M -o "
        + shlex.quote(str(peak)) + " " + shlex.quote(str(binary)) + "\n"
    )
    wrapper.chmod(0o700)
    env = dict(
        os.environ,
        SCREEN_CONTROL_PERF_BINARY=str(wrapper),
        SCREEN_CONTROL_PERF_DIRECTORY=str(directory),
        SCREEN_CONTROL_PERF_BYTES=str(size_mib * 1024 * 1024),
    )
    result = subprocess.run(
        ["mise", "exec", "--", "node", "tests/performance/file-worker-live.mjs", "echova", "local", f"perf-local-{size_mib}"],
        env=env, capture_output=True, text=True, timeout=180, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"{size_mib} MiB 文件检查失败：{result.stderr[:500]}")
    data = json.loads(result.stdout)
    for key in ("sha256OK", "failedOverwritePreservedSHA256", "emptyFile", "temporaryUploadCleaned"):
        if data.get(key) is not True:
            raise RuntimeError(f"{size_mib} MiB 文件检查缺少 {key}")
    data["workerPeakRSSKiB"] = int(peak.read_text().strip())
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if not os.access(binary, os.X_OK):
        parser.error("文件进程不可执行")
    with tempfile.TemporaryDirectory(prefix="screen-control-perf-") as temporary:
        root = Path(temporary)
        results = [measure(binary, size, root) for size in (8, 128)]
    print(json.dumps({"results": results, "peakRSSGrowthKiB": results[1]["workerPeakRSSKiB"] - results[0]["workerPeakRSSKiB"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

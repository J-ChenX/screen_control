#!/usr/bin/env python3
"""在固定 Linux 候选中编译实际光标识别函数并检查异常 XFixes 输入。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--xfixes-include", type=Path)
    args = parser.parse_args()
    candidate = args.candidate.resolve(strict=True)
    metadata = json.loads((candidate / "candidate.json").read_text())
    commit = metadata.get("baselineCommit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        parser.error("候选固定源码提交无效")
    source = candidate / f"MeshAgent-{commit}"
    binary = source / "DEBUG_meshagent_x86-64"
    patch = ROOT / "deploy/g0/meshagent/rust-native/linux-ximage-rust.patch"
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        parser.error("只接受已构建、未部署且启用 ASan/UBSan 的候选")
    if (metadata.get("ximagePatchSha256") != sha256(patch)
            or metadata.get("binarySha256") != sha256(binary)
            or metadata.get("archiveSha256") != sha256(candidate / "source.tar.gz")):
        parser.error("当前补丁、代理或固定源码与候选摘要不一致")
    includes = ["-I.", "-Imeshcore", "-Imicrostack"]
    if args.xfixes_include:
        include = args.xfixes_include.resolve(strict=True)
        if not (include / "X11/extensions/Xfixes.h").is_file():
            parser.error("指定目录没有 XFixes 开发头文件")
        includes.append("-I" + str(include))
    with tempfile.TemporaryDirectory(prefix="screen-control-cursor-classification-") as temporary:
        obj = Path(temporary) / "linux_kvm.o"
        output = Path(temporary) / "cursor-classification"
        flags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
        subprocess.run([
            "mise", "exec", "--", "cc", "-std=gnu99", "-D_POSIX", "-DJPEGMAXBUF=0",
            "-ffunction-sections", "-fdata-sections", *flags, *includes,
            "-c", "meshcore/KVM/Linux/linux_kvm.c", "-o", str(obj),
        ], cwd=source, check=True)
        subprocess.run([
            "mise", "exec", "--", "cc", "-std=gnu99", "-Wall", "-Wextra", "-Werror",
            *flags, "-no-pie", "-Wl,--gc-sections",
            *includes, str(ROOT / "tests/native/cursor_classification.c"), str(obj),
            "-ldl", "-lpthread", "-lm", "-o", str(output),
        ], cwd=source, check=True)
        environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=1:halt_on_error=1", UBSAN_OPTIONS="halt_on_error=1")
        subprocess.run([str(output)], cwd=candidate, env=environment, check=True)
    print("固定候选实际光标识别函数：空值、有效像素、大尺寸和缺失像素通过 ASan/UBSan")


if __name__ == "__main__":
    main()

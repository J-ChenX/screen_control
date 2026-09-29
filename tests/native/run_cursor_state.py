#!/usr/bin/env python3
"""提取固定候选主循环的实际光标分支，检查显隐转换与异常恢复。"""

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
    kvm = (source / "meshcore/KVM/Linux/linux_kvm.c").read_text()
    begin = "\t\t\trs = x11_exports->XQueryPointer(imagedisplay,"
    end = "\t\t\tfor (y = 0; y < TILE_HEIGHT_COUNT; y++) {"
    if kvm.count(begin) != 1:
        parser.error("无法唯一定位主循环光标分支")
    start = kvm.index(begin)
    finish = kvm.index(end, start)
    branch = kvm[start:finish]
    if "else if (sentHideCursor != 0)" not in branch or "remoteMouseX != rx || remoteMouseY != ry" not in branch:
        parser.error("候选主循环缺少单轴比较或异常恢复")
    template = (ROOT / "tests/native/cursor_state.c.in").read_text()
    includes = ["-I" + str(ROOT / "native/protocol-ffi/include")]
    if args.xfixes_include:
        include = args.xfixes_include.resolve(strict=True)
        if not (include / "X11/extensions/Xfixes.h").is_file():
            parser.error("指定目录没有 XFixes 开发头文件")
        includes.append("-I" + str(include))
    with tempfile.TemporaryDirectory(prefix="screen-control-cursor-state-") as temporary:
        code = Path(temporary) / "cursor_state.c"
        output = Path(temporary) / "cursor-state"
        code.write_text(template.replace("/* CURSOR_IMPLEMENTATION */", branch))
        subprocess.run([
            "mise", "exec", "--", "cc", "-std=gnu99", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-no-pie",
            *includes, str(code), "-o", str(output),
        ], cwd=ROOT, check=True)
        environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=1:halt_on_error=1", UBSAN_OPTIONS="halt_on_error=1")
        subprocess.run([str(output)], cwd=candidate, env=environment, check=True)
    print("固定候选主循环光标分支：单轴移动、查询失败、显示连接缺失、空图像及叠加失败的显隐转换通过")


if __name__ == "__main__":
    main()

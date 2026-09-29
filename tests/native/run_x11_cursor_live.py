#!/usr/bin/env python3
"""把真实 XFixes 光标送入固定候选的 Rust C ABI，并用消毒器检查。"""

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
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    header = ROOT / "native/protocol-ffi/include/screen_control_protocol.h"
    binary = candidate / f"MeshAgent-{commit}" / "DEBUG_meshagent_x86-64"
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        parser.error("只接受已构建、未部署且启用 ASan/UBSan 的候选")
    if (metadata.get("librarySha256") != sha256(library)
            or metadata.get("headerSha256") != sha256(header)
            or metadata.get("binarySha256") != sha256(binary)
            or metadata.get("archiveSha256") != sha256(candidate / "source.tar.gz")):
        parser.error("当前 Rust 库、C 头文件、代理或固定源码与候选摘要不一致")
    includes = ["-I" + str(header.parent)]
    if args.xfixes_include:
        include = args.xfixes_include.resolve(strict=True)
        if not (include / "X11/extensions/Xfixes.h").is_file():
            parser.error("指定目录没有 XFixes 开发头文件")
        includes.append("-I" + str(include))
    with tempfile.TemporaryDirectory(prefix="screen-control-cursor-live-") as temporary:
        output = Path(temporary) / "x11-cursor-live"
        subprocess.run([
            "mise", "exec", "--", "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-no-pie",
            *includes, str(ROOT / "tests/native/x11_cursor_live.c"), str(library),
            "-l:libXfixes.so.3", "-l:libX11.so.6", "-ldl", "-lpthread", "-lm", "-o", str(output),
        ], cwd=ROOT, check=True)
        environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=1:halt_on_error=1", UBSAN_OPTIONS="halt_on_error=1")
        subprocess.run([str(output)], cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()

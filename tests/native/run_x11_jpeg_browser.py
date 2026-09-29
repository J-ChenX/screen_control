#!/usr/bin/env python3
"""从隔离的 ASan 候选采集一帧，经内存管道交给 Chromium 解码。"""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    metadata = json.loads((candidate / "candidate.json").read_text())
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        raise SystemExit("仅接受已构建、未部署的 ASan/UBSan Linux 候选")
    source = candidate / f"MeshAgent-{metadata['baselineCommit']}"
    jpeg = source / "lib-jpeg-turbo/linux/x86-64/libturbojpeg.a"
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    output = candidate / "x11-jpeg-browser"
    environment = os.environ.copy()
    environment["CPATH"] = str(source / "lib-jpeg-turbo/includes") + os.pathsep + environment.get("CPATH", "")
    subprocess.run([
        "cc", "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-no-pie", "-Wl,--gc-sections", "-I.",
        str(ROOT / "tests/native/x11_jpeg_live.c"), str(candidate / "tile-integration.o"),
        str(candidate / "jpeg-compression.o"), str(library), str(jpeg),
        "-l:libXext.so.6", "-l:libX11.so.6", "-ldl", "-lpthread", "-lm", "-o", str(output),
    ], cwd=source, env=environment, check=True)
    for mode in ("top-left", "center", "bottom-right"):
        subprocess.run(["mise", "exec", "--", "node", str(ROOT / "tests/native/x11_jpeg_browser.mjs"), str(output), mode],
                       cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()

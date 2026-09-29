#!/usr/bin/env python3
"""在隔离回调环境检查实际 C 接收与析构函数，不连接任何代理。"""
import argparse
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    args = parser.parse_args()
    source = (args.source / "microstack/ILibWebClient.c").read_text()
    start = source.index("int ILibWebClient_ProcessWebSocketData(")
    end = source.index("void ILibWebClient_OnWebSocketData(", start)
    body = source[start:end]
    start = source.index("void ILibWebClient_DestroyWebRequest(")
    end = source.index("// Creates a unique token", start)
    destructor = source[start:end]
    if "sc_ws_parse" not in body:
        raise SystemExit("待测源码尚未应用 Rust 接收补丁")
    template = Path(__file__).with_name("websocket_integration.c.in").read_text()
    with tempfile.TemporaryDirectory(prefix="screen-control-rust-integration-") as work:
        code = Path(work) / "integration.c"
        binary = Path(work) / "integration"
        code.write_text(template.replace("/* IMPLEMENTATION */", body).replace("/* DESTRUCTOR */", destructor))
        subprocess.run(["cc", "-std=c11", "-g", "-no-pie", "-fsanitize=address,undefined", "-I", str(ROOT / "native/protocol-ffi/include"), str(code), str(ROOT / "target/release/libscreen_control_protocol_ffi.a"), "-ldl", "-lpthread", "-lm", "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()

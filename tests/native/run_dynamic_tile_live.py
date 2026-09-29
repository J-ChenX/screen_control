#!/usr/bin/env python3
"""在隔离 Xephyr 动态画面中测量固定 Linux 候选的 tile 调用路径。"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import random
import re
import secrets
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def unmap_own_window(display_number):
    tree = subprocess.check_output(["xwininfo", "-root", "-tree"], text=True)
    match = re.search(rf'\s(0x[0-9a-f]+) "Xephyr on :{display_number}\.0 ', tree)
    if match is None:
        raise RuntimeError("无法定位本次创建的 Xephyr 窗口")
    xlib = ctypes.CDLL("libX11.so.6")
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XUnmapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    xlib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(None)
    if not display:
        raise RuntimeError("无法连接外层 X11 显示")
    try:
        xlib.XUnmapWindow(display, int(match.group(1), 16))
        xlib.XSync(display, 0)
    finally:
        xlib.XCloseDisplay(display)


def stop_process(process):
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=60)
    parser.add_argument("--mode", choices=("all", "single-tile", "full-frame", "complex-frame", "noise-frame"),
                        default="all")
    parser.add_argument("--size", choices=("640x480", "3840x2160"), default="640x480")
    args = parser.parse_args()
    if not 60 <= args.frames <= 1800:
        parser.error("--frames 必须介于 60 和 1800 之间")
    if args.size == "3840x2160" and args.mode not in ("single-tile", "full-frame", "noise-frame"):
        parser.error("3840x2160 仅支持单图块、纯色或合成高细节动态全帧模式")
    screen_width, screen_height = map(int, args.size.split("x"))
    candidate = args.candidate.resolve(strict=True)
    metadata = json.loads((candidate / "candidate.json").read_text())
    if metadata.get("status") != "built-not-deployed" or "address,undefined" not in metadata.get("sanitizers", ""):
        raise SystemExit("仅接受已构建、未部署的 ASan/UBSan Linux 候选")
    commit = metadata.get("baselineCommit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit("候选固定源码提交无效")
    source = candidate / f"MeshAgent-{commit}"
    jpeg = source / "lib-jpeg-turbo/linux/x86-64/libturbojpeg.a"
    library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
    header = ROOT / "native/protocol-ffi/include/screen_control_protocol.h"
    binary = source / "DEBUG_meshagent_x86-64"
    if (metadata.get("librarySha256") != sha256(library)
            or metadata.get("headerSha256") != sha256(header)
            or metadata.get("binarySha256") != sha256(binary)
            or metadata.get("archiveSha256") != sha256(candidate / "source.tar.gz")):
        raise SystemExit("Rust 库、头文件、代理或固定源码与候选摘要不一致")
    environment = os.environ.copy()
    include_paths = [str(source / "lib-jpeg-turbo/includes")]
    local_x11_headers = candidate.parent / "sysroot/usr/include"
    if local_x11_headers.exists():
        include_paths.append(str(local_x11_headers))
    include_paths.append(environment.get("CPATH", ""))
    environment["CPATH"] = os.pathsep.join(include_paths)
    display_number = next((number for number in range(190, 220)
                           if not Path(f"/tmp/.X11-unix/X{number}").exists()), None)
    if display_number is None:
        raise SystemExit("没有可用的隔离 X11 显示编号")
    environment["DISPLAY"] = f":{display_number}"
    animation = """import sys,tkinter as tk
w,h=map(int,sys.argv[1:3])
r=tk.Tk();r.geometry(f'{w}x{h}+0+0');r.overrideredirect(True)
c=tk.Canvas(r,width=w,height=h,highlightthickness=0);c.pack()
i=0
def frame():
 global i
 i+=1;c.configure(bg=('#e82d35' if i%2 else '#147ad8'));r.after(50,frame)
frame();r.mainloop()
"""
    complex_animation = """import sys,tkinter as tk
r=tk.Tk();r.geometry('640x480+0+0');r.overrideredirect(True)
c=tk.Canvas(r,width=640,height=480,highlightthickness=0);c.pack()
images=[tk.PhotoImage(file=path) for path in sys.argv[1:3]]
item=c.create_image(0,0,anchor='nw',image=images[0]);i=0
def frame():
 global i
 i+=1;c.itemconfigure(item,image=images[i%2]);r.after(50,frame)
frame();r.mainloop()
"""
    browser_check = """import { chromium } from './web/node_modules/@playwright/test/index.mjs';
import { readFileSync } from 'node:fs';
const packet = readFileSync(0);
if (packet.length <= 16 || packet.readUInt16BE(0) !== 27 || packet.readUInt16BE(2) !== 8 ||
    packet.readUInt32BE(4) !== packet.length - 8 || packet.readUInt16BE(8) !== 3 ||
    packet.readUInt16BE(12) !== 0 || packet.readUInt16BE(14) !== 0) {
  throw new Error('合成 jumbo 协议头无效');
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async base64 => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close(); canvas.width = 1; canvas.height = 1;
    return dimensions;
  }, packet.subarray(16).toString('base64'));
  if (result[0] !== Number(process.env.SC_TEST_EXPECT_WIDTH) ||
      result[1] !== Number(process.env.SC_TEST_EXPECT_HEIGHT)) {
    throw new Error('Chromium 解码尺寸不一致');
  }
  console.log(JSON.stringify({ browserJumboDecode: true, width: result[0], height: result[1] }));
} finally { await browser.close(); }
"""
    with tempfile.TemporaryDirectory(prefix="screen-control-dynamic-tile-") as temporary:
        authority = Path(temporary) / "Xauthority"
        authority.touch(mode=0o600)
        subprocess.run(["xauth", "-f", str(authority), "add", f":{display_number}",
                        "MIT-MAGIC-COOKIE-1", secrets.token_hex(16)], check=True,
                       stdout=subprocess.DEVNULL)
        environment["XAUTHORITY"] = str(authority)
        output = Path(temporary) / "dynamic-tile-live"
        subprocess.run([
            "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
            "-fno-omit-frame-pointer", "-no-pie", "-Wl,--gc-sections", "-I.",
            str(ROOT / "tests/native/dynamic_tile_live.c"), str(candidate / "tile-integration.o"),
            str(candidate / "jpeg-compression.o"), str(library), str(jpeg),
            "-l:libXext.so.6", "-l:libX11.so.6", "-ldl", "-lpthread", "-lm", "-o", str(output),
        ], cwd=source, env=environment, check=True)
        with open(Path(temporary) / "xephyr.log", "w") as log:
            nested = subprocess.Popen(["Xephyr", f":{display_number}", "-screen", args.size,
                                       "-auth", str(authority), "-nolisten", "tcp"],
                                      stdout=log, stderr=subprocess.STDOUT)
            animation_process = None
            try:
                for _ in range(100):
                    if nested.poll() is not None:
                        raise RuntimeError("Xephyr 启动失败")
                    if subprocess.run(["xdpyinfo"], env=environment, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL).returncode == 0:
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError("Xephyr 未及时就绪")
                unmap_own_window(display_number)
                animation_process = subprocess.Popen(["python3", "-c", animation,
                                                      str(screen_width), str(screen_height)], env=environment,
                                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                time.sleep(1)
                if animation_process.poll() is not None:
                    raise RuntimeError("隔离动画启动失败")
                for mode in ("single-tile", "full-frame", "noise-frame"):
                    if args.mode == mode or (args.mode == "all" and mode != "noise-frame"):
                        result = subprocess.run([str(output), mode, str(args.frames)], env=environment,
                                                check=True, capture_output=mode == "noise-frame",
                                                timeout=args.frames * (0.6 if screen_width > 640 else 0.1) + 30)
                        if mode == "noise-frame":
                            sys.stderr.buffer.write(result.stderr)
                            browser_environment = environment.copy()
                            browser_environment["SC_TEST_EXPECT_WIDTH"] = str(screen_width)
                            browser_environment["SC_TEST_EXPECT_HEIGHT"] = str(
                                (screen_height + 31) // 32 * 32)
                            subprocess.run(["mise", "exec", "--", "node", "--input-type=module", "-e", browser_check],
                                           input=result.stdout, cwd=ROOT, env=browser_environment,
                                           check=True, timeout=30)
                if args.mode not in ("all", "complex-frame"):
                    return
                stop_process(animation_process)
                animation_process.stderr.close()
                animation_process = None
                noise_paths = []
                for index in range(2):
                    path = Path(temporary) / f"noise-{index}.ppm"
                    path.write_bytes(b"P6\n640 480\n255\n" + random.Random(index + 11).randbytes(640 * 480 * 3))
                    noise_paths.append(path)
                animation_process = subprocess.Popen(
                    ["python3", "-c", complex_animation, *(str(path) for path in noise_paths)],
                    env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                time.sleep(1)
                if animation_process.poll() is not None:
                    raise RuntimeError("高细节隔离动画启动失败")
                complex_result = subprocess.run([str(output), "complex-frame", str(args.frames)],
                                                env=environment, check=True,
                                                timeout=args.frames / 10 + 20, capture_output=True)
                sys.stderr.buffer.write(complex_result.stderr)
                environment["SC_TEST_EXPECT_WIDTH"] = "640"
                environment["SC_TEST_EXPECT_HEIGHT"] = "480"
                subprocess.run(["mise", "exec", "--", "node", "--input-type=module", "-e", browser_check],
                               input=complex_result.stdout, cwd=ROOT, env=environment, check=True, timeout=20)
            finally:
                try:
                    if animation_process is not None:
                        try:
                            stop_process(animation_process)
                        finally:
                            animation_process.stderr.close()
                finally:
                    stop_process(nested)


if __name__ == "__main__":
    main()

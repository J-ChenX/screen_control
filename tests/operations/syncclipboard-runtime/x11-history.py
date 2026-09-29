#!/usr/bin/env python3
"""在独立 Xvfb 中把合成 PNG 交给实际安装的读取与历史管线，不访问用户剪贴板。"""
import argparse
import os
from pathlib import Path
import selectors
import struct
import subprocess
import tempfile
import zlib

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--xvfb', required=True)
p.add_argument('--install-dir', required=True)
p.add_argument('--core', required=True)
p.add_argument('--probe', required=True)
a = p.parse_args()
verify = Path(__file__).resolve().parents[3] / 'deploy/g0/suite/syncclipboard-latency/verify-runtime.py'
with tempfile.TemporaryDirectory(prefix='screen-control-x11-history-') as temp:
    with open(Path(temp) / 'xvfb.log', 'w') as log:
        x = subprocess.Popen([a.xvfb, '-displayfd', '1', '-nolisten', 'tcp', '-screen', '0', '800x600x24'],
                             stdout=subprocess.PIPE, stderr=log, text=True)
        owner = None
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(x.stdout, selectors.EVENT_READ)
                assert ready.select(10), '独立Xvfb未启动'
            number = x.stdout.readline().strip()
            assert number.isdigit()
            env = dict(os.environ, DISPLAY=':' + number, SCREEN_CONTROL_ISOLATED_CLIPBOARD='1',
                       XDG_RUNTIME_DIR=temp, DBUS_SESSION_BUS_ADDRESS='unix:path=' + temp + '/unused')
            env.pop('WAYLAND_DISPLAY', None)
            def chunk(kind, payload):
                return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload))
            png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 32, 24, 8, 2, 0, 0, 0)) +
                   chunk(b'IDAT', zlib.compress((b'\0' + bytes((30, 80, 160)) * 32) * 24)) + chunk(b'IEND', b''))
            # -quiet 保持前台，便于确认并结束本次创建的所有者。
            owner = subprocess.Popen(['xclip', '-quiet', '-selection', 'clipboard', '-t', 'image/png'],
                                     stdin=subprocess.PIPE, stdout=log, stderr=log, env=env)
            owner.stdin.write(png)
            owner.stdin.close()
            actual = subprocess.check_output(['xclip', '-selection', 'clipboard', '-o', '-t', 'image/png'], env=env, timeout=5)
            assert actual == png, 'X11测试图片所有者未就绪'
            subprocess.run(['python3', str(verify), '--install-dir', a.install_dir,
                            '--core', a.core, '--probe', a.probe], env=env, check=True, timeout=40)
        finally:
            if owner is not None and owner.poll() is None:
                owner.terminate(); owner.wait(timeout=5)
            x.terminate(); x.wait(timeout=5)

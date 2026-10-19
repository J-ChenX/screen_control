#!/usr/bin/env python3
"""等待私有配置中的 Tailscale 监听地址就绪，不改变网络或监听范围。"""
import argparse
import errno
import ipaddress
import json
import socket
import time
from pathlib import Path


def read_bind_address(config):
    settings = json.loads(Path(config).read_text()).get("settings", {})
    address = settings.get("portBind")
    parsed = ipaddress.ip_address(address)
    if parsed.version != 4 or parsed not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("控制面必须绑定明确的 Tailscale IPv4 地址")
    return str(parsed)


def wait_for_address(address, timeout):
    deadline = time.monotonic() + timeout
    waiting = False
    while True:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                # 临时端口只检查地址是否已配置，不占用控制面业务端口。
                probe.bind((address, 0))
            print("控制面监听地址已就绪", flush=True)
            return
        except OSError as error:
            if error.errno != errno.EADDRNOTAVAIL:
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("等待控制面监听地址超时") from error
            if not waiting:
                print("等待 Tailscale 恢复控制面监听地址", flush=True)
                waiting = True
            time.sleep(min(1, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config")
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    if not 0 <= args.timeout <= 110:
        parser.error("等待时限必须在 0 到 110 秒之间")
    try:
        wait_for_address(read_bind_address(args.config), args.timeout)
    except (OSError, ValueError, TimeoutError):
        # 配置可能含凭据，不打印配置内容或原始异常上下文。
        parser.exit(1, "控制面监听地址未就绪或配置无效；由 systemd 重试\n")


if __name__ == "__main__":
    main()

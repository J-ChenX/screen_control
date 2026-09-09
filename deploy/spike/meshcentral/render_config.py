#!/usr/bin/env python3
"""根据已校验的环境设置生成私有 MeshCentral 配置。"""
import ipaddress
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def deployment(env) -> dict:
    def required(key):
        value = env.get("SCREEN_CONTROL_" + key, "").strip()
        if not value:
            raise ValueError("set SCREEN_CONTROL_" + key)
        return value

    host = required("MESH_HOST")
    if len(host) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", part) for part in host.split(".")):
        raise ValueError("MESH_HOST must be a DNS hostname")
    bind = required("MESH_BIND_IP")
    ips = required("REGISTERED_IPS").split(",")
    ips = [ip.strip() for ip in ips]
    if len(ips) != 3 or len(set(ips)) != 3 or bind not in ips:
        raise ValueError("REGISTERED_IPS must contain three distinct addresses including MESH_BIND_IP")
    for value in [bind, *ips]:
        if ipaddress.ip_address(value) not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("only individual Tailscale IPv4 addresses are allowed")
    origin = required("MESH_PORTAL_ORIGIN")
    url = urlsplit(origin)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or any(c.isspace() for c in origin)):
        raise ValueError("MESH_PORTAL_ORIGIN must be an exact HTTPS origin")
    if not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in url.hostname.split(".")):
        raise ValueError("MESH_PORTAL_ORIGIN must use a valid hostname")
    _ = url.port
    return {"host": host, "bind": bind, "ips": ips, "origin": origin}


def render(env) -> dict:
    values = deployment(env)
    config = json.loads((ROOT / "config.example.json").read_text())
    settings = config["settings"]
    settings.update(cert=values["host"], portBind=values["bind"],
                    userAllowedIP=values["ips"], agentAllowedIP=values["ips"],
                    allowedFramingOrigins=[values["origin"]])
    config["domains"][""]["allowedFramingOrigins"] = [values["origin"]]
    return config


def main():
    config = render(os.environ)  # 修改任何文件前先校验。
    path = ROOT / "config.json"
    if path.is_symlink():
        raise ValueError("refusing symlink config.json")
    fd, name = tempfile.mkstemp(dir=ROOT, prefix=".config.local.")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(config, out, indent=2)
            out.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print("Generated private config.json (0600); no service was started.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))

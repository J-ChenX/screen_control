#!/usr/bin/env python3
"""对隔离的 MeshCentral G0 尖峰进行静态校验，失败时默认拒绝继续。"""

from __future__ import annotations

import hashlib
import argparse
import json
import os
from pathlib import Path
import re
import sys
from typing import Any


ROOT = Path(__file__).resolve().parent
MESH_VERSION = "1.2.5"
MESH_INTEGRITY = "sha512-9j/FuqbnkrG6yFy5jR9Q9POIQSxWJAGjVf53oREjkCAsQ9Me2G0jt+4gayU8rFcvEXDHKjwkXLyxOW9IPpbEJg=="
sys.path.insert(0, str(ROOT))
from render_config import deployment
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SECRET_KEY = re.compile(r"(?:password|passwd|secret|privatekey|login(?:key|token))", re.IGNORECASE)


def load_json(name: str) -> dict[str, Any]:
    path = ROOT / name
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{name}: missing or unsafe file")
    return json.loads(path.read_text(encoding="utf-8"))


def expect(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def secret_paths(value: Any, path: str = "$") -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}"
            if SECRET_KEY.search(key) and isinstance(item, str) and item:
                found.append(child)
            found.extend(secret_paths(item, child))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(secret_paths(item, f"{path}[{index}]"))
    return found


def verify_config(errors: list[str], private: bool = False) -> None:
    config = load_json("config.json" if private else "config.example.json")
    expected = deployment(os.environ) if private else {
        "host": "desktop.example.ts.net", "bind": "100.64.0.20",
        "ips": ["100.64.0.10", "100.64.0.20", "100.64.0.30"], "origin": "https://portal.example.ts.net",
    }
    settings = config.get("settings", {})
    domain = config.get("domains", {}).get("", {})
    expect(settings.get("cert") == expected["host"], "config: desktop certificate host drift", errors)
    expect(settings.get("port") == 4443, "config: G0 port must be 4443", errors)
    expect(settings.get("portBind") == expected["bind"], "config: server must bind only configured Tailscale IP", errors)
    expect(settings.get("exactPorts") is True, "config: exactPorts must be true", errors)
    expect(settings.get("webRTC") is True, "config: WebRTC must be enabled for G0", errors)
    expect(settings.get("selfUpdate") is False, "config: self update must be disabled", errors)
    expect(settings.get("noAgentUpdate") == 1, "config: agent update must be disabled", errors)
    expect(settings.get("temporaryAgentUpdate") is False, "config: temporary agent update must be disabled", errors)
    expect(settings.get("allowLoginToken") is False, "config: URL login token support must be disabled", errors)
    expect(settings.get("allowedFramingOrigins") == [expected["origin"]], "config: framing origin must be exact", errors)
    expect(domain.get("allowedFramingOrigins") == [expected["origin"]], "config: domain framing origin must be exact", errors)
    expect(domain.get("newAccounts") is False, "config: public account creation must be disabled", errors)
    expect(domain.get("agentNoProxy") is True, "config: agents must bypass system and browser proxies", errors)
    expect(domain.get("clipboardGet") is False and domain.get("clipboardSet") is False, "config: clipboard must be disabled", errors)
    expect(domain.get("localSessionRecording") is False, "config: session recording must be disabled", errors)
    expect(set(settings.get("userAllowedIP", [])) == set(expected["ips"]), "config: user IP allowlist drift", errors)
    expect(set(settings.get("agentAllowedIP", [])) == set(expected["ips"]), "config: agent IP allowlist drift", errors)
    expect(not secret_paths(config), "config: credential-like string is forbidden", errors)


def verify_package(errors: list[str]) -> None:
    package = load_json("package.json")
    lock = load_json("package-lock.json")
    expect(package.get("private") is True, "package: spike package must be private", errors)
    expect(package.get("dependencies") == {"meshcentral": MESH_VERSION}, "package: MeshCentral version must be exact", errors)
    expect(lock.get("lockfileVersion") == 3, "package lock: lockfileVersion must be 3", errors)
    root = lock.get("packages", {}).get("", {})
    mesh = lock.get("packages", {}).get("node_modules/meshcentral", {})
    expect(root.get("dependencies") == {"meshcentral": MESH_VERSION}, "package lock: root dependency drift", errors)
    expect(mesh.get("version") == MESH_VERSION, "package lock: MeshCentral version drift", errors)
    expect(mesh.get("integrity") == MESH_INTEGRITY, "package lock: MeshCentral integrity drift", errors)
    expect("qs" in package.get("overrides", {}), "package: reviewed qs security override is required", errors)


def verify_container(errors: list[str]) -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    provisioner = (ROOT / "provision.js").read_text(encoding="utf-8")
    meshctrl_secret = (ROOT / "meshctrl-secret.js").read_text(encoding="utf-8")
    digest = DIGEST.search(dockerfile)
    expect(digest is not None, "Dockerfile: base image must use a sha256 digest", errors)
    expect("npm ci --omit=dev --ignore-scripts --no-audit --no-fund" in dockerfile, "Dockerfile: npm install surface drift", errors)
    expect("USER node" in dockerfile, "Dockerfile: runtime user must be node", errors)
    expect("COPY --chown=node:node provision.js meshctrl-secret.js ./" in dockerfile, "Dockerfile: reviewed secret wrappers are missing", errors)
    expect('ENTRYPOINT ["node", "node_modules/meshcentral/meshcentral.js"]' in dockerfile, "Dockerfile: entry point drift", errors)
    for marker in (
        "network_mode: host",
        'restart: "no"',
        "read_only: true",
        "user: node",
        "- ALL",
        "no-new-privileges:true",
        "source: ./config.json",
        "target: /opt/meshcentral/meshcentral-data/config.json",
        "create_host_path: false",
    ):
        expect(marker in compose, f"compose: required isolation marker missing: {marker}", errors)
    expect("ports:" not in compose, "compose: host-network spike must not publish a second port surface", errors)
    expect("network_mode: none" in compose, "compose: provisioner must have no network", errors)
    expect("/opt/meshcentral/provision.js" in compose, "compose: one-shot provisioner entry point missing", errors)
    expect(compose.count('HTTP_PROXY: ""') == 2 and compose.count('HTTPS_PROXY: ""') == 2, "compose: inherited proxy settings must be neutralized", errors)
    expect("fs.readFileSync(0)" in provisioner, "provisioner: secret must be read from stdin", errors)
    expect('"--hashpass"' in provisioner, "provisioner: derived verifier handoff missing", errors)
    expect(".mainStart()" in provisioner, "provisioner: MeshCentral one-shot entry call missing", errors)
    expect(re.search(r'["\']--pass["\']', provisioner) is None, "provisioner: plaintext password argv is forbidden", errors)
    expect("process.env" not in provisioner, "provisioner: environment secret handoff is forbidden", errors)
    expect('"/run/secrets/loginpass"' in meshctrl_secret, "meshctrl wrapper: fixed secret mount is required", errors)
    expect('"--loginpass", password' in meshctrl_secret, "meshctrl wrapper: in-process password handoff missing", errors)
    expect("process.env" not in meshctrl_secret, "meshctrl wrapper: environment secret handoff is forbidden", errors)
    expect("fs.readFileSync(secretPath)" in meshctrl_secret, "meshctrl wrapper: secret file read is required", errors)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private", action="store_true", help="validate generated config.json against the environment")
    args = parser.parse_args()
    errors: list[str] = []
    for verifier in (lambda errors: verify_config(errors, args.private), verify_package, verify_container):
        try:
            verifier(errors)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            errors.append(f"{verifier.__name__}: {error}")
    files = ["Dockerfile", "compose.yaml", "config.json" if args.private else "config.example.json", "package.json", "package-lock.json", "provision.js", "meshctrl-secret.js", "render_config.py"]
    result = {
        "schemaVersion": "screen-control.meshcentral-spike-check/v1",
        "status": "passed" if not errors else "failed",
        "meshcentralVersion": MESH_VERSION,
        "files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files if (ROOT / name).is_file()},
        "errors": errors,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

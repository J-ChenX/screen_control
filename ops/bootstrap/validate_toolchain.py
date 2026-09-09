#!/usr/bin/env python3
"""仅使用标准库的 IO-01b 工具链锁校验器，失败时默认拒绝继续。"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = ROOT / "deploy/releases/current/toolchain.lock.json"
IMPORTS_PATH = ROOT / "ops/verify/bootstrap-imports.json"
PREFLIGHT_PATH = ROOT / "ops/bootstrap/preflight"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN = re.compile(r"(?i)(^|[^a-z])(latest|system default|系统默认)([^a-z]|$)")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk(value: Any, path: str = "$"):
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, f"{path}[{index}]")


def validate(lock_path: Path = DEFAULT_LOCK) -> list[str]:
    errors: list[str] = []
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    required = {"schemaVersion", "releaseId", "generatedUtc", "source", "bootstrap", "targets", "build", "runtime", "verification", "artifacts", "unresolved"}
    if missing := sorted(required - lock.keys()):
        errors.append(f"missing top-level fields: {','.join(missing)}")
    if lock.get("schemaVersion") != "screen-control.toolchain-lock/v1":
        errors.append("wrong schemaVersion")
    for json_path, value in walk(lock):
        if value == "":
            errors.append(f"empty string at {json_path}")
        if isinstance(value, str) and FORBIDDEN.search(value):
            errors.append(f"floating/default value at {json_path}")
        if json_path.endswith("Sha256") and (not isinstance(value, str) or not HEX64.fullmatch(value)):
            errors.append(f"invalid SHA-256 at {json_path}")
    targets = lock.get("targets", [])
    if {item.get("node") for item in targets if isinstance(item, dict)} != {"nix", "echova", "jiang-chenx"}:
        errors.append("targets must be exactly nix, echova, and jiang-chenx")
    bootstrap = lock.get("bootstrap", {})
    if bootstrap.get("recorderSha256") != sha256_file(PREFLIGHT_PATH):
        errors.append("bootstrap recorder hash does not match current preflight executable")
    imports = json.loads(IMPORTS_PATH.read_text(encoding="utf-8"))
    imported_environment = imports.get("io01a", {}).get("environmentSnapshotHash")
    if bootstrap.get("environmentSnapshotHash") != imported_environment:
        errors.append("bootstrap environment hash does not match the selected IO-01a import")
    target_version = lock.get("runtime", {}).get("tailscale", {}).get("targetVersion")
    if target_version and any(target_version not in str(item.get("tailscale")) for item in targets):
        errors.append("one or more target snapshots do not match the locked Tailscale version")
    files = lock.get("artifacts", {}).get("files", [])
    for item in files:
        relative = item.get("path")
        expected = item.get("sha256")
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            errors.append(f"unsafe artifact path {relative!r}")
            continue
        target = ROOT / relative
        if not target.is_file() or target.is_symlink():
            errors.append(f"artifact missing or unsafe: {relative}")
        elif sha256_file(target) != expected:
            errors.append(f"artifact hash mismatch: {relative}")
    decisions = json.loads((ROOT / "deploy/releases/current/qg02-decisions.json").read_text(encoding="utf-8"))
    if len(decisions.get("decisions", [])) != 8:
        errors.append("QG02 matrix must contain eight domain decisions")
    for index, decision in enumerate(decisions.get("decisions", [])):
        for field in ("domain", "selected", "rejected", "reason", "officialSource", "targetGate", "replacementTrigger"):
            if not decision.get(field):
                errors.append(f"QG02 decision {index} missing {field}")
    sbom_path = ROOT / lock.get("artifacts", {}).get("sbom", {}).get("path", "__missing__")
    if sbom_path.is_file():
        sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
        if sbom.get("bomFormat") != "CycloneDX" or not sbom.get("components"):
            errors.append("SBOM is not a populated CycloneDX document")
    else:
        errors.append("SBOM missing")
    return errors


def main() -> int:
    path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_LOCK
    errors = validate(path)
    print(json.dumps({"valid": not errors, "errors": errors}, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())

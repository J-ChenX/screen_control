#!/usr/bin/env python3
"""IO-01d 网络变更回滚演练，仅开放固定操作范围。"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import ipaddress
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
KNOWN_HOSTS = Path.home() / ".ssh" / "known_hosts"
NODES = {
    "nix": {"os": "linux", "target": None, "ip": os.getenv("SCREEN_CONTROL_NIX_IP", ""), "verifier": "echova", "verifierIp": os.getenv("SCREEN_CONTROL_ECHOVA_IP", "")},
    "echova": {"os": "linux", "target": os.getenv("SCREEN_CONTROL_ECHOVA_SSH_TARGET", ""), "ip": os.getenv("SCREEN_CONTROL_ECHOVA_IP", ""), "verifier": "nix", "verifierIp": os.getenv("SCREEN_CONTROL_NIX_IP", "")},
    "jiang-chenx": {"os": "windows", "target": os.getenv("SCREEN_CONTROL_WINDOWS_SSH_TARGET", ""), "ip": os.getenv("SCREEN_CONTROL_WINDOWS_IP", ""), "verifier": "echova", "verifierIp": os.getenv("SCREEN_CONTROL_ECHOVA_IP", "")},
}


def validate_inventory() -> None:
    addresses = []
    for name, node in NODES.items():
        for key in ("ip", "verifierIp"):
            if ipaddress.ip_address(str(node[key])) not in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError(f"{name}: configure individual Tailscale IPv4 addresses")
        addresses.append(node["ip"])
        target = node["target"]
        if target is not None:
            match = re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*@([0-9.]+)", str(target))
            if not match or match[1] != node["ip"]:
                raise ValueError(f"{name}: SSH target must be user@configured-Tailscale-IPv4")
    if len(set(addresses)) != len(addresses):
        raise ValueError("target addresses must be distinct")

MAX_OUTPUT = 8 * 1024 * 1024


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def run(command: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    if len(result.stdout) > MAX_OUTPUT or len(result.stderr) > MAX_OUTPUT:
        raise RuntimeError("command output exceeded bound")
    if check and result.returncode != 0:
        raise RuntimeError(f"fixed command failed ({result.returncode}): {command[0]}: {result.stderr[:1000].decode('utf-8', 'replace')}")
    return result


def ssh_command(target: str, remote: str) -> list[str]:
    if not target or target.startswith("-") or any(c.isspace() for c in target):
        raise ValueError("invalid SSH target")
    return [
        "ssh", "-p", "22", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
        target, "--", remote,
    ]


def linux_exec(node: str, command: list[str], check: bool = True) -> subprocess.CompletedProcess[bytes]:
    target = NODES[node]["target"]
    if target is None:
        return run(command, check=check)
    return run(ssh_command(str(target), shlex.join(command)), check=check)


def windows_exec(script: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    remote = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
    return run(ssh_command(str(NODES["jiang-chenx"]["target"]), shlex.join(remote)), timeout=60, check=check)


def normalized_linux_rules(node: str) -> bytes:
    raw = linux_exec(node, ["sudo", "-n", "iptables-save"]).stdout.decode("utf-8", "replace")
    lines = [line for line in raw.splitlines() if not line.startswith("# Generated") and not line.startswith("# Completed")]
    return ("\n".join(lines) + "\n").encode()


def normalized_windows_rules() -> bytes:
    script = "$r=Get-NetFirewallRule|Sort-Object Name|Select-Object Name,DisplayName,Enabled,Direction,Action,Profile;[ordered]@{profiles=Get-NetFirewallProfile|Sort-Object Name|Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction;rules=$r}|ConvertTo-Json -Depth 4 -Compress"
    return windows_exec(script).stdout.strip() + b"\n"


def verifier_ping(target: str, should_succeed: bool) -> bool:
    node = NODES[target]
    ping = ["ping", "-c", "1", "-W", "2", str(node["ip"])]
    if node["verifier"] == "nix":
        result = run(ping, timeout=5, check=False)
    else:
        result = run(ssh_command(str(NODES[str(node["verifier"])]["target"]), shlex.join(ping)), timeout=8, check=False)
    succeeded = result.returncode == 0
    return succeeded == should_succeed


def target_ssh_health(target: str) -> bool:
    node = NODES[target]
    if node["target"] is None:
        return True
    result = run(ssh_command(str(node["target"]), "hostname"), timeout=20, check=False)
    return result.returncode == 0


def exercise_linux(node: str, run_tag: str, rollback_seconds: int) -> dict[str, Any]:
    validate_inventory()
    source = str(NODES[node]["verifierIp"])
    unit = f"screen-control-rollback-{run_tag}-{node}".replace("_", "-")
    rule = ["INPUT", "-i", "tailscale0", "-p", "icmp", "--icmp-type", "echo-request", "-s", source, "-m", "comment", "--comment", run_tag, "-j", "DROP"]
    delete = ["sudo", "-n", "iptables", "-D", *rule]
    insert = ["sudo", "-n", "iptables", "-I", *rule]
    timer = ["sudo", "-n", "systemd-run", f"--unit={unit}", f"--on-active={rollback_seconds}s", "--timer-property=AccuracySec=1s", "/usr/sbin/iptables", "-D", *rule]
    before = sha256(normalized_linux_rules(node))
    if not verifier_ping(node, True) or not target_ssh_health(node):
        raise RuntimeError(f"{node}: independent verifier or SSH rescue unavailable before mutation")
    armed = False
    applied = False
    blocked = False
    recovered = False
    started = time.monotonic()
    try:
        linux_exec(node, timer)
        armed = True
        linux_exec(node, insert)
        applied = True
        blocked = verifier_ping(node, False)
        deadline = time.monotonic() + rollback_seconds + 20
        while time.monotonic() < deadline:
            if verifier_ping(node, True):
                recovered = True
                break
            time.sleep(1)
    finally:
        if applied and not recovered:
            linux_exec(node, delete, check=False)
        linux_exec(node, ["sudo", "-n", "systemctl", "stop", f"{unit}.timer"], check=False)
        linux_exec(node, ["sudo", "-n", "systemctl", "reset-failed", f"{unit}.service"], check=False)
    after = sha256(normalized_linux_rules(node))
    ssh_ok = target_ssh_health(node)
    return {
        "target": node, "platform": "linux", "verifier": NODES[node]["verifier"],
        "rollbackSeconds": rollback_seconds, "armedBeforeChange": armed, "lossObserved": blocked,
        "recovered": recovered, "recoveryElapsedSeconds": round(time.monotonic() - started, 3),
        "sshRescuePreserved": ssh_ok, "rulesBeforeSha256": before, "rulesAfterSha256": after,
        "rulesRestored": before == after,
    }


def ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def exercise_windows(run_tag: str, rollback_seconds: int) -> dict[str, Any]:
    validate_inventory()
    node = "jiang-chenx"
    source = str(NODES[node]["verifierIp"])
    rule_name = f"screen-control-io01d-{run_tag}"
    task_name = f"screen-control-rollback-{run_tag}"
    rollback_script = f"Remove-NetFirewallRule -DisplayName {ps_quote(rule_name)} -ErrorAction SilentlyContinue"
    rollback_encoded = base64.b64encode(rollback_script.encode("utf-16le")).decode("ascii")
    arm_script = (
        f"$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoLogo -NoProfile -NonInteractive -EncodedCommand {rollback_encoded}';"
        f"$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds({rollback_seconds});"
        f"Register-ScheduledTask -TaskName {ps_quote(task_name)} -Action $a -Trigger $t -User 'SYSTEM' -RunLevel Highest -Force|Out-Null;"
        f"if(-not (Get-ScheduledTask -TaskName {ps_quote(task_name)} -ErrorAction Stop)){{throw 'rollback task missing'}}"
    )
    add_script = f"New-NetFirewallRule -DisplayName {ps_quote(rule_name)} -Direction Inbound -Action Block -Protocol ICMPv4 -IcmpType 8 -RemoteAddress {ps_quote(source)} -InterfaceAlias 'Tailscale' -Profile Any|Out-Null"
    remove_script = f"Remove-NetFirewallRule -DisplayName {ps_quote(rule_name)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName {ps_quote(task_name)} -Confirm:$false -ErrorAction SilentlyContinue"
    before = sha256(normalized_windows_rules())
    if not verifier_ping(node, True) or not target_ssh_health(node):
        raise RuntimeError("jiang-chenx: independent verifier or SSH rescue unavailable before mutation")
    armed = False
    applied = False
    blocked = False
    recovered = False
    started = time.monotonic()
    try:
        windows_exec(arm_script)
        armed = True
        windows_exec(add_script)
        applied = True
        blocked = verifier_ping(node, False)
        deadline = time.monotonic() + rollback_seconds + 30
        while time.monotonic() < deadline:
            if verifier_ping(node, True):
                recovered = True
                break
            time.sleep(1)
    finally:
        if applied and not recovered:
            windows_exec(remove_script, check=False)
        else:
            windows_exec(f"Unregister-ScheduledTask -TaskName {ps_quote(task_name)} -Confirm:$false -ErrorAction SilentlyContinue", check=False)
    after = sha256(normalized_windows_rules())
    ssh_ok = target_ssh_health(node)
    return {
        "target": node, "platform": "windows", "verifier": NODES[node]["verifier"],
        "rollbackSeconds": rollback_seconds, "armedBeforeChange": armed, "lossObserved": blocked,
        "recovered": recovered, "recoveryElapsedSeconds": round(time.monotonic() - started, 3),
        "sshRescuePreserved": ssh_ok, "rulesBeforeSha256": before, "rulesAfterSha256": after,
        "rulesRestored": before == after,
    }


def exercise(targets: list[str], rollback_seconds: int) -> dict[str, Any]:
    run_tag = "io01d-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    results = []
    for target in targets:
        result = exercise_windows(run_tag, rollback_seconds) if NODES[target]["os"] == "windows" else exercise_linux(target, run_tag, rollback_seconds)
        results.append(result)
        result["passed"] = all(result[key] for key in ("armedBeforeChange", "lossObserved", "recovered", "sshRescuePreserved", "rulesRestored")) and result["recoveryElapsedSeconds"] <= 300
        if not result["passed"]:
            break
    passed = len(results) == len(targets) and all(item["passed"] for item in results)
    return {"schemaVersion": "screen-control.network-guard-evidence/v1", "runTag": run_tag, "results": results, "status": "passed" if passed else "failed"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["exercise"])
    parser.add_argument("--targets", nargs="+", choices=["all", *NODES], default=["all"])
    parser.add_argument("--rollback-seconds", type=int, default=20)
    args = parser.parse_args()
    if not 10 <= args.rollback_seconds <= 240:
        raise ValueError("rollback seconds must be between 10 and 240")
    targets = list(NODES) if "all" in args.targets else list(dict.fromkeys(args.targets))
    result = exercise(targets, args.rollback_seconds)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"network-guard: {error}", file=sys.stderr)
        raise SystemExit(1)

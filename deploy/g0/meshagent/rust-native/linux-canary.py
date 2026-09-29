#!/usr/bin/env python3
"""更新既有 Linux 代理；保留身份和限制，以独立定时器恢复原工件。"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path("/opt/screen-control/meshagent")
STATE = Path("/var/lib/screen-control")
SERVICE = "screen-control-meshagent.service"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def atomic_copy(source, target):
    temporary = target.with_name(target.name + ".next")
    shutil.copy2(source, temporary)
    os.replace(temporary, target)


def write_json(path, value):
    temporary = path.with_name(path.name + ".next")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def checksum_for_candidate(text, expected):
    lines = text.splitlines()
    matches = [i for i, line in enumerate(lines) if re.fullmatch(r"[a-fA-F0-9]{64} [ *]meshagent", line)]
    if len(matches) != 1 or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("固定摘要清单必须包含唯一代理条目")
    lines[matches[0]] = expected + "  meshagent"
    return "\n".join(lines) + "\n"


def health(expected):
    run("sha256sum", "-c", "meshagent.sha256", cwd=ROOT)
    values = dict(line.split("=", 1) for line in run(
        "systemctl", "show", SERVICE, "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts").splitlines())
    pid = int(values["MainPID"])
    if values["ActiveState"] != "active" or pid <= 0:
        raise RuntimeError("代理服务未运行")
    if digest(ROOT / "meshagent") != expected or digest(Path(f"/proc/{pid}/exe")) != expected:
        raise RuntimeError("运行进程与预期工件不一致")
    # 使用既有脚本核对规则；status 不修改规则或配置。
    run("/bin/sh", "-c", "set -a; if [ -f /etc/screen-control/meshagent.env ]; then . /etc/screen-control/meshagent.env; fi; "
        "exec /usr/local/libexec/screen-control-meshagent-firewall status")
    return {"pid": pid, "restarts": int(values["NRestarts"])}


def cancel_timer(unit):
    try:
        run("systemctl", "stop", unit + ".timer")
    except subprocess.CalledProcessError:
        # 排队的任务还会在互斥锁内复查状态，提交后不反向恢复。
        print("警告：定时器停止失败，排队任务将复查保留状态", flush=True)


def restore(backup, automatic=False):
    state = json.loads((backup / "state.json").read_text())
    if automatic and state["status"] in ("retained-for-observation", "restored"):
        return {"status": "already-" + state["status"]}
    if digest(backup / "meshagent") != state["previousSha256"]:
        raise RuntimeError("备份工件摘要不符")
    if digest(backup / "meshagent.sha256") != state["checksumSha256"]:
        raise RuntimeError("备份校验清单摘要不符")
    run("systemctl", "stop", SERVICE)
    atomic_copy(backup / "meshagent", ROOT / "meshagent")
    atomic_copy(backup / "meshagent.sha256", ROOT / "meshagent.sha256")
    # 身份数据库沿用当前状态；备份仅供人工救援，不自动回退数据库。
    run("systemctl", "reset-failed", SERVICE)
    run("systemctl", "start", SERVICE)
    verified = health(state["previousSha256"])
    state.update(status="restored", restoredUtc=datetime.now(timezone.utc).isoformat())
    write_json(backup / "state.json", state)
    cancel_timer(state["timerUnit"])
    return {"status": "restored", **verified}


def arm(candidate, manifest, expected_current):
    for pending in STATE.glob("rust-canary-*/state.json"):
        if json.loads(pending.read_text()).get("status") == "armed":
            raise RuntimeError("已有未完成的观察版本，请先保留或恢复")
    build = json.loads(manifest.read_text())
    expected = build.get("binarySha256")
    if build.get("status") != "built-not-deployed" or build.get("sanitizers") or build.get("lifetimePatchSha256"):
        raise ValueError("仅接受不含实验生命周期补丁的默认发布构建")
    if digest(candidate) != expected:
        raise ValueError("候选与构建清单不一致")
    health(expected_current)
    checksum = checksum_for_candidate((ROOT / "meshagent.sha256").read_text(), expected)
    backup = Path(tempfile.mkdtemp(prefix="rust-canary-", dir=STATE))
    for name in ("meshagent", "meshagent.sha256"):
        shutil.copy2(ROOT / name, backup / name)
    shutil.copy2(__file__, backup / "linux-canary.py")
    shutil.copy2(candidate, backup / "candidate")
    shutil.copy2(manifest, backup / "candidate.json")
    os.chmod(backup / "candidate", 0o755)
    if digest(backup / "candidate") != expected:
        raise ValueError("候选复制后摘要不一致")
    state = {"status": "armed", "previousSha256": expected_current, "agentSha256": expected,
             "checksumSha256": digest(backup / "meshagent.sha256"),
             "buildManifestSha256": digest(backup / "candidate.json"),
             "timerUnit": "screen-control-" + backup.name,
             "armedUtc": datetime.now(timezone.utc).isoformat()}
    write_json(backup / "state.json", state)
    # 替换前必须建立独立 root 定时器，SSH 断开也能恢复。
    try:
        run("systemd-run", "--quiet", "--unit=" + state["timerUnit"], "--on-active=10m",
            "--timer-property=AccuracySec=1s", "/usr/bin/python3", str(backup / "linux-canary.py"),
            "restore", "--backup-dir", str(backup), "--automatic")
    except subprocess.CalledProcessError:
        state["status"] = "schedule-failed"
        write_json(backup / "state.json", state)
        raise
    try:
        run("systemctl", "is-active", state["timerUnit"] + ".timer")
        run("systemctl", "stop", SERVICE)
        for name in ("meshagent.msh", "meshagent.db"):
            if (ROOT / name).exists():
                shutil.copy2(ROOT / name, backup / name)
        atomic_copy(backup / "candidate", ROOT / "meshagent")
        next_checksum = backup / "candidate.sha256"
        next_checksum.write_text(checksum)
        atomic_copy(next_checksum, ROOT / "meshagent.sha256")
        run("systemctl", "start", SERVICE)
        state.update(health(expected))
        write_json(backup / "state.json", state)
    except BaseException:
        restore(backup)
        raise
    return {"status": "armed", "backupDir": str(backup), "agentSha256": expected, "pid": state["pid"]}


def retain(backup):
    state = json.loads((backup / "state.json").read_text())
    if state["status"] != "armed":
        raise ValueError("只有尚未回滚的观察版本可以保留")
    if digest(backup / "candidate.json") != state["buildManifestSha256"]:
        raise ValueError("构建清单已改变")
    if digest(backup / "meshagent") != state["previousSha256"] or digest(backup / "meshagent.sha256") != state["checksumSha256"]:
        raise ValueError("回滚备份已改变")
    verified = health(state["agentSha256"])
    if verified != {key: state[key] for key in ("pid", "restarts")}:
        raise RuntimeError("观察期间代理发生重启，不能保留")
    run("systemctl", "is-active", state["timerUnit"] + ".timer")
    state.update(status="retained-for-observation", retainedUtc=datetime.now(timezone.utc).isoformat())
    write_json(backup / "state.json", state)
    cancel_timer(state["timerUnit"])
    return {"status": state["status"], "agentSha256": state["agentSha256"], **verified}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("arm", "retain", "restore"))
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--expected-current")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--automatic", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("需要 root 执行既有代理更新")
    os.umask(0o077)
    STATE.mkdir(exist_ok=True)
    with (STATE / "rust-agent-update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.mode == "arm":
            if not all((args.candidate, args.manifest, args.expected_current)):
                parser.error("arm 需要候选、清单及当前摘要")
            result = arm(args.candidate, args.manifest, args.expected_current)
        else:
            if not args.backup_dir or args.backup_dir.resolve().parent != STATE or not args.backup_dir.name.startswith("rust-canary-"):
                parser.error("需要本工具生成的备份目录")
            result = retain(args.backup_dir) if args.mode == "retain" else restore(args.backup_dir, args.automatic)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

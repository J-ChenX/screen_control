#!/usr/bin/env python3
"""只读采样本机 MeshAgent 服务组的进程、内存与重启计数。"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time


SERVICE = "screen-control-meshagent.service"
CONTROL_GROUP = f"/system.slice/{SERVICE}"


def read_fields(path, wanted):
    fields = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition(":")
        if separator and key in wanted:
            fields[key] = value.strip()
    return fields


def read_kib(value):
    number, unit = value.split()
    if unit != "kB":
        raise ValueError("意外的 proc 内存单位")
    return int(number) * 1024


def read_process(pid):
    base = Path("/proc") / str(pid)
    status = read_fields(base / "status", {"Name", "PPid", "Uid", "VmRSS", "VmData", "VmSwap", "Threads"})
    rollup = read_fields(base / "smaps_rollup", {"Rss", "Pss", "Anonymous", "Private_Dirty"})
    return {
        "pid": pid,
        "name": status["Name"],
        "ppid": int(status["PPid"]),
        "uid": int(status["Uid"].split()[0]),
        "threads": int(status["Threads"]),
        "fd_count": len(list((base / "fd").iterdir())),
        "rss_bytes": read_kib(rollup["Rss"]),
        "pss_bytes": read_kib(rollup["Pss"]),
        "anonymous_bytes": read_kib(rollup["Anonymous"]),
        "private_dirty_bytes": read_kib(rollup["Private_Dirty"]),
        "data_bytes": read_kib(status["VmData"]),
        "swap_bytes": read_kib(status["VmSwap"]) if "VmSwap" in status else 0,
    }


def service_properties():
    output = subprocess.check_output([
        "systemctl", "show", SERVICE, "-p", "ControlGroup", "-p", "MainPID",
        "-p", "NRestarts", "-p", "ActiveState", "--no-pager",
    ], text=True)
    values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    if values.get("ControlGroup") != CONTROL_GROUP or values.get("ActiveState") != "active":
        raise RuntimeError("目标服务组不活动或路径与预期不符")
    if int(values.get("MainPID", "0")) <= 0:
        raise RuntimeError("目标服务没有活动主进程")
    return values


def sample():
    service = service_properties()
    group = Path("/sys/fs/cgroup") / CONTROL_GROUP.lstrip("/")
    pids = sorted(int(value) for value in (group / "cgroup.procs").read_text().split())
    processes = []
    vanished = []
    for pid in pids:
        try:
            processes.append(read_process(pid))
        except FileNotFoundError:
            vanished.append(pid)
    events = dict(line.split() for line in (group / "memory.events").read_text().splitlines())
    cpu = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "service": SERVICE,
        "main_pid": int(service["MainPID"]),
        "restart_count": int(service["NRestarts"]),
        "memory_current_bytes": int((group / "memory.current").read_text()),
        "memory_peak_bytes": int((group / "memory.peak").read_text()),
        "swap_current_bytes": int((group / "memory.swap.current").read_text()),
        "cpu_usage_usec": int(cpu["usage_usec"]),
        "pids_current": int((group / "pids.current").read_text()),
        "memory_events": {key: int(value) for key, value in events.items()
                          if key in ("high", "max", "oom", "oom_kill")},
        "processes": processes,
        "vanished_pids": vanished,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    if not 1 <= args.samples <= 300 or not 0 <= args.interval <= 60:
        parser.error("采样次数必须为 1–300，间隔必须为 0–60 秒")
    if os.geteuid() != 0:
        parser.error("需要 root 只读访问代理进程的 smaps_rollup；使用 sudo -n 运行")
    for index in range(args.samples):
        print(json.dumps(sample(), ensure_ascii=False), flush=True)
        if index + 1 < args.samples:
            time.sleep(args.interval)


if __name__ == "__main__":
    main()

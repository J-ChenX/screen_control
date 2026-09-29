#!/usr/bin/env python3
"""只读采样已登记 Windows 代理同路径进程；不读取画面、身份或用户文件。"""
import argparse
import base64
import json
import os
from pathlib import Path
import runpy
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def validate_samples(rows, count, expected_sha256=None):
    """只接纳同一运行工件、同一主进程的完整健康序列。"""
    if len(rows) != count or any(row["service"] != "Running" or not row["processes"] for row in rows):
        raise ValueError("Windows 代理采样不完整或服务不健康")
    expected = (expected_sha256 or rows[0]["binarySha256"]).lower()
    if any(row["binarySha256"] != expected or row["servicePid"] != rows[0]["servicePid"]
           or row["servicePid"] not in {p["pid"] for p in row["processes"]} for row in rows):
        raise ValueError("采样期间工件或主进程发生切换，不能合并解释为同一版本的内存趋势")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--interval", type=int, default=3)
    parser.add_argument("--expected-sha256", help="预期工件摘要；省略时绑定首个样本")
    args = parser.parse_args()
    if not 1 <= args.samples <= 300 or not 1 <= args.interval <= 60:
        parser.error("samples 必须为 1–300，interval 必须为 1–60 秒")
    if args.expected_sha256 and not re.fullmatch(r"[a-fA-F0-9]{64}", args.expected_sha256):
        parser.error("expected-sha256 必须为 64 位十六进制摘要")
    path = Path(os.environ.get("SCREEN_CONTROL_ENV_FILE", ROOT / ".env"))
    values = runpy.run_path(str(ROOT / "ops/with-env"))["read_env"](path)
    target = os.environ.get("SCREEN_CONTROL_WINDOWS_SSH_TARGET", values.get("SCREEN_CONTROL_WINDOWS_SSH_TARGET"))
    if not target or target.startswith("-"):
        parser.error("需要已登记的 SCREEN_CONTROL_WINDOWS_SSH_TARGET")
    script = r'''
$ErrorActionPreference = 'Stop'
$path = 'C:\ProgramData\ScreenControl\MeshAgent\meshagent.exe'
for ($index = 0; $index -lt SAMPLE_COUNT; $index++) {
    $service = Get-CimInstance Win32_Service -Filter "Name='Mesh Agent'"
    $items = @(Get-CimInstance Win32_Process -Filter "Name='meshagent.exe'" |
        Where-Object { $_.ExecutablePath -ieq $path })
    $processes = @($items | ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction Stop
        [pscustomobject][ordered]@{ pid = $process.Id; parentPid = $_.ParentProcessId;
            privateBytes = $process.PrivateMemorySize64; workingSetBytes = $process.WorkingSet64;
            handles = $process.HandleCount; threads = $process.Threads.Count }
    })
    [ordered]@{ sample = $index; utc = [DateTime]::UtcNow.ToString('o');
        service = $service.State; servicePid = $service.ProcessId;
        binarySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant();
        processes = $processes;
        privateBytes = ($processes | Measure-Object -Property privateBytes -Sum).Sum;
        workingSetBytes = ($processes | Measure-Object -Property workingSetBytes -Sum).Sum
    } | ConvertTo-Json -Compress -Depth 4
    if ($index + 1 -lt SAMPLE_COUNT) { Start-Sleep -Seconds SAMPLE_INTERVAL }
}
'''.replace("SAMPLE_COUNT", str(args.samples)).replace("SAMPLE_INTERVAL", str(args.interval))
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
               target, "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + encoded]
    # 不将 SSH 错误原文写入报告，以免暴露私有主机名和路径。
    try:
        result = subprocess.run(command, capture_output=True,
                                timeout=args.samples * (args.interval + 10) + 30)
    except subprocess.TimeoutExpired:
        raise SystemExit("Windows 代理采样超时") from None
    if result.returncode:
        raise SystemExit("Windows 代理采样失败，SSH 退出码 " + str(result.returncode))
    rows = [json.loads(line) for line in result.stdout.decode("utf-8-sig").splitlines() if line.strip()]
    try:
        validate_samples(rows, args.samples, args.expected_sha256)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    for row in rows:
        print(json.dumps(row, ensure_ascii=False))


if __name__ == "__main__":
    main()

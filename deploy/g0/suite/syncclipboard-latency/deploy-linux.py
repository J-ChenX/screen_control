#!/usr/bin/env python3
"""更新既有客户端；先验证实际依赖，备份代码、配置和历史，再短暂重启。"""
from pathlib import Path
import argparse
import datetime
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--unit', required=True)
p.add_argument('--install-dir', required=True)
p.add_argument('--dll', required=True)
p.add_argument('--probe', required=True, help='已编译的 Runtime.dll')
p.add_argument('--recent-first', action='store_true', help='历史按最近复制或使用排序')
a = p.parse_args()
root = Path(a.install_dir).resolve()
dll = root / 'SyncClipboard.Core.dll'
config = Path.home() / '.config/SyncClipboard/SyncClipboard.json'
runtime = config.with_name('RuntimeConfig.json')
assert dll.is_file() and config.is_file() and Path(a.dll).is_file()
if a.recent_first:
    assert runtime.is_file(), '排序迁移需要既有运行配置'
# 部署前必须使用目标安装包的宿主、依赖清单和原生库验证候选，不能只检查进程存活。
spec = importlib.util.spec_from_file_location('verify_runtime', Path(__file__).with_name('verify-runtime.py'))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
verifier.verify(root, a.dll, a.probe)
pid = int(subprocess.check_output(['systemctl', '--user', 'show', a.unit, '-p', 'MainPID', '--value']))
assert pid > 0 and Path(f'/proc/{pid}/exe').resolve().parent == root, '服务与安装目录不匹配'
backup = Path.home() / '.local/state/screen-control' / ('clipboard-latency-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700)
priv = [] if os.access(dll, os.W_OK) else ['sudo', '-n']
if priv:
    subprocess.run(priv + ['true'], check=True)

def unit(action):
    subprocess.run(['systemctl', '--user', action, a.unit], check=True)

def write_json(path, data):
    temp = path.with_suffix('.repair-tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    temp.chmod(0o600)
    os.replace(temp, path)

unit('stop')
try:
    shutil.copy2(dll, backup / dll.name)
    shutil.copy2(config, backup / config.name)
    had_runtime = runtime.exists()
    if had_runtime:
        shutil.copy2(runtime, backup / runtime.name)
    # 数据仅用于人工协调恢复；自动回滚不覆盖在线同步数据库。
    for name in ('data', 'file'):
        source = config.parent / name
        if source.exists():
            shutil.copytree(source, backup / name)
    q = shlex.quote
    restore = ' '.join(map(q, priv + ['install', '-m', '644', str(backup / dll.name), str(dll)]))
    rollback = backup / 'rollback.sh'
    rollback.write_text('#!/bin/sh\nset -eu\nsystemctl --user stop ' + q(a.unit) + '\n' + restore +
        '\ncp ' + q(str(backup / config.name)) + ' ' + q(str(config)) + '\n' +
        ('cp ' + q(str(backup / runtime.name)) + ' ' + q(str(runtime)) + '\n' if had_runtime else '') +
        'systemctl --user start ' + q(a.unit) + '\n')
    rollback.chmod(0o700)
    subprocess.run(priv + ['install', '-m', '644', a.dll, str(dll)], check=True)
    data = json.loads(config.read_text())
    data.setdefault('SyncService', {})['IntervalTime'] = 1
    write_json(config, data)
    if a.recent_first:
        data = json.loads(runtime.read_text()) if had_runtime else {}
        data.setdefault('HistoryWindow', {})['SortByLastAccessed'] = True
        write_json(runtime, data)
    unit('start')
    time.sleep(3)
    subprocess.run(['systemctl', '--user', 'is-active', '--quiet', a.unit], check=True)
    print('客户端已更新；备份：', backup.name)
except BaseException:
    subprocess.run(['systemctl', '--user', 'stop', a.unit], check=False)
    if (backup / dll.name).exists():
        subprocess.run(priv + ['install', '-m', '644', str(backup / dll.name), str(dll)], check=True)
    for target in (config, runtime):
        if (backup / target.name).exists():
            shutil.copy2(backup / target.name, target)
    subprocess.run(['systemctl', '--user', 'start', a.unit], check=False)
    raise

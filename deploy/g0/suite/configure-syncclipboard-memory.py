#!/usr/bin/env python3
"""为已安装 SyncClipboard 配置 GC 预算；不读取或修改账号、历史和同步配置。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime, timezone


def configure(path: Path, role: str) -> Path:
    if path.is_symlink() or not path.is_file() or not path.name.endswith('.runtimeconfig.json'):
        raise ValueError('必须指定已安装程序的常规 runtimeconfig.json 文件')
    original = path.read_bytes()
    data = json.loads(original)
    properties = data['runtimeOptions'].setdefault('configProperties', {})
    # runtimeconfig 优先于环境变量，直接配置主程序文件，确保覆盖原 Server GC。
    properties.update({
        'System.GC.Server': False,
        'System.GC.ConserveMemory': 5,
        'System.GC.HeapHardLimit': (256 if role == 'server' else 384) * 1024 * 1024,
    })
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = path.with_name(path.name + '.before-memory-' + stamp)
    shutil.copy2(path, backup)
    descriptor, temporary = tempfile.mkstemp(prefix='.memory-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        shutil.copystat(path, temporary)
        # 提权配置桌面程序时保留原属主，避免改变安装权限。
        stat = path.stat()
        if os.geteuid() == 0:
            os.chown(temporary, stat.st_uid, stat.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return backup


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=['server', 'desktop'])
    parser.add_argument('runtimeconfig', type=Path)
    args = parser.parse_args()
    backup = configure(args.runtimeconfig, args.role)
    print('已设置 GC 预算；备份文件：' + backup.name)
    print('重启对应的既有服务/客户端后生效，回滚时恢复该备份并重启。')


if __name__ == '__main__':
    main()

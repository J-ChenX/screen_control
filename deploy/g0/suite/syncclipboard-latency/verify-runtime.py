#!/usr/bin/env python3
"""用实际安装宿主和依赖验证候选核心程序集；测试仅写隔离目录。"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def verify(install_dir, core, probe):
    root, core, probe = (Path(x).resolve() for x in (install_dir, core, probe))
    for path in (root / 'SyncClipboard.Desktop.Default', core, probe):
        if not path.is_file():
            raise ValueError('缺少验证输入文件：' + str(path))
    with tempfile.TemporaryDirectory(prefix='screen-control-runtime-') as temp:
        stage = Path(temp)
        for item in root.iterdir():
            (stage / item.name).symlink_to(item, target_is_directory=item.is_dir())
        replacements = {
            'SyncClipboard.Desktop.Default': root / 'SyncClipboard.Desktop.Default',
            'SyncClipboard.Desktop.Default.dll': probe,
            'SyncClipboard.Core.dll': core,
        }
        for name, source in replacements.items():
            target = stage / name
            if target.is_symlink():
                target.unlink()
            shutil.copy2(source, target)
        env = dict(os.environ, XDG_CONFIG_HOME=str(stage / 'config'),
                   XDG_DATA_HOME=str(stage / 'data'))
        subprocess.run([str(stage / 'SyncClipboard.Desktop.Default')], cwd=stage,
                       env=env, check=True, timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', required=True)
    parser.add_argument('--core', required=True)
    parser.add_argument('--probe', required=True)
    args = parser.parse_args()
    verify(args.install_dir, args.core, args.probe)

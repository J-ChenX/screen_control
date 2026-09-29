from pathlib import Path
import os, argparse
p=argparse.ArgumentParser();p.add_argument('--release',required=True);args=p.parse_args()
home=Path.home();root=home/'.local/lib/syncclipboard';root.mkdir(parents=True,exist_ok=True);release=Path(args.release).resolve();assert (release/'SyncClipboard.Desktop.Default').is_file()
if not (root/'current').exists():(root/'current').symlink_to(release)
unit=home/'.config/systemd/user/syncclipboard-client.service';unit.parent.mkdir(parents=True,exist_ok=True)
unit.write_text('''[Unit]
Description=SyncClipboard 用户剪贴板同步
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/lib/syncclipboard/current/SyncClipboard.Desktop.Default
Environment=LANG=zh_CN.UTF-8
Environment=LANGUAGE=zh_CN:zh
Environment=MALLOC_ARENA_MAX=2
Environment=MALLOC_TRIM_THRESHOLD_=131072
Environment=MALLOC_MMAP_THRESHOLD_=131072
MemoryAccounting=yes
MemoryHigh=640M
MemoryMax=768M
MemorySwapMax=128M
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
''')
autostart=home/'.config/autostart/xyz.jericx.desktop.syncclipboard.desktop';autostart.parent.mkdir(parents=True,exist_ok=True)
autostart.write_text('''[Desktop Entry]
Type=Application
Name=SyncClipboard
Comment=用户剪贴板同步
Exec=systemctl --user start syncclipboard-client.service
Terminal=false
X-GNOME-Autostart-enabled=true
''')
launcher=home/'.local/share/applications/xyz.jericx.desktop.syncclipboard.desktop';launcher.parent.mkdir(parents=True,exist_ok=True)
launcher.write_text(autostart.read_text())
os.chmod(home/'.config/SyncClipboard/SyncClipboard.json',0o600)
print('user client installed; autostart configured; no system-level permission changes')

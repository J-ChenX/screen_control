#!/usr/bin/env bash
# 仅热更新既有 MeshAgent 单元；保留硬预算、固定工件及网络规则。
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo '需要 root 权限' >&2; exit 1; }
unit=screen-control-meshagent.service
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_file="$source_dir/60-stall-recovery.conf"
target=/etc/systemd/system/$unit.d/60-stall-recovery.conf
systemctl is-active --quiet "$unit"
[[ $(systemctl show "$unit" -p MemoryMax --value) == 805306368 ]]
[[ $(systemctl show "$unit" -p MemorySwapMax --value) == 134217728 ]]
[[ $(systemctl show "$unit" -p OOMPolicy --value) == kill ]]
[[ -f $source_file && ! -L $target ]]
backup=$(mktemp -d /var/lib/screen-control/stall-recovery-XXXXXXXX)
chmod 700 "$backup"
if [[ -e $target ]]; then cp -p -- "$target" "$backup/previous.conf"; fi
cat > "$backup/rollback.sh" <<'ROLLBACK'
#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]]
backup=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target=/etc/systemd/system/screen-control-meshagent.service.d/60-stall-recovery.conf
if [[ -f $backup/previous.conf ]]; then
    cp -p -- "$backup/previous.conf" "$target"
else
    rm -f -- "$target"
fi
systemctl daemon-reload
systemctl is-active --quiet screen-control-meshagent.service
ROLLBACK
chmod 700 "$backup/rollback.sh"
trap '"$backup/rollback.sh"; echo "热更新失败，已执行回滚：$backup/rollback.sh" >&2' ERR
install -d -m 755 "$(dirname -- "$target")"
install -m 644 "$source_file" "$target"
systemctl daemon-reload
cgroup=$(systemctl show "$unit" -p ControlGroup --value)
[[ $cgroup == /* && $cgroup != / ]]
[[ $(cat "/sys/fs/cgroup$cgroup/memory.high") == max ]]
[[ $(cat "/sys/fs/cgroup$cgroup/memory.max") == 805306368 ]]
[[ $(cat "/sys/fs/cgroup$cgroup/memory.swap.max") == 134217728 ]]
[[ $(systemctl show "$unit" -p TimeoutStopUSec --value) == 15s ]]
systemctl is-active --quiet "$unit"
trap - ERR
printf '热更新通过；回滚脚本：%s/rollback.sh\n' "$backup"

#!/usr/bin/env bash
set -euo pipefail
# 以目标普通用户安装；不创建服务、不监听端口。
if [[ "$(id -u)" == 0 ]]; then
  echo '拒绝以 root 安装文件进程' >&2
  exit 1
fi
source_binary="${1:?请指定 screen-control-files 构建产物}"
worker_root="${HOME}/.local/lib/screen-control-files"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
release_root="${worker_root}/releases/${release_id}"
install -d -m 0700 "${release_root}"
install -m 0700 "${source_binary}" "${release_root}/screen-control-files"
previous="$(readlink "${worker_root}/current" || true)"
printf '%s\n' "${previous}" > "${release_root}/previous"
ln -s "${release_root}" "${worker_root}/current.next"
mv -Tf "${worker_root}/current.next" "${worker_root}/current"
printf '普通用户文件进程已安装：%s\n' "${release_id}"

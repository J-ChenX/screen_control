#!/usr/bin/env bash
set -euo pipefail

config="${1:-${XDG_CONFIG_HOME:-${HOME}/.config}/SyncClipboard/SyncClipboard.json}"
remote_url="${SCREEN_CONTROL_CLIPBOARD_URL:?set SCREEN_CONTROL_CLIPBOARD_URL}"
if [[ ! -f "${config}" ]]; then
  printf '未找到 SyncClipboard 配置：%s\n' "${config}" >&2
  exit 1
fi

backup="${config}.before-tailscale.$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$(mktemp "${config}.tmp.XXXXXX")"
trap 'rm -f -- "${temporary}"' EXIT
cp -p -- "${config}" "${backup}"
jq --arg url "${remote_url}" '(.SavedAccounts.SyncClipboard[] | select(type == "object") | .RemoteURL) = $url' "${config}" >"${temporary}"
chmod --reference="${config}" "${temporary}"
mv -- "${temporary}" "${config}"
trap - EXIT

printf 'SyncClipboard 地址已改为 %s\n' "${remote_url}"
printf '备份位于 %s；请重启 SyncClipboard 客户端。\n' "${backup}"

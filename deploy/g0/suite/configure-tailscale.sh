#!/usr/bin/env bash
set -euo pipefail

: "${SCREEN_CONTROL_ECHOVA_DNS_NAME:?set server hostname}"
: "${SCREEN_CONTROL_NIX_DNS_NAME:?set workstation hostname}"
: "${SCREEN_CONTROL_WINDOWS_DNS_NAME:?set Windows hostname}"
: "${SCREEN_CONTROL_PHONE_HOSTNAME:?set phone hostname}"
: "${SCREEN_CONTROL_PHONE_IP:?set phone Tailscale IPv4}"

state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/screen-control"
config_root="${XDG_CONFIG_HOME:-${HOME}/.config}/screen-control"
backup="${state_root}/tailscale-serve-before-suite.json"
umask 077
mkdir -p "${state_root}" "${config_root}"

operator_user="$(tailscale debug prefs | jq -r '.OperatorUser // ""')"
if [[ "${operator_user}" != "${USER}" ]]; then
  if sudo -n true 2>/dev/null; then
    sudo tailscale set --operator="${USER}"
  else
    printf '请先运行 sudo tailscale set --operator=%s，然后重新执行本脚本。\n' "${USER}" >&2
    exit 1
  fi
fi

tailscale_status="$(tailscale status --json)"
tail_ip="$(jq -er '.Self.TailscaleIPs[] | select(contains("."))' <<<"${tailscale_status}" | head -n 1)"
tailnet_name="$(jq -er '.Self.DNSName | rtrimstr(".")' <<<"${tailscale_status}")"
resolve_stable_node() {
  local dns_label="$1"
  jq -er --arg device_name "${dns_label}" '
    [.Self, (.Peer[]?)]
    | map(select(((.DNSName // "") | split(".")[0] | ascii_downcase) == ($device_name | ascii_downcase)))
    | if length == 1 and .[0].ID != null then .[0].ID else error("missing or ambiguous registered node") end
  ' <<<"${tailscale_status}"
}

echova_node="$(resolve_stable_node "${SCREEN_CONTROL_ECHOVA_DNS_NAME}")"
nix_node="$(resolve_stable_node "${SCREEN_CONTROL_NIX_DNS_NAME}")"
jiang_node="$(resolve_stable_node "${SCREEN_CONTROL_WINDOWS_DNS_NAME}")"
xiaomi_node="$(resolve_stable_node "${SCREEN_CONTROL_PHONE_HOSTNAME}")"
jq -e --arg id "${xiaomi_node}" --arg ip "${SCREEN_CONTROL_PHONE_IP}" '[.Peer[]?] | any(.ID == $id and (.TailscaleIPs | index($ip) != null))' <<<"${tailscale_status}" >/dev/null
if jq -e --arg domain "${tailnet_name}" '(.CertDomains // []) | index($domain) != null' <<<"${tailscale_status}" >/dev/null; then
  portal_scheme="https"
  portal_tls="true"
else
  portal_scheme="http"
  portal_tls="false"
fi
lerrem_registration=""
if [[ -n "${SCREEN_CONTROL_LERREM_DNS_NAME:-}" ]]; then
  lerrem_registration=",lerrem=$(resolve_stable_node "${SCREEN_CONTROL_LERREM_DNS_NAME}")"
fi
canonical_origin="${portal_scheme}://${tailnet_name}:8444"
identity_env="${config_root}/tailscale.env"
identity_env_next="${identity_env}.next"
{
  printf 'SCREEN_CONTROL_TAILSCALE_LISTEN=%s:8444\n' "${tail_ip}"
  printf 'SCREEN_CONTROL_TAILSCALE_TLS=%s\n' "${portal_tls}"
  printf 'SCREEN_CONTROL_DEVICE_NODES=echova=%s,nix=%s,jiang-chenx=%s,xiaomi-15=%s%s\n' "${echova_node}" "${nix_node}" "${jiang_node}" "${xiaomi_node}" "${lerrem_registration}"
  printf 'SCREEN_CONTROL_CANONICAL_ORIGIN=%s\n' "${canonical_origin}"
  printf 'SCREEN_CONTROL_ALLOWED_ORIGINS=%s\n' "${canonical_origin}"
} >"${identity_env_next}"
chmod 0600 "${identity_env_next}"
mv -f "${identity_env_next}" "${identity_env}"
systemctl --user restart screen-control-suite.service

curl --fail --silent --show-error http://127.0.0.1:8790/api/v1/health >/dev/null
clipboard_code="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:5033/)"
if [[ "${clipboard_code}" == "000" ]]; then
  printf 'SyncClipboard 未在 127.0.0.1:5033 响应。\n' >&2
  exit 1
fi

tailscale serve get-config --all >"${backup}"
tailscale serve --yes --bg --http=80 http://127.0.0.1:8790
fallback="${state_root}/tailscale-serve-http-fallback.json"
tailscale serve get-config --all >"${fallback}"
restore() {
  printf 'HTTPS 尚未启用，保留可用的 Tailscale HTTP Portal。\n' >&2
  if [[ -s "${fallback}" ]]; then
    tailscale serve set-config --all "${fallback}" || true
  fi
}
trap restore ERR

if [[ "${portal_tls}" == "true" ]]; then
  timeout 30s tailscale serve --yes --bg --https=443 http://127.0.0.1:8790
  timeout 30s tailscale serve --yes --bg --https=8443 http://127.0.0.1:5033
fi

curl --retry 10 --retry-connrefused --retry-delay 1 --fail --silent --show-error "${canonical_origin}/api/v1/health" >/dev/null
identified_device="$(curl --retry 3 --retry-connrefused --retry-delay 1 --fail --silent --show-error "${canonical_origin}/api/v1/identity/device" | jq -r '.data.deviceId')"
if [[ "${identified_device}" != "echova" ]]; then
  printf '自动设备身份验证失败：期望 echova，实际 %s。\n' "${identified_device}" >&2
  exit 1
fi
if [[ "${portal_tls}" == "true" ]]; then
  clipboard_https_code="$(curl --silent --output /dev/null --write-out '%{http_code}' "https://${tailnet_name}:8443/")"
  if [[ "${clipboard_https_code}" == "000" ]]; then
    printf 'Tailscale HTTPS 剪贴板入口不可达。\n' >&2
    exit 1
  fi
  tailscale serve --yes --http=80 off
else
  clipboard_https_code="尚未启用 Tailnet HTTPS"
fi

trap - ERR
printf '统一 Portal：%s/（已自动识别设备）\n' "${canonical_origin}"
if [[ "${portal_tls}" == "true" ]]; then
  printf 'SyncClipboard：https://%s:8443/（HTTP %s 表示服务已响应，401 属于正常鉴权）\n' "${tailnet_name}" "${clipboard_https_code}"
else
  printf 'Tailnet HTTPS 尚未启用；Portal HTTP 仍由 Tailscale/WireGuard 加密，启用证书后重新运行本脚本即可升级。\n'
fi
printf '回滚备份：%s\n' "${backup}"

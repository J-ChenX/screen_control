#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/../../../.." && pwd)"
bundle_root="$(cd -- "${script_dir}/.." && pwd)"
service_root="${HOME}/.local/lib/screen-control"
unit_root="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_root="${service_root}/releases/${release_id}"

if [[ -x "${bundle_root}/bin/screen-control" && -f "${bundle_root}/share/portal/index.html" ]]; then
  binary_source="${bundle_root}/bin/screen-control"
  portal_source="${bundle_root}/share/portal"
else
  make -C "${project_root}" build
  binary_source="${project_root}/bin/screen-control"
  portal_source="${project_root}/dist/portal"
fi

# 服务不会继承调用它的 shell 环境。仅持久化
# 后端连接设置；现有凭据仍保存在安装包之外。
config_root="${XDG_CONFIG_HOME:-${HOME}/.config}/screen-control"
: "${SCREEN_CONTROL_MESH_URL:?set SCREEN_CONTROL_MESH_URL}"
mkdir -p "${config_root}"
python3 - "${config_root}/screen-control.env" <<'PYENV'
import os, pathlib, tempfile
keys = ["SCREEN_CONTROL_MESH_URL", "SCREEN_CONTROL_MESH_USER", "SCREEN_CONTROL_MESH_FILE_USER",
        "SCREEN_CONTROL_MESH_PASSWORD_FILE", "SCREEN_CONTROL_MESH_FILE_PASSWORD_FILE", "XDG_STATE_HOME"]
path = pathlib.Path(__import__('sys').argv[1])
fd, name = tempfile.mkstemp(dir=path.parent, prefix=".screen-control.env.")
try:
    with os.fdopen(fd, "w") as out:
        for key in keys:
            if key in os.environ:
                value = os.environ[key]
                if any(c in value for c in "\n\r\0"):
                    raise ValueError("multiline environment value is forbidden")
                out.write(key + '="' + value.replace('\\', '\\\\').replace('"', '\\"') + '"\n')
    os.replace(name, path)
finally:
    if os.path.exists(name): os.unlink(name)
PYENV

install -d -m 0755 "${release_root}/bin" "${release_root}/share/portal" "${unit_root}"
install -m 0755 "${binary_source}" "${release_root}/bin/screen-control"
cp -a "${portal_source}/." "${release_root}/share/portal/"
install -m 0644 "${script_dir}/screen-control-suite.service" "${unit_root}/screen-control-suite.service"
ln -sfn "${release_root}" "${service_root}/current.next"
mv -Tf "${service_root}/current.next" "${service_root}/current"

systemctl --user daemon-reload
systemctl --user enable --now screen-control-suite.service
systemctl --user restart screen-control-suite.service
curl --fail --silent --show-error http://127.0.0.1:8790/api/v1/health >/dev/null

printf 'Screen Control 已安装到 %s\n' "${release_root}"
printf '本地健康检查通过：http://127.0.0.1:8790/api/v1/health\n'
printf '下一步运行：%s/configure-tailscale.sh\n' "${script_dir}"

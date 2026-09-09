# MeshCentral G0 隔离尖峰验证

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

此镜像不用于生产部署。它在已审查并固定摘要的 Node 24.20.0 amd64 基础镜像上，通过 `package-lock.json` 固定 MeshCentral 1.2.5，并将服务器仅绑定到 `echova` 的 Tailscale 地址的 4443 端口。持久化状态位于 `echova` 上隔离的私有 G0 卷中，不得挂载现有应用或 NAS 路径。

G0 域设置 `agentNoProxy: true`。生成的代理设置必须包含 `ignoreProxyFile=1`；否则，本地 HTTP 代理可能将真实的出站连接移到 MeshAgent 进程树之外，使失败即拒绝的路径约束失效。

默认 `NODE_BASE` 使用官方清单摘要。当 Docker 守护进程无法访问 Docker Hub 时，可通过 `skopeo` 以归档方式传输完全相同的清单；使用 `--build-arg` 指定本地按内容寻址的镜像，并在构建前记录其来源清单、配置及镜像层摘要。

外层锁文件将 MeshCentral 的传递依赖 `qs` 覆盖为 6.16.0。原先解析得到的 6.15.3 受两项中危拒绝服务漏洞公告影响；此覆盖必须持续纳入启动、API、WebSocket 和代理兼容性测试。

仓库仅提交 `config.example.json`。部署前从根目录 `.env` 生成已被版本控制忽略的私有配置：

```bash
make mesh-config
./ops/with-env python3 deploy/spike/meshcentral/verify.py --private
```

系统服务配置见[环境配置](../../../docs/CONFIGURATION.md)。尖峰环境直接在 `echova` 上创建权限为 `0600` 的引导凭据文件，且仅通过标准输入传递凭据。面向用户的桌面与门户测试域名分别对应独立的精确源站。

此配置保持 URL 登录令牌禁用。候选方案通过 G0 前，`RD-01b` 必须验证第一方 POST/MessageChannel 启动交换与入口端持有的上游会话。

`echova` 的本地浏览器信任范围、已安装证书指纹和准确回滚步骤记录于 [`../../g0/meshcentral/TRUST_ECHOVA.md`](../../g0/meshcentral/TRUST_ECHOVA.md)。

## 静态验证

在复制任何文件前，从仓库根目录验证固定的软件包、无凭据配置、精确的 Tailscale 私有网络白名单以及容器隔离：

```bash
mise exec -- python3 deploy/spike/meshcentral/verify.py
docker compose -f deploy/spike/meshcentral/compose.yaml config --quiet
```

## 创建隔离的 G0 账号

先停止服务器。在关闭终端回显的情况下读取密码，经标准输入传递给禁用网络的一次性账号创建程序，清除 shell 变量，再将新建的非秘密用户名提升为管理员：

```bash
cd deploy/spike/meshcentral
docker compose down
read -r -s -p 'G0 密码：' G0_PASSWORD; printf '\n'
printf '%s' "$G0_PASSWORD" | docker compose --profile tools run --rm -T provisioner --user g0-admin
unset G0_PASSWORD
docker compose run --rm -T meshcentral --adminaccount g0-admin
```

包装脚本使用 MeshCentral 固定版本的密码实现计算哈希。明文不进入原生进程参数、环境变量、配置、URL 或输出。账号创建程序设置 `network_mode: none`，唯一的持久化写入目标是隔离的 G0 数据卷。账号已存在时，创建操作直接失败。切勿将密码粘贴到命令本身。

尖峰环境的管理操作使用 `meshctrl-secret.js`。将同一凭据以只读方式挂载到 `/run/secrets/loginpass`，仅在包装脚本后传递非秘密命令行参数。脚本在进程创建后将密码注入 JavaScript 的 argv 数组，因此明文不会出现在原生命令行或环境变量中：

```bash
docker run --rm --network host \
  -v "$HOME/.local/state/screen-control/secrets/meshcentral-g0-admin:/run/secrets/loginpass:ro" \
  --entrypoint node screen-control-meshcentral-g0:1.2.5 \
  /opt/meshcentral/meshctrl-secret.js serverinfo \
  --url wss://${SCREEN_CONTROL_ECHOVA_IP}:4443 --loginuser g0-admin
```

## 仅在 echova 上启动

配置绑定 `${SCREEN_CONTROL_ECHOVA_IP}:4443`，因此此 Compose 项目专用于该主机，在其他机器上会失败。将仓库复制到 `echova` 上隔离的 G0 路径，在该机完成验证后运行：

```bash
cd deploy/spike/meshcentral
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 meshcentral
```

停止服务时保留承载证据的命名卷：

```bash
docker compose down
```

在 G0 清理回执记录准确的卷名与哈希之前，不得使用 `down --volumes`。Compose 服务采用主机网络，因为 MeshCentral 必须绑定主机的 Tailscale 地址；`config.json` 是失败即拒绝的监听边界，容器不配置对外发布的端口映射。

## G0 通过前的剩余阻塞项

隔离服务器、三个平台代理、按进程限制为仅使用 Tailscale 的网络规则、`nix` 重启检查、后端仅桌面权限矩阵和 `echova` 本地浏览器信任锚现已实现并验证。Chromium 完全重启、`echova` 重启检查、三平台登录/锁屏/UAC 画面检查，以及第一方不经 URL 的启动交换仍阻塞 G0。不得通过绕过浏览器安全警告页、公开注册、登录令牌、仅使用 TURN 的媒体通道、隐藏界面或长期维护分叉来规避这些门控。

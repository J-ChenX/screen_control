# Screen Control

私有部署值现在通过根目录 `.env` 加载；配置步骤、系统服务和 Windows 说明见 [配置指南](docs/CONFIGURATION.md)。公开示例见 [.env.example](.env.example)。

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

这是一个供三台已登记 Tailscale 电脑与 xiaomi-15 手机使用的私人网页远控项目。当前已经提供 G0 实机桥接：门户会从 MeshCentral 读取 `echova`、`nix`、`Jiang_ChenX` 的权威在线状态，并可在自有桌面视图中建立真实画面、输入与文件通道。

这仍不是生产服务：正式身份模块、统一文件数据面、独立桌面源站、生产级会话/租约与完整 G0/G3 证据门尚未完成。统一套件只绑定回环地址，再由 Tailscale Serve 暴露给 Tailscale 私有网络；不要绑定 `0.0.0.0`，也不要暴露到局域网或公网。

## 环境要求

- `mise`
- GNU Make
- Docker（仅运行 MeshCentral G0 尖峰时需要）

项目由 [.mise.toml](.mise.toml) 固定 Go 1.26.8 和 Node.js 24.20.0，前端由 `web/package.json` 固定 pnpm 11.25.0。不要用系统中的近似版本替代正式验证。

## 第一次安装

```bash
make setup
```

该命令安装锁定的 Go/Node 工具链，并按锁文件安装前端依赖。

## 启动 G0 门户

```bash
make dev
```

`make dev` 会同时启动 `127.0.0.1:8787` 的 Go 桥接后端、兼容跳转入口和仅绑定 Tailscale IP 的门户；关闭命令时三者会一起退出。

开发模式入口为 `${SCREEN_CONTROL_DEV_ORIGIN}`；日常使用请优先采用下方不带端口的统一套件入口。

`http://127.0.0.1:5173` 只保留为本机开发兼容地址，打开时会以 `308` 跳转到上述统一入口；它不再作为用户入口记录或分发。

统一入口的 TCP 流量由 Tailscale WireGuard 隧道加密。当前已启用 Tailscale HTTP Serve；Tailscale 私有网络管理端尚未启用 HTTPS 证书，因此管理员授权前浏览器地址仍是 HTTP。若 Windows 开启了系统代理，需将 `*.your-tailnet.ts.net` 放入代理例外；当前登记的 Windows 设备已经配置。

桥接后端通过配置连接 `${SCREEN_CONTROL_MESH_URL}`。桌面通道使用禁止文件和终端权限的 `g0-desktop`；文件通道使用允许文件、禁止终端并仅可查看桌面的 `g0-files`。两个密码分别从权限为 `0600` 的 `${SCREEN_CONTROL_MESH_PASSWORD_FILE}` 和 `${SCREEN_CONTROL_MESH_FILE_PASSWORD_FILE}` 读取。可通过对应的 `SCREEN_CONTROL_MESH_*` 环境变量覆盖；不要把密码写进命令行、URL 或仓库。

文件页当前直接接入 MeshCentral 文件协议，可在目标普通用户权限内浏览磁盘、刷新、新建目录、重命名、上传、下载与永久删除。覆盖必须确认，永久删除必须选择目标并输入“删除”；G0 下载为浏览器内存聚合，单文件上限 512 MB。它不包含生产文件数据面计划中的回收站、断点续传、哈希校验和跨设备复制。

也可以预览生产构建：

```bash
make build
make preview
```

然后三台设备统一打开 `${SCREEN_CONTROL_PREVIEW_ORIGIN}`；本机 `http://127.0.0.1:4173` 仅作兼容跳转。构建产物 `bin/screen-control --serve` 可单独运行桥接后端；不带参数时只输出构建信息。

## 安装统一 Tailscale 套件

日常使用推荐安装统一套件，不再分别启动 Go 和 Vite：

```bash
make install-suite
make configure-tailscale
```

安装完成后，三台设备统一打开 `${SCREEN_CONTROL_CANONICAL_ORIGIN}/`；当前 Tailscale 私有网络尚未启用证书，HTTP 正文仍由底层 Tailscale/WireGuard 加密，启用证书并重新运行配置脚本后同一入口自动升级为 HTTPS。旧的默认端口入口只负责把浏览器导航到这个直接 Tailscale 入口。门户根据真实套接字对端调用 LocalAPI `WhoIsForIP`，把 Tailscale 稳定节点 ID 映射为登记设备，不再要求浏览器手工选择，也不接受前端自报的当前设备。SyncClipboard 继续以独立侧车运行。

另外两台设备的 SyncClipboard 只需迁移一次服务器地址；Linux 和 Windows 脚本及回滚说明位于 `deploy/g0/suite/`。在三台设备都完成迁移前保留 cpolar，可避免剪贴板中断。详细说明见 `deploy/g0/suite/README.md`。

也可生成一个可搬运的安装包：

```bash
make bundle
```

产物为 `dist/screen-control-suite.tar.gz`。

## 验证

```bash
make test
make verify
```

`make test` 运行 Python 运维/安全测试、Go 普通与竞态测试、前端测试和类型检查；`make verify` 额外检查锁定工具链和验证场景模式定义。

## MeshCentral G0 尖峰

尖峰配置位于 `deploy/spike/meshcentral/`。当前门户使用该环境完成 G0 实机桥接，但它只允许在 `echova` 的隔离环境中运行，不能视为生产部署。先阅读该目录 README 并执行静态校验：

```bash
mise exec -- python3 deploy/spike/meshcentral/verify.py
```

真实 G0 会修改三台机器的服务/网络状态并包含重启，必须按 `docs/tasks/private-web-remote-remote/_INDEX.md` 的八个工作包逐项执行和留存签名证据。

## 项目入口

- 架构与当前状态：`docs/ARCHITECTURE.md`
- 当前任务指针：`docs/tasks/_ACTIVE.md`
- 完整需求：`docs/tasks/private-web-remote/_INDEX.md`
- 远控 G0：`docs/tasks/private-web-remote-remote/_INDEX.md`
- 验证入口：`ops/verify/run`

## 手机控制端 xiaomi-15

已登记手机：`xiaomi-15`，Tailscale IPv4 `${SCREEN_CONTROL_PHONE_IP}`。身份通过 Tailscale 稳定节点 ID 验证，IP 只用于接入核对。手机不安装 MeshAgent，不出现在被控电脑或远程文件代理列表中。

手机连接 Tailscale 后打开 `${SCREEN_CONTROL_CANONICAL_ORIGIN}/`。可控制三台电脑；轻触点击、按住拖动，触屏工具栏提供右键、滚动、常用按键和文字发送。文件页沿用浏览器文件选择上传、下载与电脑间复制，单文件上限仍为 512 MB；其他电脑不能直接浏览手机存储，手机文件由手机用户主动选择上传。

剪贴板沿用同一 SyncClipboard 服务和原有账号。当前已运行的 Tailscale TCP 转发入口是 `${SCREEN_CONTROL_CLIPBOARD_URL}`，启用 HTTPS 后可使用 `${SCREEN_CONTROL_CLIPBOARD_URL}`。手机需安装与现有服务器版本兼容的 Android 客户端，填写相同服务地址及账号；请参照 [SyncClipboard Android 文档](https://github.com/Jeric-X/SyncClipboard#android)。手机端后台同步能力取决于客户端与系统权限，浏览器页面不承担后台剪贴板同步。

## 可选 HTTPS 公网网关

为浏览器跨 VPN/代理网络访问增加了独立鉴权入口，默认关闭。该入口使用每设备随机访问密钥与 8 小时登录 Cookie，统一代理网页、API 和 WebSocket；原 Tailscale 私有入口继续保留。公网域名和反向隧道尚需配置，不能直接公开旧 G0 入口。部署、撤销和实际限制见 [HTTPS 网关说明](deploy/gateway/README.md)。

## 开源协议

本项目自有代码采用 [MIT 协议](LICENSE)，版权归 Nix Jiang 所有。第三方依赖及其资源仍遵循各自的许可证。

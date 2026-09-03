# 环境与验证审计

审计时间：2026-09-02 18:08–18:27、2026-09-03 路由/代理复测及 `IO-01a` bootstrap preflight（CST，Asia/Shanghai）  
用途：记录当前事实和复现证据，不作为未来目标定义。权威需求见 [_INDEX.md](_INDEX.md)。

## 1. 三台设备现状

| 设备 | 在线 | 桌面/显示 | Tailscale 路径 | 已验证事项 |
|---|---|---|---|---|
| `nix` `100.64.0.10` | 是 | Ubuntu 22.04，Xorg `:1`，`2880×1800@60` | 本机 | 重启后 Xorg 生效；SyncClipboard 自启动；尚无远控代理 |
| `echova` `100.64.0.20` | 是 | Ubuntu 22.04.5，X11 `:1`，`3840×2160@119.88` | 曾直连约 13–22 ms；12:30 复测为 DERP(hkg) | SSH、桌面、SyncClipboard 服务、NAS 可访问；尚无远控代理 |
| `jiang-chenx` `100.64.0.30` | 是 | Windows，`3840×2160`（用户确认） | DERP(hkg)，约 428–456 ms | 仅验证 Tailscale 在线；尚未安装/验证远控代理 |

- MagicDNS 后缀为 `example.ts.net`；设备名分别为 `nix`、`echova`、`jiang-chenx`。

### 1.1 SSH 连接手册

以下连接于 2026-09-03 从 `nix` 使用现有 SSH 密钥和 `BatchMode=yes` 实测成功。`operator` 是 Windows 登录用户名，不是端口；两台远端均使用 SSH 默认端口 `22`。

| 角色 | SSH 用户 | Tailscale 地址 | Tailscale 名称 | 系统主机名 | 标准连接命令 |
|---|---|---|---|---|---|
| 主服务器 | `echova` | `100.64.0.20` | `echova.example.ts.net` | `echova` | `ssh -p 22 operator@100.64.0.20` |
| Windows 电脑 | `operator` | `100.64.0.30` | `jiang-chenx.example.ts.net` | `Jiang_ChenX` | `ssh -p 22 operator@100.64.0.30` |

- 自动化探测使用 `-o BatchMode=yes -o ConnectTimeout=8`，不得在文档、命令历史或日志中写入密码/私钥。
- 首次遇到新主机名或主机密钥变化时必须核对身份，禁止用 `StrictHostKeyChecking=no` 绕过验证。
- `echova` 项目部署目录为 `/home/operator/code/screen_control`，NAS 数据目录为 `/home/operator/nas`。
- Windows 端实测 `whoami` 返回 `jiang_chenx\operator`，`hostname` 返回 `Jiang_ChenX`；命令执行仍受普通用户 `operator` 的系统权限约束。

### 1.2 G0 前基线缺口（事实）

当前审计足以证明三机可达，但尚未形成同一时点、同一 schema、可签名复算的 G0 environment snapshot。以下缺口必须由只读 `IO-01a` 补齐；本表只记录“已知/未知”，不以文档猜测机器值。

| 类别 | `nix` | `echova` | `jiang-chenx` | 当前缺口 |
|---|---|---|---|---|
| OS/内核/架构/启动 | Ubuntu 22.04、Xorg 已知 | Ubuntu 22.04.5 已知 | 仅 Windows 已知 | 精确 build、kernel、arch、boot ID 未统一采集 |
| 显示/缩放/session | Xorg `:1`、2880×1800 已知 | X11 `:1`、3840×2160 已知 | 3840×2160 为用户确认 | 三机缩放、GPU、驱动、硬件/软件编码器和登录前 session 未统一采集 |
| 浏览器/自动化 | 未锁定 | 未锁定 | 未锁定 | 浏览器与 driver 精确版本、策略、WebRTC 能力未知 |
| Tailscale | 地址/部分路径已知 | 地址/部分路径已知 | 地址/DERP 已知 | daemon/CLI build、接口 ID、路由/Grants snapshot、UTC 同步未统一采集 |
| 防火墙/进程限制 | UFW 未启用 | UFW 未启用 | 未采集 | nft/cgroup-BPF、Windows Firewall 按程序/适配器能力及现有规则 hash 未验证 |
| 救援/自动回退 | SSH 可达 | SSH 可达 | SSH 可达 | 尚无独立救援复核、定时 watchdog 或故意失联后的自动回退证据 |
| 工具链/空间/端口 | 部分事实 | Docker/磁盘/8080/5033 已知 | 未采集 | Git/Go/Node/PowerShell/抓包/媒体工具、完整监听与临时空间未统一锁定 |

`IO-01a` 只能执行无副作用的版本、状态、能力和监听查询，输出须脱敏；不得安装软件、改 Grants、改防火墙、重启或开放端口。`IO-01d` 在独立救援和定时回退已就绪后才演练网络变更保护；在它通过前，`RD-01a-L`/`RD-01a-W` 不得执行系统级规则改动。完整字段与命令/证据契约见[验证工程策略](../../appendix/verification-strategy.md)。

### 1.3 `IO-01a` 最新 bootstrap 结果

当前通过的 candidate run `io-01a-20260903T101743.195837Z-bdd8888321` 已用固定 hash recorder 对三机执行 113 个白名单只读探针，92 个成功；其余为明确记录的可选工具缺失。三机十类必填语义事实均完整，UTC 偏差分别约 `nix -0.000 s`、`echova -0.040 s`、`jiang-chenx -0.047 s`，三机同步健康均通过。bundle SHA-256 为 `fa3b369e9414e4e02c7e8cc90d56686ffe76c32c8ef65109da4f97ecc33a3a05`，environment snapshot hash 为 `27bee2493cbdf722b494f649897ceccbab0875cbaad47f6d748dccf178b6c388`；verifier 对完整性、provenance、当前 recorder 匹配和受信状态均返回 true。本 bundle 仍是待 `IO-01c` 导入重验的 hash-sealed bootstrap 输入，不是正式签名证据。

此前 Windows Time 使用手动启动、单一 `time.windows.com,0x9`，状态为 Leap Indicator 3、Stratum 0、来源 Local CMOS Clock 且无成功同步；实测 UDP NTP 可达性后，已把 W32Time 设置为自动启动并配置 `ntp.aliyun.com,0x9 time.cloudflare.com,0x9` 双 peer，重启服务并执行强制重新发现/同步。整改后来源为 `ntp.aliyun.com,0x9`、Leap Indicator 0、Stratum 4，实测 phase offset 约 `0.000489 s`。若新配置在后续观察中不稳定，回滚为原 peer `time.windows.com,0x9` 和手动启动；任何回滚后仍须重新通过三样本偏差与同步健康门。该环境变更独立于只读 recorder，前后状态均在本节记录。

## 2. `nix` 重启与 Xorg 验证

- 本次系统启动时间：2026-09-02 18:08:08。
- `XDG_SESSION_TYPE=x11`，`loginctl` 的活动用户会话类型为 `x11`。
- `/etc/gdm3/custom.conf` 已设置 `WaylandEnable=false`、`DefaultSession=ubuntu-xorg.desktop`。
- 原配置备份：`/etc/gdm3/custom.conf.codex-backup-20260902`。
- Xorg 登录已通过；登录界面和锁屏状态的远程控制要等 MeshAgent 安装后执行 A03/A04 验收。

## 3. SyncClipboard 现状

### 3.1 已通过

- 两台 Ubuntu 的客户端和 `echova` 服务端版本均为 3.1.5。
- `nix` 原配置备份：`/home/operator/.config/SyncClipboard/SyncClipboard.json.bak-win-v-20260902`。
- `echova` 原配置备份：`/home/operator/.config/SyncClipboard/SyncClipboard.json.bak-win-v-20260902`。
- `echova` 本次快捷键迁移前备份：`/home/operator/.config/SyncClipboard/SyncClipboard.json.bak-gnome-hotkey-20260903` 与 `/home/operator/.config/autostart/xyz.jericx.desktop.syncclipboard.desktop.bak-gnome-hotkey-20260903`。
- `nix` 重启后由 `~/.config/autostart/xyz.jericx.desktop.syncclipboard.desktop` 自动启动；自启动与快捷键命令均固定 `zh_CN.UTF-8`，进程运行于 `DISPLAY=:1` 并使用 `xclip`。
- 2026-09-03 再次复现应用内热键失效后，已清除 `nix` 的内部 `OpenHistoryPanel` 按键，改为 GNOME 持久绑定 `<Super>v` 到官方 `--command-OpenHistoryPanel` 入口；从未映射窗口实测 1 秒内变为可见，应用未运行时该入口也可启动后执行。
- `echova` 已完成同构迁移且保留原有 `Ctrl+Q` 自定义绑定；官方命令实测打开标题为“历史记录”的中文窗口。桌面客户端有登录自启动项，两机的自启动与命令进程均固定中文 locale。
- 当前客户端配置的公网 URL 和 Tailscale 直连 `http://100.64.0.20:5033/SyncClipboard.json` 均能以现有凭据返回 200。
- 审计时本机剪贴板文本与远端当前文本长度、SHA-256 和内容均一致，证明实时文本链路在启动瞬间的 401 后已恢复。

### 3.2 未通过与风险

- `nix` 的 3.1.5 应用内 `Meta+V` 在连续运行约 18 小时后再次失效，与官方 #266 的复现描述一致；3.1.5 虽声明修复 Linux 热键过期键清理，本机证明不能再把该内部注册作为唯一入口。两台 Ubuntu 的 GNOME 命令绑定已通过即时验证，仍须完成 A13 的登录、锁屏恢复和 24 小时验证。
- 历史/文件传输队列持续出现 `Group data hash mismatch`、`Hash mismatch`、`Needs transfer data` 和本地历史文件缺失；连续失败后队列会停止。实时文本可用不代表历史/文件同步健康。
- 启动时 SignalR WebSocket 曾返回 401，随后轮询/当前文本恢复；需在集成健康检查中单独展示事件通道状态。
- 官方最新稳定版已到 3.2.0（2026-08-15），但升级不能代替本次稳定绑定，也不能在三端和服务端之间无验证地滚动。实施前须备份配置、数据库和历史文件，以一致版本完成兼容、回滚及 A13 验证后再迁移。
- `nix` 与 `echova` 的桌面配置都开启了内置服务器；`nix` 因此额外监听 `*:5033`，而 `echova` 的独立服务端也监听 `*:5033`。客户端内置服务器若无用途应在迁移验证后关闭。

## 4. 常驻主机与存储

- `echova` 自 2026-08-31 02:00:42 运行；用户 `echova` 已启用 systemd linger。
- `syncclipboard.service` 已启用并自启动，自主机启动后约 4 秒运行至今。
- 远端目标目录 `/home/operator/code/screen_control` 尚不存在；父目录 `/home/operator/code` 为 `echova:echova` 可写。
- Docker 29.6.1 可用；宿主 Node.js 为 12.22.9，低于当前 MeshCentral 1.2.5 声明的 Node.js 20 最低版本。
- 评估日 Docker Engine 29.x 当前维护版为 29.7.2；29.6.1 是待升级的环境事实，不是目标基线。升级与 Compose/备份恢复回归由 `operations` 门负责。
- TCP 8080 已由无关项目 `/home/operator/code/new_s0-s1` 的 uvicorn 服务占用，不能复用或修改。
- `/home/operator/nas` 是本机 ext4 普通目录，权限 `drwxrwxr-x echova:echova`。
- `/home/operator/nas` 约 30 GB，包含约 38,578 个文件与 4,004 个目录，其中 3 个文件大于 3 GiB；当前未发现符号链接。
- 所在磁盘约 1.9 TB，已用约 221 GB，可用约 1.6 TB；inode 使用率约 1%。
- `/home/operator/.local/share/Trash/{files,info}` 存在、归 `echova` 所有且权限为 0700；尚未对真实 NAS 数据执行破坏性回收站测试。

## 5. 当前暴露面

| 发现 | 当前事实 | 当前风险与架构入口 |
|---|---|---|
| 公网隧道 | `https://legacy-tunnel.example/SyncClipboard.json` 有公网 DNS 且可达，未认证请求返回 401 | 公网暴露待迁移；处理顺序与退出证据见 [全局关注点 §6](../../appendix/global-concerns.md) |
| SyncClipboard 端口 | `nix` 和 `echova` 均有 `*:5033` 监听 | 存在多余监听；最终入口和清理责任见 [架构全景](../../ARCHITECTURE.md) 与 [全局关注点 §6](../../appendix/global-concerns.md) |
| 主机防火墙 | 两台 Ubuntu 的 UFW 均未启用 | 不能依赖单层主机防火墙；目标安全边界见 [权威需求 §5](_INDEX.md) |
| Tailnet 范围 | 当前能确认三台设备在线，无法从主机证明管理后台已拒绝其他 Tailnet 设备 | A01 尚无策略证据；身份与 Grants 落点见 [架构全景](../../ARCHITECTURE.md) |
| Windows 链路 | 审计时只能经 DERP(hkg)，约 428–456 ms | A07/N02 风险；选路契约与验证见 [NETWORK_ROUTING.md](NETWORK_ROUTING.md) |

### 5.1 A01 负测主体可用性

审计时没有可安全复用的“其他 Tailnet 设备”或公网探针，也没有隔离保存的已失效旧节点身份；因此三台已登记设备在线不能作为 A01 拒绝证据。第四阶段由 `IO-01c` 创建、由 `PC-10` 使用并销毁以下专用夹具：

| 夹具 | 当前事实状态 | 约束/证据 |
|---|---|---|
| 临时未登记 Tailnet 节点 | 未创建 | 无生产 tag/capability、无应用登记；不得扩大生产 Grants；测试后注销并保留销毁回执 |
| 失效旧节点身份 | 未创建 | 临时节点先登记后撤销/重登记；旧证书/节点 ID 只存隔离证据仓，用于旧身份拒绝 |
| 非 Tailnet 公网探针 | 未创建 | 一次性 runner/受控主机，不持项目凭据；验证公网 DNS/IP/Host/Origin/转发头均不能形成有效会话 |

不得使用第三方真实设备或未知 Tailnet 成员做负测。夹具 schema、租期和清理规则以[验证工程策略 §5](../../appendix/verification-strategy.md)为唯一规范。

## 6. 尚未执行的验收

- MeshCentral 服务器和三台 MeshAgent 尚未安装，因此登录界面、锁屏、UAC、1080p 编码上限、无音轨和鼠标映射仍待实现后验收。
- 私人网页、7 天登录会话、应用层 IP 白名单、三机统一文件 API、大文件断点续传和操作日志均尚未实现。
- 未创建、移动、覆盖或删除 `/home/operator/nas` 的既有数据；回收站与大文件测试必须使用隔离测试目录。
- Windows 的确切版本、服务安装状态和屏幕模式要在代理安装阶段自动采集，文档不臆测。

### 6.1 A07 现有数据不可替代业务统计

本审计中的 13–22 ms、428–456 ms 和 DERP/direct 记录来自 `tailscale ping`，只说明历史网络映射，不能作为 A07 业务控屏 RTT 或丢包证据。A07 必须在 G3 对六条有向旅程分别采集：稳定后预热 30 秒、1 Hz 连续 600 秒，以 WebRTC selected candidate pair 的 `currentRoundTripTime` 为首选，逐旅程计算 nearest-rank P95 和窗口计数器丢包率；每条都须满足 P95 ≤150 ms、丢包 ≤1% 且 10 分钟无断线。缺样、计数器重置或旅程拼接均失败。唯一计算口径和原始工件要求见[验证工程策略 §6](../../appendix/verification-strategy.md)。

## 7. 复现指针与来源

- 18:08–18:14，`nix`：`echo "$XDG_SESSION_TYPE"` 和 `loginctl show-session` 均为 `x11`；`xrandr` 为 `2880×1800`；进程 2446 由 GNOME 登录自启动。
- 18:14–18:22，`nix → echova`：`tailscale ping` 为 direct，约 13 ms；`nix → jiang-chenx` 连续三次为 `DERP(hkg)`，428–433 ms，未升级为 direct。
- 2026-09-03，`nix` 为 `192.0.2.10/24`；`echova` 为 `192.0.2.20/24`（以太网）及 `192.0.2.21/24`（Wi-Fi）。`nix → echova` 首次 DERP(hkg) 约 880 ms，随后为全局 IPv6 direct 约 22 ms；`nix → jiang-chenx` 三次 DERP(hkg) 为 456/437/430 ms。完整验收契约见 [NETWORK_ROUTING.md](NETWORK_ROUTING.md)。
- 2026-09-03 12:30，`nix` 与 `echova`：查询可执行文件、system/user service 单元和进程均未发现 MeshAgent/MeshCentral/本项目远控服务；`tailscale status` 此时显示 `echova` 经 DERP(hkg)。
- 2026-09-03，`nix → echova` 通过 `ssh -p 22 operator@100.64.0.20` 验证为 `echova@echova`；`nix → jiang-chenx` 通过 `ssh -p 22 operator@100.64.0.30` 验证为 `jiang_chenx\operator@Jiang_ChenX`。
- 18:14–18:22，`nix` 与 `echova`：`tailscale netcheck --format=json` 均为 UDP/IPv4/IPv6 true、`MappingVariesByDestIP=false`。
- 18:14–18:22，`echova`：`systemctl --user status syncclipboard.service` 为 enabled/active，自 2026-08-31 02:00:46 运行；`ss -lntp` 显示 `*:5033`。
- 18:14–18:22，`echova`：`find -xdev` 汇总为 38,578 文件、4,004 目录、0 符号链接、3 个文件大于 3 GiB；`df` 显示约 1.6 TB 可用。
- 18:22–18:27，`nix`：关闭 GNOME 兜底绑定，重启 SyncClipboard 后以 `xdotool` 发送 X11 Super+V，历史窗口由未映射变为可见；远端当前文本与本机剪贴板内容、长度和 SHA-256 均相同。
- SyncClipboard 官方命令入口说明：<https://github.com/Jeric-X/SyncClipboard#--command-command-name>；Ubuntu 长时间运行后热键失效问题：<https://github.com/Jeric-X/SyncClipboard/issues/266>；3.1.5 的对应修复记录：<https://github.com/Jeric-X/SyncClipboard/blob/master/Changes.md#v315>；当前 3.2.0 发布页：<https://github.com/Jeric-X/SyncClipboard/releases/tag/v3.2.0>。
- MeshCentral 项目：<https://github.com/Ylianst/MeshCentral>；审计时 1.2.5 的 `package.json` 要求 Node.js 20 或更高：<https://raw.githubusercontent.com/Ylianst/MeshCentral/1.2.5/package.json>。
- MeshAgent 项目说明：<https://github.com/Ylianst/MeshAgent/blob/master/readme.md>。
- MeshAgent 官方说明列出了 Linux 登录界面黑屏/Xauthority 的 Xorg 配置建议，但登录前桌面能力仍须逐机验证：<https://github.com/Ylianst/MeshAgent#special-note-about-kvm-support-on-linux>；仍有登录前无 Desktop 入口的公开未解决报告：<https://github.com/Ylianst/MeshAgent/issues/260>。
- 当前暴露面核查涉及的 Tailscale Grants：<https://tailscale.com/docs/features/access-control/grants>；连接类型和选路依据只在 [NETWORK_ROUTING.md](NETWORK_ROUTING.md) 维护。

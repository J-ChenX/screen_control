# 环境与验证审计

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

审计时间：2026-09-02 18:08–18:27、2026-09-03 路由/代理复测及 `IO-01a` 引导 preflight、2026-09-04 项目同步与构建复验（CST，Asia/Shanghai）
用途：记录当前事实和复现证据，不作为未来目标定义。权威需求见 [_INDEX.md](_INDEX.md)。

## 当前常驻服务端（2026-10-19）

用户确认唯一常驻服务端已由 `echova` 调整为 `lerrem`。本次在 `lerrem` 只读核对：门户 `screen-control-suite.service`、SyncClipboard 服务端 `syncclipboard.service` 与客户端 `syncclipboard-client.service`、系统级 MeshCentral 和 MeshAgent 均为运行状态。门户通过现有私有入口返回健康状态 `ok`，本机身份接口返回 `lerrem`；后端配置的 MeshCentral 地址解析到 `lerrem` 的 Tailscale 地址。

已安装的指标配置以 `lerrem` 为本机，SSH 指标目标包含其他三台电脑；普通用户文件目标包含四台电脑，Tailscale 身份映射包含四台电脑与 `xiaomi-15`。实际域名、地址和 SSH 账号继续保存在既有私有配置中，不从下面的旧审计恢复。此次角色调整不迁移 `echova:$HOME/nas` 数据，也不重写历史工件或宣告 G0/G3 正式验收通过。

本次修正前后端设备角色与 Tailscale 配置脚本自检，并以隔离检出核对修改前的二进制、门户首页及其引用资源与线上一致，保留已上线 GPU 修复。相关 Go 包、74 项前端测试、类型检查、构建、3 项隔离身份配置测试及公开 MeshCentral 静态校验通过；环境配置测试 7 项通过、PowerShell 项因运行时未安装跳过。仅更新并重启既有门户后，私有入口健康、`lerrem` 身份、四设备角色和静态资源均通过；系统 Chrome 153.0.8010.52 在 1440×960 与 390×844 视口实测角色显示正确（非锁定 Playwright Chromium 验收）。原二进制、门户资源和可执行回滚脚本保存在宿主私有 state 的 `screen-control/repairs/server-role-*` 目录。MeshCentral 与 SyncClipboard 未随本次更新重启。

主页直连测试于 2026-10-19 部署：`lerrem` 门户本机直接探测，`echova`、`nix` 与 Windows 安装固定的一次性只读探针，Windows 通过 `echova` 的既有 SSH 运维入口启动；实际探测仍在 Windows 上执行。未修改 SSH 授权、防火墙、Tailscale 配置或服务角色，未新增监听和常驻服务。私有映射位于 `network.env`，安装和回滚见[直连测试说明](../../../deploy/g0/network/README.md)。线上浏览器实际启动一轮检测，12 个方向、每方向 5 次均返回已核验的直连响应；先前独立检查曾出现 `nix → Windows` 短暂 DERP，因此结果仅代表检测时的网络状态。

该功能通过隔离线上基线构建发布：Go 全包测试、相关竞态、74 项前端测试、类型检查、环境配置 7 项及 Tailscale 配置 3 项通过；PowerShell 运维测试因本机缺少运行时跳过。系统 Chrome 153.0.8010.52 完成 1440、390、320 像素隔离交互检查，线上 1440 与 390 像素检查及私网健康、来源身份、四设备状态通过；不作为锁定 Playwright Chromium 或 G0/G3 正式验收。只重启既有门户，回滚备份保存在宿主私有 state 的 `screen-control/repairs/network-test-*` 目录。

同日补充实际直连端点的 IPv4/IPv6 字段，门户和三台远端探针均已更新；界面细分局域网 IPv4、局域网 IPv6、公网 IPv4、公网 IPv6，旧探针缺少协议族时明确提示未知。更新前的二进制和门户基线完全匹配，相关 Go 全包／竞态、前端测试、类型检查及四种标签的桌面／手机场景通过；线上重测 12 个方向均取得协议族，本轮为 4 个局域网 IPv4、8 个公网 IPv6。该次结果不承诺后续路径保持不变，备份与按“先探针、后门户”顺序执行的回滚保存在私有 state 的 `screen-control/repairs/network-path-detail-*` 目录。

下列各节保留 2026-09-02 至 2026-09-04 的原始审计范围；其中“主服务器”“常驻主机”、在线状态、部署路径和端口占用均为当时事实。当前部署应先核对此节与已安装服务，再使用私有配置。

## 桌面自适应更新（2026-10-20）

用户试用固定 1080p 后要求优质网络保留 2K。此前观察版已回滚，最终工件采用最高 2560×1440、Q90，降级 1080p／720p／540p；同尺寸源直接复制，不修改显示模式。当前 lerrem、echova 原生工件、适用范围和验证摘要见[自适应清单](../../../deploy/g0/meshagent/rust-native/adaptive-runtime-manifest.json)，实现及限制见[自适应说明](../../performance/DESKTOP_ADAPTIVE.md)。

两台在线 Linux 设备通过既有十分钟自动回退、固定摘要与防火墙健康核对后保留新版；身份和限制保留。Windows 浏览器实际控制 lerrem，四档切换及恢复 2K、大面积合成运动和逐帧指针映射通过；控制 echova 的 2K／异常恢复冒烟通过。nix 离线未更新，Windows 被控原生代理未更新，不宣称覆盖旧代理的首帧限制或完整整帧能力。门户只发布本次静态资源，服务 PID 与重启计数未变。

历史 G0/G3 门和旧签名证据没有更新为通过；本次为当前桥接的可回滚运行改进。

同日补充右上角分辨率选择（默认自动，另有 1440P／1080P／720P）和桌面、手机共用的画面移动模式。97 项前端测试、类型检查、生产构建，以及 1440×900、375×812、812×375、320×700 隔离浏览器交互检查通过。Chromium 151.0.7922.34 经现有 HTTPS 入口连接 echova，实测三个固定档位分别展示 2560×1440、1920×1080、1280×720，恢复自动与放大后拖动通过；验证未向目标发送键鼠输入，不代表其他目标或 G0/G3 正式验收通过。发布前隔离构建逐文件复现线上首页和资源，再仅合入本次前端修改；门户 PID 与重启计数未变，HTTPS 健康和全部静态资源摘要通过。回滚首页及验证记录保存在宿主私有 state 的 `screen-control/repairs/desktop-resolution-*` 目录，旧资源保留。

缩放随后增加 100%–800% 滑动条，实时显示比例并保留“适应”和“＋／−”。97 项前端测试、类型检查、构建和上述四种视口的滑动条、键盘、双指同步及移动检查通过；经同一 HTTPS 入口实测 echova 的 237% 缩放和恢复通过。仅发布本次静态资源，门户未重启，健康及资源摘要通过；回滚保存在私有 state 的 `screen-control/repairs/desktop-zoom-slider-*` 目录。

自动模式随后优化短时反馈尖峰和单纯编码耗时导致的过度降档，增加连续样本、稳定观察与升档失败退避；严重本地积压保护保留。102 项前端测试、类型检查、构建、桌面／手机回归通过；同一 60 秒尖峰回放的切档次数由 21 次降至零。当前 HTTPS 入口连接 echova 连续刷新 20 秒、82 个独立帧保持 1440p；该观察不代表所有设备与实际低带宽场景验收。仅发布本次静态资源，健康、资源摘要及门户 PID／重启计数通过；回滚和独立验证记录在私有 state 的 `screen-control/repairs/desktop-adaptation-stable-*`，详情见[策略补充](../../performance/DESKTOP_ADAPTIVE.md#自动策略稳定性补充2026-10-20)。

随后按用户要求进一步放宽清晰优先降档，并引入浏览器本地低分辨率画面变化量检测：静态／小范围变化保留更高分辨率，大面积持续变化且展示或处理延迟超限时更早降档；无可靠活动信号时采用 240ms／三秒条件。低动态恢复门槛相应放宽，让动态结束后的中等延迟画面也能逐级恢复清晰。114 项前端测试、类型检查、隔离构建及实际 JPEG／画布自动策略和桌面／手机回归通过。只发布本次门户资源，HTTPS 健康、资源摘要及 PID／重启计数通过，未更新代理。备份与可执行回滚保存在私有 state 的 `screen-control/repairs/desktop-adaptation-tolerance-*`，适用范围见[活动量策略补充](../../performance/DESKTOP_ADAPTIVE.md#画面活动量与清晰优先补充2026-10-20)；不宣称真实低带宽和长期正式验收通过。

## Windows 单屏选择（2026-10-20）

Windows 门户默认选择第一块实际屏幕，顶部可切换单屏；选择配置在本页面自动重连时保留。复用现有代理的屏幕枚举、物理尺寸和切换命令，未更新 Windows 原生工件或修改显示模式。确认前隐藏旧画面并禁止输入，同尺寸切换也作废旧解码；按物理尺寸计算单屏缩放，避免沿用合并桌面宽度。

124 项前端测试、类型检查、隔离生产构建和相关画质、锁屏退出、桌面／手机回归通过；新增单屏场景覆盖 1440×900、390×844、844×390、320×700 及手机全屏工具栏。锁定 Chromium 151 的真实 HTTPS 导航返回空 502，隔离测试正常；实机改用系统 Chrome 153.0.8010.52，经当前 HTTPS 入口完成 Windows 两块 3840×2160 屏幕的 1→2→1 切换、1080P／720P 与恢复自动。代理实际选择及新画面均确认，自动档保持 2557×1438（旧协议比例取整）；未发送键鼠、未保存画面。该记录不替代锁定浏览器实机或 G0/G3 正式验收。

发布前以隔离源码逐文件重建线上基线，仅合入本次单屏变更；只发布门户静态资源。发布后重复 Windows 实测通过，HTTPS 健康、资源摘要、门户 PID 与重启计数通过，未重启门户、MeshCentral 或代理。首页备份、可执行回滚及独立实测记录保存在宿主私有 state 的 `screen-control/repairs/desktop-single-display-*`，旧资源保留。

## nix 补充部署（2026-10-20）

nix 恢复在线，用户要求重新部署。现场旧代理及运行进程均为 `e9747a18…f5b27`；经当前私有 SSH 运维入口和 sudo 救援核对后，以既有十分钟自动回退流程切换至 lerrem、echova 已保留的自适应工件 `ca00b635…9465d`。九项 canary 运维测试、固定摘要及防火墙健康通过，实测完成后保留新版；身份、内存／Swap 限制和网络规则保留，主 PID 稳定、无新增重启。

系统 Chrome 153.0.8010.52 经当前 HTTPS 入口实测 2880×1800 源：自动／1440P 为 2304×1440，1080P 为 1728×1080，720P 为 1152×720；切档、恢复自动、暂停／恢复、普通结束通过。桌面与手机视口共六轮新会话和位图释放检查通过；未发送键鼠、未保存画面、未锁屏。该次仅更新 nix 原生代理，未重发门户、未重启其他设备。回滚备份位于 nix 的 `/var/lib/screen-control/rust-canary-*`，本轮位置及独立证据在宿主私有 state 的 `screen-control/repairs/nix-adaptive-*`。范围、限制和恢复入口见[补充部署说明](../../performance/DESKTOP_ADAPTIVE.md#nix-补充部署2026-10-20)，不改变历史 G0/G3 验收状态。

## 1. 三台设备现状（历史审计）

| 设备 | 在线 | 桌面/显示 | Tailscale 路径 | 已验证事项 |
|---|---|---|---|---|
| `nix` `${SCREEN_CONTROL_NIX_IP}` | 是 | Ubuntu 22.04，Xorg `:1`，`2880×1800@60` | 本机 | G0 MeshAgent 已安装；重启后服务、防火墙和直连控制面恢复；尚未完成浏览器登录界面控屏 |
| `echova` `${SCREEN_CONTROL_ECHOVA_IP}` | 是 | Ubuntu 22.04.5，X11 `:1`，`3840×2160@119.88` | 曾直连约 13–22 ms；12:30 复测为 DERP(hkg) | G0 MeshCentral/MeshAgent 已安装并由 systemd 自启动；因承载当前任务尚未执行宿主重启 |
| `jiang-chenx` `${SCREEN_CONTROL_WINDOWS_IP}` | 是 | Windows 11 专业版 25H2/26200，`3840×2160`（用户确认） | DERP(hkg)，约 428–456 ms | G0 MeshAgent、服务 SID 防火墙和 SYSTEM 启动守护已安装；登录前网络启动时序已验证，尚未完成浏览器安全桌面控屏 |

- MagicDNS 后缀为 `your-tailnet.ts.net`；设备名分别为 `nix`、`echova`、`jiang-chenx`。

### 1.1 SSH 连接手册

以下连接于 2026-09-03 从 `nix` 使用现有 SSH 密钥和 `BatchMode=yes` 实测成功。`<windows-user>` 是 Windows 登录用户名，不是端口；两台远端均使用 SSH 默认端口 `22`。

| 角色 | SSH 用户 | Tailscale 地址 | Tailscale 名称 | 系统主机名 | 标准连接命令 |
|---|---|---|---|---|---|
| 主服务器 | `echova` | `${SCREEN_CONTROL_ECHOVA_IP}` | `${SCREEN_CONTROL_ECHOVA_HOSTNAME}` | `echova` | `ssh -p 22 ${SCREEN_CONTROL_ECHOVA_SSH_TARGET}` |
| Windows 电脑 | `<windows-user>` | `${SCREEN_CONTROL_WINDOWS_IP}` | `${SCREEN_CONTROL_WINDOWS_HOSTNAME}` | `Jiang_ChenX` | `ssh -p 22 ${SCREEN_CONTROL_WINDOWS_SSH_TARGET}` |

- 自动化探测使用 `-o BatchMode=yes -o ConnectTimeout=8`，不得在文档、命令历史或日志中写入密码/私钥。
- 首次遇到新主机名或主机密钥变化时必须核对身份，禁止用 `StrictHostKeyChecking=no` 绕过验证。
- `echova` 项目部署目录为 `${SCREEN_CONTROL_PROJECT_ROOT}`，NAS 数据目录为 `$HOME/nas`。
- Windows 端实测 `whoami` 返回 `<windows-host>\<windows-user>`，`hostname` 返回 `Jiang_ChenX`；命令执行仍受普通用户 `<windows-user>` 的系统权限约束。

### 1.2 G0 前初始基线缺口（历史事实）

本表记录 `IO-01a` 执行前的缺口，保留用于解释为何需要引导；这些采集缺口已经由 §1.3 的同一模式定义候选项快照闭合，并由 `IO-01c` 导入重验后形成正式可签名复算的 G0 环境 ID。

| 类别 | `nix` | `echova` | `jiang-chenx` | 当前缺口 |
|---|---|---|---|---|
| OS/内核/架构/启动 | Ubuntu 22.04、Xorg 已知 | Ubuntu 22.04.5 已知 | 仅 Windows 已知 | 精确构建、kernel、arch、boot ID 未统一采集 |
| 显示/缩放/session | Xorg `:1`、2880×1800 已知 | X11 `:1`、3840×2160 已知 | 3840×2160 为用户确认 | 三机缩放、GPU、驱动、硬件/软件编码器和登录前会话未统一采集 |
| 浏览器/自动化 | 未锁定 | 未锁定 | 未锁定 | 浏览器与驱动精确版本、策略、WebRTC 能力未知 |
| Tailscale | 地址/部分路径已知 | 地址/部分路径已知 | 地址/DERP 已知 | daemon/CLI 构建、接口 ID、路由/Grants 快照、UTC 同步未统一采集 |
| 防火墙/进程限制 | UFW 未启用 | UFW 未启用 | 未采集 | nft/cgroup-BPF、Windows Firewall 按程序/适配器能力及现有规则哈希未验证 |
| 救援/自动回退 | SSH 可达 | SSH 可达 | SSH 可达 | 尚无独立救援复核、定时看门狗或故意失联后的自动回退证据 |
| 工具链/空间/端口 | 部分事实 | Docker/磁盘/8080/5033 已知 | 未采集 | Git/Go/Node/PowerShell/抓包/媒体工具、完整监听与临时空间未统一锁定 |

`IO-01a` 只能执行无副作用的版本、状态、能力和监听查询，输出须脱敏；不得安装软件、改 Grants、改防火墙、重启或开放端口。`IO-01d` 已在独立救援和定时回退就绪后完成三机自动回退演练；后续 `RD-01a-L`/`RD-01a-W` 仍必须逐次装配看门狗并生成独立证据，不能把 IO-01d 当作永久授权。完整字段与命令/证据契约见[验证工程策略](../../appendix/verification-strategy.md)。

### 1.3 `IO-01a` 最新引导结果

通过的候选项运行 `io-01a-20260903T103433.753038Z-f9f2fd7839` 已用最终固定哈希记录器对三机执行 113 个白名单只读探针，92 个成功；其余为明确记录的可选工具缺失。三机十类必填语义事实均完整，UTC 偏差分别约 `nix -0.000 s`、`echova -0.016 s`、`jiang-chenx -0.079 s`，三机同步健康均通过。该候选项已由 `IO-01c` 导入并重新采集；当前正式环境快照哈希为 `06ac13827049a6681496796abd43bb25b877a01ea17162a2be65d8da4ef95ba5`，提交 `e500549f7c64824ad65528885d5940ff099793ff` 上的正式 IO-01a 运行为 `io-01a-20260903T111417.466974Z-2b63691ec1`，签名、封存、前置绑定和敏感扫描均通过。

此前 Windows Time 使用手动启动、单一 `time.windows.com,0x9`，状态为 Leap Indicator 3、Stratum 0、来源 Local CMOS Clock 且无成功同步；实测 UDP NTP 可达性后，已把 W32Time 设置为自动启动并配置 `ntp.aliyun.com,0x9 time.cloudflare.com,0x9` 双对端，重启服务并执行强制重新发现/同步。整改后来源为 `ntp.aliyun.com,0x9`、Leap Indicator 0、Stratum 4，实测 phase offset 约 `0.000489 s`。若新配置在后续观察中不稳定，回滚为原对端 `time.windows.com,0x9` 和手动启动；任何回滚后仍须重新通过三样本偏差与同步健康门。该环境变更独立于只读记录器，前后状态均在本节记录。

### 1.4 2026-09-04 G0 实机装配进度

- `echova` 已部署隔离的 MeshCentral 1.2.5 G0 控制面，只监听 `${SCREEN_CONTROL_ECHOVA_IP}:4443`；独立卷、systemd 启动单元、无 URL 登录令牌和不含明文凭据的管理包装器已验证。桌面专用账号可列出三台设备，但命令执行和文件下载均被后端权限拒绝。
- 门户为桌面和文件建立分离的服务端凭据：原 `g0-desktop` 继续拒绝终端和文件；新增 `g0-files` 允许文件协议、拒绝终端并仅授予只读桌面。文件秘密保持 `0600` 且只由回环地址 Go 桥接读取，浏览器仅取得一次性 `fil_*` 定位符。Windows 实机已验证卷根和 `C:` 目录列表，未在验证中创建、覆盖或删除文件。
- 三台 MeshAgent 均以固定 SHA-256 工件接入。Linux 使用 cgroup 进程树规则，Windows 使用 Mesh 代理服务 SID 规则；允许目标仅为三台登记 Tailscale IPv4，公网负测被拒绝。Windows 代理已确认不经 `127.0.0.1:7890` 本地代理，而是直接建立 `${SCREEN_CONTROL_WINDOWS_IP} → ${SCREEN_CONTROL_ECHOVA_IP}:4443` 连接。
- `nix` 已完成一次真实重启：MeshAgent、规则和到控制面的连接均在重启后恢复。`echova` 因承载当前 Codex 任务未重启，该项仍是 G0 阻断条件。
- Windows 初次重启暴露了 WLAN 接口索引变化，守护已改为由 SYSTEM 启动任务在每次开机后先重建规则、再启动手动模式代理。第二次重启时，5 分钟一次性回滚任务因验证窗口结束而按设计停用代理；恢复部署后已取消回滚任务并复验服务 SID 子进程只能访问登记地址。
- Windows 本次开机时序证明密码不是连接前置：`sshd`、Tailscale、WLAN AutoConfig 均在启动后约 10 秒运行，Wi-Fi 在约 15.7 秒连接，交互式用户登录在约 276.5 秒后发生。远程连接使用机器级服务身份，不使用或传输 Windows 登录密码。
- 当前 Tailscale 账户不支持签发 HTTPS 证书。经用户明确授权，`echova` 已在系统 CA 与用户 NSS 库中安装 G0 专用公开信任锚；其公钥与 MeshCentral 隔离卷中的根密钥匹配，补充 Chromium 要求的 critical `CA:TRUE`/`keyCertSign` 约束，网站证书链验证通过，私钥未离开 Docker 卷。指纹、路径与回滚见 [`TRUST_ECHOVA.md`](../../../deploy/g0/meshcentral/TRUST_ECHOVA.md)。Codex/Chromium 主进程仍须完整重启以清除启动时证书缓存，之后才能执行登录界面、锁屏和 UAC 的可视化 G0 验收。

## 2. `nix` 重启与 Xorg 验证

- 本次系统启动时间：2026-09-02 18:08:08。
- `XDG_SESSION_TYPE=x11`，`loginctl` 的活动用户会话类型为 `x11`。
- `/etc/gdm3/custom.conf` 已设置 `WaylandEnable=false`、`DefaultSession=ubuntu-xorg.desktop`。
- 原配置备份：`/etc/gdm3/custom.conf.codex-backup-20260902`。
- Xorg 登录已通过；登录界面和锁屏状态的远程控制要等 MeshAgent 安装后执行 A03/A04 验收。

## 3. SyncClipboard 现状

### 3.1 已通过

- 两台 Ubuntu 的客户端和 `echova` 服务端版本均为 3.1.5。
- `nix` 原配置备份：`$HOME/.config/SyncClipboard/SyncClipboard.json.bak-win-v-20260902`。
- `echova` 原配置备份：`$HOME/.config/SyncClipboard/SyncClipboard.json.bak-win-v-20260902`。
- `echova` 本次快捷键迁移前备份：`$HOME/.config/SyncClipboard/SyncClipboard.json.bak-gnome-hotkey-20260903` 与 `$HOME/.config/autostart/xyz.jericx.desktop.syncclipboard.desktop.bak-gnome-hotkey-20260903`。
- `nix` 重启后由 `~/.config/autostart/xyz.jericx.desktop.syncclipboard.desktop` 自动启动；自启动与快捷键命令均固定 `zh_CN.UTF-8`，进程运行于 `DISPLAY=:1` 并使用 `xclip`。
- 2026-09-03 再次复现应用内热键失效后，已清除 `nix` 的内部 `OpenHistoryPanel` 按键，改为 GNOME 持久绑定 `<Super>v` 到官方 `--command-OpenHistoryPanel` 入口；从未映射窗口实测 1 秒内变为可见，应用未运行时该入口也可启动后执行。
- `echova` 已完成同构迁移且保留原有 `Ctrl+Q` 自定义绑定；官方命令实测打开标题为“历史记录”的中文窗口。桌面客户端有登录自启动项，两机的自启动与命令进程均固定中文区域设置。
- 当前客户端配置的公网 URL 和 Tailscale 直连 `http://${SCREEN_CONTROL_ECHOVA_IP}:5033/SyncClipboard.json` 均能以现有凭据返回 200。
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
- 2026-09-04 已把本机源码、Git 历史和未提交工作同步至 `${SCREEN_CONTROL_PROJECT_ROOT}`；同步后对受 Git 管理/未忽略源码进行双端逐文件哈希聚合并确认一致。证据目录、私钥、`.env`、依赖缓存和构建产物未同步。
- Docker Engine 29.6.1、Compose 5.2.0 可用；宿主 Node.js 仍是 12.22.9，但项目用户目录已由 mise 隔离安装 Go 1.26.8、Node 24.20.0、pnpm 11.25.0 与 Python 3.12.13，不替换系统运行时。
- 同步后在 `echova` 完成 Python 运维测试、Go 普通/race、网页测试、类型检查、生产构建、toolchain/scenario/G0 静态校验和 Compose 校验。门户唯一规范入口为 `${SCREEN_CONTROL_DEV_ORIGIN}`，业务监听只绑定 Tailscale 接口；`127.0.0.1:5173` 仅以 `308` 导向规范入口，Go 桥接仍只监听 `127.0.0.1:8787`。
- `nix` 已从自身发起请求并取得门户健康响应；Windows 已验证门户 HTML、健康接口、3 台设备权威快照和同源 Mesh 协议脚本均返回 200。Windows 系统代理原先遗漏 `100.*`，现保留原规则并追加 `${SCREEN_CONTROL_ECHOVA_IP}` 与 `*.your-tailnet.ts.net` 例外，普通系统请求复测通过。
- `echova` 的 GNOME 代理例外已追加 `*.your-tailnet.ts.net` 与 Tailscale CGNAT 网段，Clash Verge 持久增强规则已前置 `DOMAIN-SUFFIX,your-tailnet.ts.net,DIRECT` 并热重载；因此本机也使用同一规范域名，不依赖回环地址或裸 IP。
- 评估日 Docker Engine 29.x 当前维护版为 29.7.2；29.6.1 是待升级的环境事实，不是目标基线。升级与 Compose/备份恢复回归由 `operations` 门负责。
- TCP 8080 已由无关项目 `$HOME/code/new_s0-s1` 的 uvicorn 服务占用，不能复用或修改。
- `$HOME/nas` 是本机 ext4 普通目录，权限 `drwxrwxr-x echova:echova`。
- `$HOME/nas` 约 30 GB，包含约 38,578 个文件与 4,004 个目录，其中 3 个文件大于 3 GiB；当前未发现符号链接。
- 所在磁盘约 1.9 TB，已用约 221 GB，可用约 1.6 TB；inode 使用率约 1%。
- `$HOME/.local/share/Trash/{files,info}` 存在、归 `echova` 所有且权限为 0700；尚未对真实 NAS 数据执行破坏性回收站测试。

## 5. 当前暴露面

| 发现 | 当前事实 | 当前风险与架构入口 |
|---|---|---|
| 公网隧道 | `https://legacy-tunnel.example/SyncClipboard.json` 有公网 DNS 且可达，未认证请求返回 401 | 公网暴露待迁移；处理顺序与退出证据见 [全局关注点 §6](../../appendix/global-concerns.md) |
| SyncClipboard 端口 | `nix` 和 `echova` 均有 `*:5033` 监听 | 存在多余监听；最终入口和清理责任见 [架构全景](../../ARCHITECTURE.md) 与 [全局关注点 §6](../../appendix/global-concerns.md) |
| 主机防火墙 | 两台 Ubuntu 的 UFW 均未启用 | 不能依赖单层主机防火墙；目标安全边界见 [权威需求 §5](_INDEX.md) |
| Tailscale 私有网络范围 | 当前能确认三台设备在线，无法从主机证明管理后台已拒绝其他 Tailscale 私有网络设备 | A01 尚无策略证据；身份与 Grants 落点见 [架构全景](../../ARCHITECTURE.md) |
| Windows 链路 | 审计时只能经 DERP(hkg)，约 428–456 ms | A07/N02 风险；选路契约与验证见 [NETWORK_ROUTING.md](NETWORK_ROUTING.md) |

### 5.1 A01 负测主体可用性

审计时没有可安全复用的“其他 Tailscale 私有网络设备”或公网探针，也没有隔离保存的已失效旧节点身份；因此三台已登记设备在线不能作为 A01 拒绝证据。第四阶段由 `IO-01c` 创建、由 `PC-10` 使用并销毁以下专用夹具：

| 夹具 | 当前事实状态 | 约束/证据 |
|---|---|---|
| 临时未登记 Tailscale 私有网络节点 | 未创建 | 无生产 tag/capability、无应用登记；不得扩大生产 Grants；测试后注销并保留销毁回执 |
| 失效旧节点身份 | 未创建 | 临时节点先登记后撤销/重登记；旧证书/节点 ID 只存隔离证据仓，用于旧身份拒绝 |
| 非 Tailscale 私有网络公网探针 | 未创建 | 一次性 runner/受控主机，不持项目凭据；验证公网 DNS/IP/Host/Origin/转发头均不能形成有效会话 |

不得使用第三方真实设备或未知 Tailscale 私有网络成员做负测。夹具模式定义、租期和清理规则以[验证工程策略 §5](../../appendix/verification-strategy.md)为唯一规范。

## 6. 尚未执行的验收

- G0 MeshCentral 和三台 MeshAgent 已安装并完成进程级出站限制；登录界面、锁屏、UAC、1080p 编码上限、无音轨和鼠标映射仍因浏览器可信 TLS 和 `echova` 重启项待验收。
- 私人网页 G0 Tailscale 私有网络入口、三机桌面中继和 Mesh 文件中继已实现；7 天正式登录会话、生产应用层身份/设备白名单、统一文件数据面 API、大文件断点续传和操作日志仍尚未实现。
- 未创建、移动、覆盖或删除 `$HOME/nas` 的既有数据；回收站与大文件测试必须使用隔离测试目录。
- Windows 的确切版本、服务安装状态和屏幕模式要在代理安装阶段自动采集，文档不臆测。

### 6.1 A07 现有数据不可替代业务统计

本审计中的 13–22 ms、428–456 ms 和 DERP/direct 记录来自 `tailscale ping`，只说明历史网络映射，不能作为 A07 业务控屏 RTT 或丢包证据。A07 必须在 G3 对六条有向旅程分别采集：稳定后预热 30 秒、1 Hz 连续 600 秒，以 WebRTC 已选候选项配对的 `currentRoundTripTime` 为首选，逐旅程计算最近秩 P95 和窗口计数器丢包率；每条都须满足 P95 ≤150 ms、丢包 ≤1% 且 10 分钟无断线。缺样、计数器重置或旅程拼接均失败。唯一计算口径和原始工件要求见[验证工程策略 §6](../../appendix/verification-strategy.md)。

## 7. 复现指针与来源

- 18:08–18:14，`nix`：`echo "$XDG_SESSION_TYPE"` 和 `loginctl show-session` 均为 `x11`；`xrandr` 为 `2880×1800`；进程 2446 由 GNOME 登录自启动。
- 18:14–18:22，`nix → echova`：`tailscale ping` 为直连，约 13 ms；`nix → jiang-chenx` 连续三次为 `DERP(hkg)`，428–433 ms，未升级为直连。
- 2026-09-03，`nix` 为 `192.0.2.10/24`；`echova` 为 `192.0.2.20/24`（以太网）及 `192.0.2.21/24`（Wi-Fi）。`nix → echova` 首次 DERP(hkg) 约 880 ms，随后为全局 IPv6 直连约 22 ms；`nix → jiang-chenx` 三次 DERP(hkg) 为 456/437/430 ms。完整验收契约见 [NETWORK_ROUTING.md](NETWORK_ROUTING.md)。
- 2026-09-03 12:30，`nix` 与 `echova`：查询可执行文件、system/user service 单元和进程均未发现 MeshAgent/MeshCentral/本项目远控服务；`tailscale status` 此时显示 `echova` 经 DERP(hkg)。
- 2026-09-03，`nix → echova` 通过 `ssh -p 22 ${SCREEN_CONTROL_ECHOVA_SSH_TARGET}` 验证为 `echova@echova`；`nix → jiang-chenx` 通过 `ssh -p 22 ${SCREEN_CONTROL_WINDOWS_SSH_TARGET}` 验证为 `<windows-host>\<windows-user>@Jiang_ChenX`。
- 18:14–18:22，`nix` 与 `echova`：`tailscale netcheck --format=json` 均为 UDP/IPv4/IPv6 true、`MappingVariesByDestIP=false`。
- 18:14–18:22，`echova`：`systemctl --user status syncclipboard.service` 为 enabled/active，自 2026-08-31 02:00:46 运行；`ss -lntp` 显示 `*:5033`。
- 18:14–18:22，`echova`：`find -xdev` 汇总为 38,578 文件、4,004 目录、0 符号链接、3 个文件大于 3 GiB；`df` 显示约 1.6 TB 可用。
- 18:22–18:27，`nix`：关闭 GNOME 兜底绑定，重启 SyncClipboard 后以 `xdotool` 发送 X11 Super+V，历史窗口由未映射变为可见；远端当前文本与本机剪贴板内容、长度和 SHA-256 均相同。
- SyncClipboard 官方命令入口说明：<https://github.com/Jeric-X/SyncClipboard#--command-command-name>；Ubuntu 长时间运行后热键失效问题：<https://github.com/Jeric-X/SyncClipboard/issues/266>；3.1.5 的对应修复记录：<https://github.com/Jeric-X/SyncClipboard/blob/master/Changes.md#v315>；当前 3.2.0 发布页：<https://github.com/Jeric-X/SyncClipboard/releases/tag/v3.2.0>。
- MeshCentral 项目：<https://github.com/Ylianst/MeshCentral>；审计时 1.2.5 的 `package.json` 要求 Node.js 20 或更高：<https://raw.githubusercontent.com/Ylianst/MeshCentral/1.2.5/package.json>。
- MeshAgent 项目说明：<https://github.com/Ylianst/MeshAgent/blob/master/readme.md>。
- MeshAgent 官方说明列出了 Linux 登录界面黑屏/Xauthority 的 Xorg 配置建议，但登录前桌面能力仍须逐机验证：<https://github.com/Ylianst/MeshAgent#special-note-about-kvm-support-on-linux>；仍有登录前无桌面入口的公开未解决报告：<https://github.com/Ylianst/MeshAgent/issues/260>。
- 当前暴露面核查涉及的 Tailscale Grants：<https://tailscale.com/docs/features/access-control/grants>；连接类型和选路依据只在 [NETWORK_ROUTING.md](NETWORK_ROUTING.md) 维护。

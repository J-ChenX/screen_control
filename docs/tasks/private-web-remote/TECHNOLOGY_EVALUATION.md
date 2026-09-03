# 第二阶段技术候选评估

状态：三层分层策略已于 2026-09-03 获用户批准；增强自审结论为有条件通过，远控内核仍有 G0 硬门。  
评估日期：2026-09-03（Asia/Shanghai）。

本文件只记录第二阶段的技术比较、推荐和验证门；权威需求与验收仍以 [_INDEX.md](_INDEX.md) 为准，易变机器事实仍以 [ENVIRONMENT_AUDIT.md](ENVIRONMENT_AUDIT.md) 为准。

## 1. 体量评估

| 维度 | 评估 | longtask 判定 |
|---|---|---|
| 独立子系统 | 远控、文件数据面、身份/会话、设备控制面、网络与运维，至少 5 个 | 3 层 |
| 工作包 | 第二阶段初估 18–24 个；第三阶段整改后细化为 68 个全局唯一包 | 3 层、4 条交付流及每段不超过 8 包的可恢复执行段 |
| 工时 | 245 小时主动工程工时；重启、传输与 24h soak 等墙钟时间单列 | 3 层 |
| 领域 | Web、安全、跨平台系统服务、实时媒体、文件系统/传输、网络/部署，6 个 | 3 层 |

推荐采用 **L1 全局契约 → L2 模块设计 → L3 工作包/文件级细节**。父任务维护跨模块契约，第三阶段按四条交付流拆分并各自独立验收：

1. 门户与控制平面：统一网页、登录会话、设备登记、状态与操作租约。
2. 远程控屏：MeshCentral 隔离部署、三平台 MeshAgent、网页嵌入与直连实测。
3. 文件数据面：普通用户代理、安全文件命名空间、断点续传和跨设备复制。
4. 集成与运维：SyncClipboard、Tailscale 策略、部署、备份、升级、健康检查和总验收。

## 2. 推荐技术基线

以下是架构候选，不等于已经通过实机验证。标有“门控”的项目未通过对应验证前不能进入全面实现。

| 领域 | 推荐 | 选择理由 | 关键约束/验证门 |
|---|---|---|---|
| 自研服务与三机文件代理 | Go 1.26.8 生产基线；CI 验证 1.27.1 | 标准库覆盖 HTTP/TLS/流式 I/O；单二进制跨 Linux/Windows；两条版本线在评估日均受支持；1.26.8 比刚发布两天的 1.27.1 有更成熟窗口 | 文件代理以指定普通用户运行；系统级控屏进程不得委派高权限句柄；1.27 升级须过三机、竞态和协议矩阵 |
| 网页 | React 19.2.8 + TypeScript；Node.js 24.20.0 LTS 仅用于构建 | 文件、传输与远控状态适合客户端状态 UI；React 19.2.8 和 Node 24 LTS 是评估日受维护线 | 精确锁文件和镜像 digest；不安装 React Server Components 或 `react-server-dom-*`；静态产物由 Go 门户交付 |
| 元数据 | `github.com/mattn/go-sqlite3` v1.14.50，内嵌 SQLite 3.53.4，WAL（后端组合根单写） | 活跃维护的 `database/sql` driver；内嵌版本已避开截至 3.51.2 的 WAL-reset 严重缺陷；数据库只在 `echova` 服务端，不把 CGO 传播到三机代理 | 多阶段 Linux 构建固定编译器与镜像摘要；不启用 `libsqlite3` 系统链接；启动断言 `SELECT sqlite_version()` 与 driver API 均为 3.53.4；验证 WAL、在线备份、完整性和恢复。各领域拥有 repository/schema/migration，文件正文不入库 |
| 网络身份、HTTPS 与入口网关 | Tailscale/tailscaled 1.102.3 生产基线、同版 Go module、Grants + 第一方 Go `edge-gateway` | 基线包含评估日安全修复；网关在真实 socket peer 上认证、终止 TLS，并反向代理门户及受控 Mesh 路由 | 使用 `WhoIsForIP` 让 Grants app capability 按目的 IP 收窄，使用 `Client.GetCertificate` 而非弃用的包级函数；网关只经本机受限通道传递签名身份上下文，不能信转发头 |
| 密码与会话 | Argon2id + 服务端不透明会话 | 满足只保存抗破解哈希、可即时撤销、7 天绝对到期和 CSRF 防护 | 参数在部署机基准测试后锁定；会话令牌只以摘要入库；活动 WebSocket/控屏/传输使用短租约并接受撤销广播 |
| 远控内核 | MeshCentral server 1.2.5 + 各平台 MeshAgent 构建哈希；Node.js 24.20.0 LTS 容器 | Apache-2.0；具浏览器远控、系统服务代理、Linux Xorg 登录界面说明和 WebRTC | **仅作尖峰候选**：原版不提供 Tailscale-only ICE 策略，官方登录令牌又位于 URL；必须通过 §3，Agent 禁自动升级并金丝雀发布 |
| 剪贴板 | SyncClipboard 3.2.0 目标基线；3.1.5 仅作迁移源 | 3.2.0 是评估日最新稳定版；继续复用现有产品，避免重复建设历史 UI | 配置、数据库和历史文件先备份；三客户端与服务端同步升级并完成 A13/回滚后才转正；失败恢复 3.1.5，公网入口只在私网替代已验证后关闭 |
| 部署 | Docker Engine 29.7.2 + Compose 仅承载 `echova` 服务；三机代理使用原生 systemd/Windows Service | 29.7.2 是评估日 29.x 当前维护版；隔离宿主 Node 12，不改动无关项目；系统服务覆盖登录前与用户权限边界 | 部署前从已审计的 29.6.1 升级并回归 Compose/备份恢复；固定镜像摘要/依赖；配置、数据库和 Mesh 数据卷单独备份 |

### 2.1 关键选型决策矩阵

本表是 QG02 的统一比较入口；版本存在性与维护状态按 §6 的官方来源复核，目标环境兼容性只能由列出的第四阶段门转正。未通过验证的候选不得因已写入架构而自动成为生产依赖。

| 领域 | 已选候选 | 比较过的替代 | 不选替代的当前理由 | 目标环境门 | 替换触发条件 |
|---|---|---|---|---|---|
| 自研后端/代理 | Go 1.26.8；CI 前探 1.27.1 | Rust、.NET 10 | Rust 会扩大三平台系统适配与构建面；.NET 增加运行时和第二套后端生态；二者都不改善本项目最难的远控内核问题 | IO-01 固定编译器/模块校验；三机交叉构建、race/协议矩阵 | Go 目标平台支持、CGO 服务端构建或所需系统 API 无法稳定验证 |
| Web UI | React 19.2.8 + TypeScript，Node 24.20.0 仅构建 | Vue、Svelte、服务端模板 | 文件/远控/传输具有大量并发客户端状态；只需一个静态 SPA，不引入 SSR/RSC | IO-01 锁包管理器、构建器、TypeScript、测试器和浏览器驱动；PC-07 验证三台浏览器 | 包体或状态复杂度无法达门、维护线/EOL、安全公告或三机浏览器不兼容 |
| 元数据 | go-sqlite3 + SQLite/WAL 单写 | modernc.org/sqlite、外部 PostgreSQL | 纯 Go driver 依赖同步更脆弱；三设备单用户负载不值得引入数据库服务；CGO 只留在服务端 | IO-01 构建复现；IO-03 WAL/队列/备份恢复和 10×控制面负载 | 需要 Windows 代理内嵌 DB、单写吞吐达不到门、或多实例写成为正式需求 |
| 私网与身份 | Tailscale + 第一方 edge-gateway | Tailscale Serve 直接暴露、裸 WireGuard、普通反向代理信任头 | 直接 Serve/普通反代无法同时落实稳定节点登记、密码会话、Mesh 路由隔离和统一撤销；裸 WireGuard 会自建身份/证书/路由控制面 | IO-01 Grants/LocalAPI/证书/未登记节点夹具；G1 A01 | LocalAPI/证书/Grants 无法满足三平台或最小权限 helper 不能成立 |
| 密码与会话 | Argon2id + 不透明服务端会话 | bcrypt、scrypt、JWT 长会话 | Argon2id 有标准化内存成本；服务端会话可即时递归撤销，长生命周期 JWT 难满足改密/设备撤销 | PC-02 实机内存/延迟标定；PC-03 虚拟时钟和恢复 epoch | echova 无法在 DoS 预算内标定，或撤销模型不能通过 A02 |
| 远控内核 | MeshCentral/MeshAgent 1.2.5（仅 G0 候选） | RustDesk、Guacamole、自研内核 | 详见 §3；替代分别受网页授权/分叉、服务器中转、登录前桌面与自研高权限复杂度约束 | G0 四项架构淘汰门；G3 产品矩阵 | G0 任一项失败、需要长期 fork 或只能经服务器媒体中转 |
| 文件数据面 | 普通用户 Go agent + Tailscale HTTPS | 经 echova 中转、SMB/WebDAV 暴露、浏览器本地缓存 | 中转违背直连；通用文件协议难以统一撤销、句柄安全和逐项结果；浏览器缓存不适合 >3 GB | FF-00 浏览器直连/落盘尖峰；G4 全矩阵 | 三台浏览器无法在请求头授权下流式下载/续传，或句柄级平台语义不可统一 |
| 剪贴板 | 复用 SyncClipboard 3.2.0 | 自研协议、远控内核剪贴板 | 用户已有产品与原生历史 UI；自研会重复建设，远控通道会形成双写/循环 | IO-02a migration；IO-02f/02g mTLS/connector；IO-02b 探针；IO-02d 三端传播；IO-02e 24h soak；IO-02h 旧入口退役负测 | A13、私网认证/轮换或队列恢复失败 |
| 部署 | echova Compose + 三机原生服务 | 全部容器化、全部宿主进程、Kubernetes | 登录前/普通用户平台代理必须贴近 OS；服务端容器隔离依赖且不改宿主 Node；三台固定设备无需 K8s | IO-01 版本/网络/端口/回滚；IO-04 恢复演练 | Compose 与宿主 Tailscale/LocalAPI 隔离无法闭合，或回滚门失败 |

SQLite driver 比较结论：`modernc.org/sqlite` v1.58.0 是可行的纯 Go 方案并覆盖 Linux/Windows，但其文档要求严格同步较脆弱的 `modernc.org/libc` 版本；本项目只有 `echova` 组合根访问 SQLite，故优先采用维护成熟且当前已内嵌 SQLite 3.53.4 的 `mattn/go-sqlite3` v1.14.50。若未来数据库代码需要进入 Windows 代理，必须重新评估，而不是把 CGO 或第二套 driver 扩散到代理。

## 3. 远控候选比较与硬门控

### 3.1 推荐：MeshCentral / MeshAgent（有条件）

MeshCentral 1.2.5 于 2026-08-12 发布，要求 Node.js `>=20`；项目仍持续发布。官方配置模式明确支持：

- `webRTC: true`：浏览器与 Agent 直接传输；
- `allowFraming`、`allowedFramingOrigins` 和 `allowLoginToken`：在统一门户内嵌；
- `userAllowedIP`、`agentAllowedIP`：额外收窄入口；
- `clipboardGet/clipboardSet`：关闭与 SyncClipboard 冲突的通道；
- Linux Xorg/GDM 的登录界面配置；Windows 安装为服务后可覆盖 UAC 安全桌面。

但 WebRTC 默认关闭；1.2.5 前端把配置和候选交给标准 `RTCPeerConnection`，没有 Tailscale-only candidate policy，默认配置还可能使用公网 STUN。ICE 可选择物理 LAN、公网反射、TURN 或 Tailscale host candidate，入口网关和 `PathPolicy` 无法在媒体建立后替它强制路径。官方 `allowLoginToken` 也使用 URL token，与本项目的日志红线冲突。加上公开的拓扑不稳定与 Linux 登录前个案，MeshCentral 只能先做隔离尖峰。候选验证分成两个门：**G0 只处理会决定候选存废的四项架构可行性**；G3 处理可修复的产品质量和完整六旅程。G0 的唯一清单与工作包映射见 [远控子任务](../private-web-remote-remote/_INDEX.md)。候选必须满足：

1. `nix`、`echova` 重启后在 GDM 可见且键鼠有效；Windows 登录/锁屏/UAC 安全桌面可见且键鼠有效。
2. 两台 Ubuntu 以 systemd/cgroup-BPF 或 nftables、Windows 以按程序+精确地址+Tailscale 适配器规则约束 MeshAgent 进程树；关闭公网 STUN，规则缺失或漂移时 Agent 不得启动。G0 在 Linux 与 Windows 各执行允许路径和物理 LAN/公网 ICE 注入负测，证据同时含 WebRTC `getStats()` candidate pair、端点抓包和 Tailscale 映射；完整六条有向旅程及正常切网属于 G3。若任一平台无法持久、进程级、fail-closed 地执行，需长期 fork，或只能 TURN-only 经服务器，候选失败。
3. **G3：** 输入 10 分钟无卡键、重放或 DPI/缩放坐标漂移；断网恢复后旧输入不重放。
4. **G3：** Agent 端输出不超过规定分辨率且无音轨；浏览器保持宽高比。
5. 独立 desktop-only 身份无法进入 Terminal、Files、PowerShell、命令、录制、共享链接或剪贴板入口；设置 `noAgentUpdate=1`，记录三平台 Agent 安装包/二进制摘要并先单机金丝雀。
6. Mesh 用户 UI/普通登录/WS 无法绕过第一方网关；用后端交换或等价机制发放的一次性启动凭据绑定来源节点、目标、desktop-only 和短租约，不进入 URL/Referer/日志，也不形成通用 Mesh 会话。若 1.2.5 只能使用 URL token 或需要长期 fork，候选失败。撤销后真实 WS/WebRTC 在租约窗口内终止。

第 1、2、5、6 项组成 G0；任一失败都淘汰候选。第 3、4 项组成 G3 产品门，可在不需要长期维护上游分叉时修复后重测。G0 通过前，文档不得把 MeshCentral 写成最终远控选型。

### 3.2 未选：RustDesk

RustDesk 1.4.x 活跃维护，原生客户端具备 P2P、无人值守、Windows/Linux 和 Linux X11 登录界面支持，媒体能力强于 MeshCentral。但统一网页场景存在两个结构性问题：自托管 Web Client 属于 Server Pro 的较高套餐能力，而 OSS 服务器只提供 rendezvous/relay；使用官方托管 Web Client 又不符合“仅私网、自主入口”。从源码维护 Flutter Web/AGPL 分叉会把门户集成、认证和升级成本变成长期核心负担。因此只作为 MeshCentral 尖峰失败后的重新评估项，不作为自动回退。

### 3.3 未选：Apache Guacamole

Guacamole 1.6.0 是成熟、活跃的 HTML5 RDP/VNC 网关，也允许使用客户端 API嵌入自有网页。但其标准架构由浏览器连接 `guacd`，再由 `guacd` 连接目标 RDP/VNC 服务，媒体稳定经过 `echova`；这与同 LAN/可直连时不绕行服务器的网络契约冲突。它还需要为两台 Ubuntu 另建可覆盖 GDM 的 VNC 服务，Windows RDP 也不等同于控制当前本地控制台会话。因此不采用。

### 3.4 不自研屏幕采集/输入内核

自研 Windows 安全桌面切换、DXGI/编码、Linux GDM/Xorg 捕获与输入注入会把最高权限、最复杂兼容面和媒体性能全部变成项目自有责任，明显超出首版范围。除非所有成熟候选均被实机证伪并由用户重新批准范围，否则不走该路线。

## 4. 文件数据面推荐

门户只协调，不转发大文件正文：

- 每台设备运行一个普通用户身份的 Go 文件代理，只监听该设备的 Tailscale 地址和专用高位 HTTPS 端口；端点无 Cookie，CORS 只允许门户精确 HTTPS Origin，能力只经受保护请求头传输。
- 浏览器从门户取得绑定“父会话/撤销代次 + 来源节点 + 目标设备 + 操作 + 路径/对象 + 大小/哈希 + 短时限”的能力，然后直接访问目标代理；每次请求及提交重新授权。
- FF-00 必须先证明三台目标浏览器能在不把 capability 放入 URL、Cookie 或持久存储的情况下，以请求头授权把 >3 GB 内容流式写入用户选择的文件并通过 Range/块清单恢复；实现可采用受支持的流式落盘能力或项目提供的受限本地 helper，但不得退化为内存 Blob。任一目标浏览器无法满足时，先执行架构修改，不进入 `FF-03a`/`FF-03b`。
- 跨设备复制只按登记设备 ID 解析固定端点，不接受 URL/主机/端口或重定向；固定采用 `target-pull`，单一源端 `GET` capability 同时绑定源读、目标执行者和清单，目标写权由受保护控制命令与本地 SafeFS 决策独立授予。目标代理写入同目录排他临时对象，块摘要与 journal fsync 后才以 target executor 身份确认 range，最终 SHA-256 通过后原子提交。
- `control-plane` 拥有操作租约，`file-fabric` 拥有文件审计事件，后端组合根持久化两者各自的领域状态；代理只保存当前传输的最小恢复状态。失去租约、会话或设备授权即停止新块，恢复时重新授权。
- 路径解析、特殊对象拒绝、回收站和冲突检测由共享 Go 包实现，并以逐组件 no-follow 的已打开句柄作为安全边界；浏览/搜索/下载/上传/移动/删除不得各写一套策略。

该方案使浏览器上传/下载和跨设备复制都能利用 Tailscale 的实际路径，并满足 QG03 的单一安全策略和传输 tool 契约。Tailscale/ICE 负责实际底层路径建立；`control-plane` 的 `PathPolicy` 是唯一的事实归并、准入和标签所有者，不能伪称自己强制选择底层 direct/relay。文件与远控只读取决策并验证实际路径，细节见 [全局关注点](../../appendix/global-concerns.md)。

## 5. L1 模块地图的权威入口

三层策略批准后，模块职责、依赖、接口方向和构建顺序已转入 [ARCHITECTURE.md](../../ARCHITECTURE.md)。本评估不保留第二份模块表，避免后续架构修改时产生漂移；这里只继续维护候选比较和选型证据。

## 6. 官方依据（2026-09-03 核验）

- [MeshCentral 1.2.5 发布记录](https://github.com/Ylianst/MeshCentral/releases/tag/1.2.5)、[配置模式](https://github.com/Ylianst/MeshCentral/blob/1.2.5/meshcentral-config-schema.json)、[MeshAgent Linux KVM 说明](https://github.com/Ylianst/MeshAgent#special-note-about-kvm-support-on-linux)
- [RustDesk 官方文档](https://rustdesk.com/docs/en/)、[Linux 登录界面限制](https://rustdesk.com/docs/en/client/linux/)、[OSS Server 范围](https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/)、[Web Client 说明](https://rustdesk.com/blog/rustdesk-web-client-v2-preview/)
- [Apache Guacamole 1.6.0 架构与 API](https://guacamole.apache.org/doc/gug/introduction.html)
- [Tailscale 身份](https://tailscale.com/docs/concepts/tailscale-identity)、[Grants 语法](https://tailscale.com/docs/reference/syntax/grants)、[LocalAPI Go 文档](https://pkg.go.dev/tailscale.com/client/local)、[Tailscale 更新日志](https://tailscale.com/changelog)、[连接类型](https://tailscale.com/docs/reference/connection-types)
- [Go 发布历史](https://go.dev/doc/devel/release)、[Node.js 发布状态](https://nodejs.org/en/about/previous-releases)、[React 版本](https://react.dev/versions)、[SQLite serverless 架构](https://www.sqlite.org/serverless.html)、[SQLite WAL-reset 修复说明](https://www.sqlite.org/wal.html#the_wal_reset_bug)、[`go-sqlite3` 发布记录](https://github.com/mattn/go-sqlite3/releases/tag/v1.14.50)
- [RFC 9106：Argon2](https://www.rfc-editor.org/rfc/rfc9106.html)
- [SyncClipboard 3.2.0 发布记录](https://github.com/Jeric-X/SyncClipboard/releases/tag/v3.2.0)
- [Docker Engine 29 发布说明](https://docs.docker.com/engine/release-notes/29/)

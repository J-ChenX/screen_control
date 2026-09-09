# 跨模块全局关注点

**状态：** L1 全局契约，第三阶段模块文档共同引用（2026-09-03）  
**适用范围：** `identity`、`control-plane`、`platform-agent`、`remote-desktop`、`file-fabric`、`clipboard`、`portal`、`operations`

本文件承载会跨越两个以上模块、但不应在各模块重复实现的约束。需求正文只以 [权威需求索引](../tasks/private-web-remote/_INDEX.md) 为准；本文件定义其架构落点。

## 1. 运行拓扑、所有权与存储

- `echova` 上的第一方 Go `edge-gateway` 是唯一浏览器入口：对真实套接字对端调用宿主 `tailscaled` LocalAPI `WhoIsForIP`，终止 HTTPS，并把已签名、短时、含撤销代次的内部身份上下文仅经 Unix domain 套接字传给门户后端。它不拥有领域规则。
- 门户与 Mesh 必须使用两个独立 HTTPS 源站。门户 Cookie 是仅绑定门户主机的 HostOnly Cookie，绝不发送到 Mesh 源站；网关可在 Mesh 源站使用独立、短期、仅供入口端消费的 `__Host-mesh-route` Cookie，但必须在转发上游前剥离。网关只代理明确允许的桌面 HTTP/WS 路由，进入上游前删除所有 Cookie、Authorization、CSRF、外来身份头和 hop-by-hop 头，Mesh 返回任何 `Set-Cookie` 都失败关闭；管理界面、普通登录、未经网关的 WS 和其他 Mesh 能力不对用户网络暴露。入口网关、门户后端、Mesh 协调器、SyncClipboard 服务可独立健康检查和重启，由 `operations` 装配。
- `portal` 指界面领域模块；“后端组合根”指 `echova` 单写进程。SQLite 只由组合根写入，但每个领域拥有自己的 repository、表和迁移；领域间只经契约交互，禁止跨领域 SQL 联接。文件正文不入库。
- `file-fabric` 产生并拥有文件审计事件，组合根的存储适配器负责原子持久化；安全敏感变更无法持久记录审计时失败关闭。`operations` 只管理保留、备份和恢复策略。

## 2. 唯一选路契约

`control-plane` 拥有唯一共享工具：`PathPolicy`。只有 `platform-agent` 可通过 agent-authenticated `ReportStatus` 持久提交接口/Tailscale/端点事实；浏览器运行时测量只能作为绑定 desktop/file 会话的不受信证据交给对应领域服务，由端点/LocalAPI 交叉验证后并入代理报告，浏览器和消费者没有事实写入口。远控、文件和门户只调用只读 `ReadPathDecision` 消费统一决策及状态，不能传入自选事实，也不能复制优先级、防抖或标签逻辑。

`ReportStatus.pathFacts` 的规范字段与权限只由[协议契约 §7](protocol-contracts.md)定义。`ReadPathDecision` 只接收 URL 中的流、来源和目标，主体来自受信上下文；输出包含事实版本、实际路径标签、事实时间、到期和原因。Tailscale/ICE 负责实际底层路径建立，`PathPolicy` 负责事实归并、准入和标签，不能伪称强制选择 direct/relay。状态只允许“局域网直连 / 互联网直连 / 私有中继 / DERP / 离线”；未知、单源未佐证或陈旧事实不得猜测为直连。

文件传输只连接登记设备 ID 解析出的固定 Tailscale HTTPS 端点。MeshCentral WebRTC 只有在尖峰和运行时都能证明选中候选属于经认证的 Tailscale 虚拟接口/地址，并能映射到登记节点时才可使用；禁止裸 LAN、公网 ICE、未知候选和 Mesh 服务器媒体中转冒充 Tailscale 直连。两台 Ubuntu 用 systemd/cgroup-BPF 或 nftables、Windows 用按程序+精确地址+Tailscale 适配器规则，把 MeshAgent 进程树限制为只与三台登记 Tailscale 地址通信；关闭公网 STUN，规则缺失/漂移时代理不得启动。路径证据须同时包含浏览器 `getStats()` 候选项配对、端点抓包和 Tailscale 映射。路径漂移时立即停发输入、终止或重协商；任一平台无法持久、进程级、失败即拒绝地执行，或需要长期上游分叉，MeshCentral 候选失败。

## 3. 入口认证、派生链与撤销

- 浏览器进入网关先通过“稳定 Tailscale 节点 ID + 登记记录”，再通过密码会话；网关不信任客户端或外部代理提供的身份头。登录按稳定节点 ID 和全局维度限速，并限制请求体、并发 Argon2id 计算和内存预算。
- 首次启动处于 `bootstrap-required`，不开放登录、门户或 Mesh 路由。一次性引导只能由 `echova` 本地控制台上的受限运维身份执行；密码从 TTY/stdin 或 0600 临时秘密 file 读取，不接受 argv、环境字面量或默认密码。设备登记/替换显式显示旧/新稳定节点 ID，事务内写审计并递增旧身份撤销代次；丢失设备流程不得要求该设备在线。
- 持久关系为 `session → lease → capability / desktop-launch / channel / transfer`；每个派生对象含父 ID 或撤销代次、最小作用域和绝对到期。退出、改密、设备撤销或到期递归失效，服务重启和撤销通知丢失也不能恢复旧代次。
- 网关内部身份上下文签名覆盖 issuer、受众、来源节点、session/撤销代次、HTTP 方法、规范路由、请求体摘要、绝对到期和唯一请求 ID。门户校验 Unix 套接字对端 credentials、拒绝重复请求 ID；网关先删除客户端提供的全部内部身份头。
- Mesh 启动凭据一次性、极短期，绑定来源节点、目标设备、仅桌面权限和租约；不得形成通用 Mesh 用户会话，不进入 URL、Referer、浏览器持久存储或日志。独立 Mesh 源站的 iframe 和 WS 升级分别重新校验节点、登记、门户会话、源站与租约；撤销须实际关闭 WS/WebRTC。`desktopSession` 的所有操作和证据读取均重验父会话、来源节点、目标、租约代次、作用域与到期，禁止仅凭不透明 ID 授权。
- 文件代理无 Cookie。能力仅经 `Authorization` 等受保护请求头传输；CORS 只允许精确的门户 HTTPS 源站，拒绝通配符与 `null` 并覆盖预检。普通用户代理不得直接取得完整 tailscaled LocalAPI socket/命名管道权限；最小系统身份 `screen-control-peer-helper` 只接受专用文件套接字、只查询它真实接受连接的 `WhoIsForIP` 并签发一次性 `PeerBindingProof`，通过 Unix 对端 credentials/Windows 管道 ACL 校验调用者。辅助进程不可用或身份冲突时失败关闭。每个请求和最终提交重验来源、目标、动作、对象/路径、大小/哈希、租约和期限。
- 删除、覆盖、移动、锁屏和最终提交携带绑定操作摘要的一次性 nonce 或持久幂等键；重复请求返回原结果而不再次执行。恢复传输须取得当前有效授权，旧键鼠事件永不补发。

## 4. 文件系统与传输不变量

- 路径安全以“已打开对象”而非仅字符串规范化为边界：逐组件、不跟随链接解析；Linux 采用受约束目录句柄遍历（等价 `openat/openat2`），Windows 打开后核验 reparse、卷和最终对象。变更/提交前按句柄身份重验对象、父目录、普通用户权限与陈旧前置条件；删除链接只删除链接。
- 回收站目标必须核验所有者、权限和文件系统。`Trash` 返回 `Trashed | Unsupported | Failed`；只有 `Unsupported` 才能进入“明确不可恢复的二次确认 → 新的一次性授权 → PermanentDelete”。批量操作逐项返回 `succeeded | partial | failed | unknown`；`partial` 必须携带已发生副作用、源/目标现状和恢复动作，不把跨卷/部分成功包装成原子成功；跨设备永远不提供移动。
- 跨设备复制仅接受稳定设备 ID，不接受任意 URL、主机、端口或重定向。连接后用 TLS 与 `WhoIsForIP`/代理凭据复核实际源节点；授权同时绑定源读、目标写、两端路径、清单哈希、租约和期限。每次访问 session/transfer/manifest/chunk ID 都重验归属。
- 临时对象在目标同目录随机、排他、不跟随链接创建并使用普通用户最小权限。声明大小、并发数、磁盘预留、稀疏文件、块归属和清理期限受限；最终 SHA-256、目标身份和前置条件复核后才原子提交。
- 下载默认 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff` 与限制性 CSP；未来预览只能在无凭据的隔离 Origin/沙箱中运行。
- 安全敏感文件变更采用持久协议：组合根先在 SQLite 原子写入 audit 意图，身份模块才签发绑定 intent/request 摘要的执行能力凭据；端点先把意图、幂等键和操作摘要写入受限持久化日志并 fsync，再执行一次；结果写入端点事务发件箱，中心按 event ID/幂等键归并并返回 `AuditReceipt`。拿不到持久 intent/capability 时不得变更；执行后中心暂时不可用不回滚已发生的文件系统事实，而是返回 running/unknown 并持续重传。六个崩溃切点的协调规则只由[协议契约 §9.3](protocol-contracts.md)定义。
- 传输契约必须提供 `GetTransfer`、`ResumeTransfer`、`AbortTransfer` 和 `GetOperationResult`；恢复重新授权并返回已确认块/Range、清单哈希、目标前置条件与当前状态。浏览器 >3 GB 下载不得聚合为内存 Blob；FF-00 先在三台目标浏览器证明请求头能力凭据、流式落盘和中断恢复，不通过即触发架构修改。

## 5. 集成失败策略

| 边界 | 时限与重试 | 断开/陈旧行为 |
|---|---|---|
| `edge-gateway → LocalAPI WhoIsForIP/GetCertificate` | 短超时；仅幂等查询有限退避；证书在有效期内提前更新 | 无法确认对端时拒绝新请求；不得回退到 IP/头部身份 |
| `edge-gateway → portal/Mesh` | 有界连接/握手/空闲超时；只重试安全读和幂等握手 | 上游异常返回不可缓存错误；已撤销路由不继续透传 |
| `file agent → screen-control-peer-helper` | 500 ms；仅一次 100 ms 抖动重试 | 无法确认真实对端时拒绝请求，不回退到 IP/头部 |
| `agent → control-plane` 心跳/撤销 | 指数退避加抖动；状态含采集时刻与单调序号 | 超过模块文档规定的陈旧阈值显示异常/离线；分区时拒绝新高风险租约 |
| `remote → platform Lock` | 5 s，不自动重试 | Failed/Unknown 均结束输入和控制通道但明确显示未确认锁定；用户可新建会话重试 |
| `file coordinator → source/target agent` | connect 2 s；单请求 30 s；仅按幂等回执重试 | 读取 intent/journal/outbox 判定结果，不能把超时当未执行 |
| `MeshAdapter → Mesh control API` | connect 2 s；请求 5 s；仅一次安全读重试 | 不签发 launch；已有控制按租约独立关闭 |
| `consumer → revocation stream` | 0.5/1/2/4/8 s 抖动重连，最长 10 s | 重连前按本地绝对到期从严；游标失效全量重同步，租约兜底关闭 |
| `browser/agent → file agent` | 块级有界超时；仅确认块可续传 | 停止新块并保留受控临时对象；恢复后重新授权及重验清单 |
| `browser → MeshAgent` 控屏 | 有界建连和短租约；不重试输入 | 路径/身份未知立即停发并关闭或重协商；普通断线保持原锁态 |
| `SyncClipboard` | 独立探测服务、文本、历史/文件；重试有退避和上限 | 三项分别降级，事件/快捷键只作诊断，不用单一绿灯掩盖失败 |
| `SQLite` | 单写队列有上限；事务忙采用有限退避 | 队列满显式背压；安全变更不得绕过审计；读快照可标陈旧 |

截止时间树固定为：同步快照/operation/transfer 查询 3 s，普通 List/Stat 5 s；变更、远控启动和传输启动在 3 s 内持久受理并返回 `202 Operation`；实际远控建连可异步 15 s，搜索/单项变更/块 I/O 按[协议契约 §5](protocol-contracts.md)使用 30 s 或资源 TTL；浏览器通过订阅/结果查询观察，不把接入超时解释为业务失败。取消只停止后续工作，已持久受理的操作必须通过结果 API 判断是否执行。不得无限重试、无限队列或用熔断器绕过授权；分区恢复不延长凭据。

## 6. 兼容升级、容量与整洁性

- API/事件携带显式版本。升级采用 `expand → 新旧版本双兼容 → 切换消费者 → contract`；数据库只做可回滚的前向扩展，破坏性收缩在备份恢复演练和旧版本退场后执行。代理版本至少兼容相邻一个发布窗口；不兼容时拒绝操作并显示升级要求。
- 默认发布顺序：备份/校验 → 组合根兼容扩展 → 网关/控制面 → 端点代理分批 → 门户静态资源 → 契约收缩。回滚逆向进行，但不回滚已写入的新格式；先恢复兼容服务，再按已演练的数据恢复方案处理。
- 回滚由兼容 DAG 而非简单“逆序”决定：正常回滚先恢复可读新旧格式的服务端，再回滚调用方；服务端损坏先恢复最后兼容服务和存储副本；模式定义已写入时优先 roll-forward，禁止旧二进制读取未知格式。任何元数据恢复都创建新的 recovery epoch，全量撤销恢复点前的会话/能力/租约，旧幂等键不可继续写；端点传输日志与中心 intent/outbox 对账后才能恢复传输。
- 第三阶段须定义 SQLite 写队列/WAL 检查点、每设备控制会话、文件传输并发、临时空间/清理、状态订阅背压和审计保留的容量模型、10×目标与通过阈值；真实压测在对应实现完成后由 IO-03 和各集成门执行。容量到限时显式拒绝或排队，不能挤占身份/撤销通道。
- 敏感字段统一包括 Cookie、Authorization、CSRF、能力、Mesh 启动凭据、密码、私钥、原始查询串/请求体、文件内容、剪贴板正文/摘要、桌面帧、窗口标题、键鼠输入和测试录屏。网关、Mesh、容器、崩溃转储、备份和应用日志不得记录输入正文；默认禁完整桌面录屏。必要证据须最小化、加密、短保留、访问留痕并可证明销毁。活动数据库与审计目录使用最小操作系统 ACL，并以主机全盘加密或经验证的应用层加密保护；备份解密密钥不得与备份同放。
- SyncClipboard 本体只绑定 `echova` 回环地址；`clipboard-gateway` 在精确 Tailscale HTTPS 端点终止逐设备 mTLS，并把证书设备 ID、真实套接字对端和当前登记三重绑定。客户端不能直接 mTLS 时才部署普通用户回环地址连接器；其他 Tailscale 私有网络节点、错误/旧凭据和公网入口均拒绝。私网迁移通过后轮换全部服务/客户端凭据并撤销 cpolar 时期凭据，再关闭旧入口和多余监听。
- cpolar、公网 URL、客户端多余 `5033` 监听和尖峰配置是迁移项；`operations` 工作包必须逐项记录负责人、备份、验证证据、删除条件与恢复办法。环境事实不得承担未来规范。

## 7. 需求与质量门追踪

| 范围 | 唯一责任模块 | 关键依赖 | 最早门 | 必须保留的证据 |
|---|---|---|---|---|
| A01–A02 身份与会话 | `identity` | 入口端、LocalAPI、SQLite | G1 | 伪造/未登记拒绝；登录限速；退出/改密/撤销/到期递归终止 |
| A03–A06 登录前控屏、生命周期、画面 | `remote-desktop` | 身份模块、代理、Mesh、PathPolicy | G0 能力；G3 集成 | 三机重启与安全桌面；普通/异常结束锁态；锁屏三态；分辨率/无音频/坐标 |
| A07 + N01–N03/N05 选路与控屏 | `control-plane`（策略）、`remote-desktop`（执行） | 代理路径事实、Tailscale、Mesh | G2 契约；G3 实链路 | 六条有向来源→目标、控屏切网 15 秒、实际业务路径/RTT/丢包与状态真实性 |
| A08–A10 文件边界与操作 | `file-fabric` | 身份模块、代理、PathPolicy | G4 | 三来源×三目标；句柄级对抗测试；批量逐项/部分成功；6 条跨机复制且无跨机移动 |
| A11 + N04 大文件恢复 | `file-fabric` | 代理、租约、临时空间、PathPolicy | G4 | >3 GB 上传/下载/跨机复制、切网 60 秒续传、SHA-256、原子提交、空间不足 |
| A12 回收站 | `file-fabric` | 平台 Trash 适配、身份模块 | G4 | 文件/非空目录/NAS；Unsupported 后二次确认；无恢复/清空入口 |
| A13 SyncClipboard | `clipboard` | 代理、门户、运维模块 | G5 | 三项健康、三机传播、断线恢复、两台 Ubuntu 的 24h `Super+V` |
| A14 恢复与回滚 | `operations` | 入口端、协调器、两类代理、备份 | G6 | 逐组件重启、版本/配置恢复、会话不延长、输入不重放、隔离目录外摘要不变 |
| QG01 整洁 | `operations`（证明），各模块（执行） | 所有入口/配置/文档 | 各门持续；G6 汇总 | 所有权扫描、依赖/入口清单、迁移项退出证据、无重复规范 |
| QG02 可持续 | `operations` | 技术评估、版本矩阵、三机实测 | G0 起；G6 汇总 | 官方来源/日期、版本锁、升级/替换路径、依赖与镜像审计 |
| QG03 复用 | `control-plane` 与契约所有者 | 两个以上消费者 | G2–G5 | 输入/输出/错误/权限/版本契约测试与真实多调用方证据 |

“最终总验收”不能替代最早门。某门失败时，只能修复该层或执行已记录的候选替换流程，依赖它的后续模块不得继续构建。

## 8. 安全门

| 编号 | 最早门 | 通过条件 |
|---|---|---|
| SG01 Origin/入口隔离 | G0/G1 | 门户与 Mesh 独立源站；Cookie/Authorization/CSRF/身份头不跨路由；普通 Mesh 登录、管理界面、绕过 WS 和未登记节点全部拒绝 |
| SG02 对象归属与 IDOR | G2–G4 | 操作、游标、search、challenge、desktop/evidence、租约、transfer/manifest/chunk/result 每次查询/取消/提交均全量复核统一 `ResourceBinding` 的父会话、来源/目标、作用域、撤销/租约代次和到期；跨主体/旧代次负测通过 |
| SG03 根信任与秘密 | G1 | 无默认密码；一次性本地引导；设备替换事务撤销旧身份；秘密不进 argv、环境字面量、仓库、镜像、URL 或日志；恢复后轮换 |
| SG04 文件审计一致性 | G4 | 意图回执、端点持久化日志、事务发件箱在全部崩溃切点不丢审计、不重复执行，并能返回 partial/unknown 与恢复动作 |
| SG05 敏感数据与证据 | 各门持续/G6 | 数据分类、最小 ACL、静态保护、日志允许字段、证据加密/保留/访问/销毁均有自动检查和样本复核 |
| SG06 供应链与监听面 | G0 起/G6 | SBOM、digest/hash、依赖漏洞、Tailscale Grants、进程绑定、实际监听端口和旧凭据/旧入口扫描通过 |

安全门由 [验证策略](verification-strategy.md) 的统一命令入口产生证据；模块安全文档不得另建同名但不同语义的门。

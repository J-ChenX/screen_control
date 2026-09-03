# 审查记录

## 审查会话：2026-09-03（第二阶段文档增强自审）

**范围：** 仅审查第一阶段权威需求与第二阶段架构/选型文档；项目尚无实现，因此不声称完成第五阶段代码审查。四个视角独立完成初审，随后由主审统一裁决并修文档。

### @架构师

**初审状态：** 需要修改  
**修订后状态：** 文档阻断已解决

**发现与处理：**

- [已解决/原阻断] `portal` 领域与“门户单写 SQLite”混淆，形成隐藏共享状态。— 现区分 Portal UI、后端组合根和领域 repository/schema/migration，见 [ARCHITECTURE.md](../../ARCHITECTURE.md) 与 [全局关注点 §1](../../appendix/global-concerns.md)。
- [已解决/原阻断] 身份登录生命周期、状态读取/订阅、普通远控结束、撤销强制终止等 L1 契约缺失。— 已补齐 `Login/Logout/ChangePassword`、snapshot/subscribe、`EndDesktop` 和持久派生撤销链。
- [已解决/原阻断] 网络选路无唯一所有者。— `control-plane.PathPolicy` 现为唯一策略 tool，代理只采集事实，远控/文件/门户只消费。
- [已解决/原阻断] 集成超时、重试、陈旧状态、网络分区、升级/回滚和背压未定义。— 已集中到 [全局关注点 §5–§6](../../appendix/global-concerns.md)，第三阶段负责锁定具体预算。
- [已解决/原警告] cpolar/多余 `5033` 迁移缺少退出证据，环境事实文档含规范性“最终处理顺序”。— 已把规范移到架构附件；环境审计仅保留事实、风险和权威入口。

### @业务分析师

**初审状态：** 需要修改  
**修订后状态：** 文档阻断已解决

**发现与处理：**

- [已解决/原阻断] A01–A14/QG01–QG03 只有最终总验收，没有责任模块和最早验证门。— 已增加 G0–G6 及完整追踪矩阵，见 [全局关注点 §7](../../appendix/global-concerns.md)。
- [已解决/原阻断] A02 登录、首页状态、A05 普通/异常结束、A10 批量逐项结果、A12 `TrashUnsupported → 二次确认 → PermanentDelete`、文件审计均无完整契约。— 已在 L1 接口表和全局附件落位；跨设备移动显式禁止。
- [已解决/原阻断] 远控验收仅覆盖三个被控端，不能证明任意来源控制另外两台。— A07 和 G0/G3 现要求 6 条有向来源→目标旅程。
- [已解决/原阻断] A14 有“反向代理”却无组件。— 明确第一方 `edge-gateway` 是 `identity` 运行组件，由 `operations` 独立部署、重启和验收。
- [已解决/文档过时] D05 的 Xorg 权威引用错误。— `_INDEX.md §4.2` 已补上批准基线，决策记录改为正确引用。
- [已解决/原警告] A13 健康枚举漂移、架构重复维护需求不变量、SyncClipboard 版本未锁。— 统一为“服务/文本/历史文件”三项，架构声明仅作需求投影，目标版本锁为 3.2.0 且保留 A13 实测门。

### @安全工程师

**初审状态：** 需要修改  
**修订后状态：** 文档阻断已解决；远控可行性仍受 G0 约束

**发现与处理：**

- [已解决/原阻断] Mesh UI/WS 可绕过门户双门，启动令牌缺少目标/租约绑定和泄漏防护。— 所有 Mesh 浏览器路由只能经 `edge-gateway`；凭据必须一次性、极短期、desktop-only、绑定来源/目标/租约并实际关闭通道。官方 URL token 与此冲突，故列为 G0 硬门。
- [已解决/原阻断] 浏览器直连文件代理的 Cookie/CORS/peer 身份边界不闭合。— 端点改为无 Cookie、受保护头能力、精确 Origin、socket peer `WhoIsForIP`，每请求和提交重验。
- [已解决/原阻断] 跨机复制可接受任意地址且缺双端授权，存在 SSRF/IDOR 风险。— 只按登记设备 ID 解析固定端点、禁止重定向，并共同绑定源读/目标写/清单/租约。
- [已解决/原阻断] 字符串规范化不能防 TOCTOU。— 强制逐组件 no-follow 的句柄解析，并在变更/提交前重验对象与父目录。
- [已解决/原阻断] 会话到能力/通道/传输缺少持久撤销链与防重放。— 新增父 ID/撤销代次、绝对到期、幂等键和操作摘要。
- [已解决/原警告] 临时对象配额、秘密全链路日志、下载主动内容隔离和 Argon2 DoS 防护缺失。— 已写入 [全局关注点 §3–§6](../../appendix/global-concerns.md)。

### @领域专家（技术可持续性与实时网络）

**初审状态：** 需要修改  
**修订后状态：** 有条件通过

**发现与处理：**

- [已解决/原阻断] “最新即最好”的版本基线不够稳健。— Go 生产线改为 1.26.8、CI 前探 1.27.1；React/Node 精确锁为 19.2.8/24.20.0；SyncClipboard 3.2.0 仍必须通过 A13，不能假定修复已有 hash mismatch。
- [已解决/原阻断] SQLite driver 和底层版本未锁，WAL 可能落入 SQLite ≤3.51.2 的已知 WAL-reset 缺陷。— 选择仅服务端使用的 `mattn/go-sqlite3` v1.14.50（内嵌 3.53.4），禁系统动态替换并在启动时双重断言版本；记录了与纯 Go driver 的取舍。
- [已解决/原不准确] `MeshCentral/MeshAgent 1.2.5` 把服务器版本误套到 Agent。— 改为 server 1.2.5 + 各平台 Agent 构建哈希、禁自动升级、金丝雀发布。
- [已解决/原警告] Tailscale 与 Docker 只有泛化选择或旧环境事实，缺精确安全基线。— 目标分别锁定 Tailscale 1.102.3（含同版 Go module、`WhoIsForIP`/`Client.GetCertificate`）和 Docker Engine 29.7.2；环境审计保留当前 Docker 29.6.1 并标明升级门。
- [开放/阻断] 原版 MeshCentral 1.2.5 没有 Tailscale-only ICE 策略，入口网关和 `PathPolicy` 不能控制已建立的 P2P 媒体。— G0 必须用端点防火墙/进程绑定做正常、切网与对抗性验证；需要长期 fork 或 TURN-only 时淘汰候选。
- [开放/阻断] 官方 `allowLoginToken` 使用 URL token，与“凭据不进 URL/Referer/日志”冲突。— G0 必须证明后端交换或等价的无 URL 单次启动机制；需要长期 fork 时淘汰候选。

## 跨专家分歧

无未裁决分歧。业务视角建议新增网络模块，架构视角建议复用控制面；依据 QG03 和当前体量，裁决为 `control-plane` 拥有唯一 `PathPolicy`，不新增第九模块。安全与技术视角均要求对 MeshCentral 采用更严格的失败关闭门，已按严格方处理。

## 解决清单

- [x] 领域/部署进程/SQLite 单写边界与审计所有权
- [x] L1 生命周期、状态读取、批量/回收站及普通结束契约
- [x] 唯一 `PathPolicy`、集成失败矩阵、版本窗口、容量和迁移退出
- [x] 文件代理 CORS/能力、双端复制授权、TOCTOU、撤销和防重放
- [x] A01–A14/QG01–QG03 的最早门与证据追踪
- [x] Go/Node/React/SyncClipboard/SQLite 精确可持续基线
- [ ] G0：Mesh WebRTC 仅经 Tailscale 的端点级强制与对抗性证据 — 负责人：远控工作流
- [ ] G0：不经 URL/Referer/日志的 Mesh 单次启动交换 — 负责人：身份与远控工作流

## 总体状态：有条件通过

所有可由第二阶段文档修复的阻断和过时项均已解决；两项与 MeshCentral 原版能力有关的阻断无法靠文档宣称消失，已前置为 G0。G0 通过前不把 MeshCentral 称为最终选型，也不进入依赖该内核的全面实现。本结论不代表代码、部署或 A01–A14 已通过。

## 审查会话：2026-09-03（第三阶段文档预审）

**执行方式：** 用户未要求多 Agent，按 Codex 降级隔离协议由 `@文档审查员` 只检查文档质量；不声称完成代码或第五阶段审查。

### @文档审查员

**初审状态：** 需要修改  
**修订后状态：** 通过

**发现与处理：**

- [已解决/原阻断] G0 被同时描述为一个逻辑包和两个 4 小时实验单元，导致工作包计数与 2–4 小时边界不一致。— 已正式拆为 `RD-01a`、`RD-01b`，父级统计修正为 25 个工作包。
- [已解决/原警告] `portal` 已展开为目录且处理会话与危险操作编排，却缺少独立安全视角。— 已新增 `modules/portal/security.md` 并从主文档引用。
- [已解决/原警告] 技术评估仍写“18–24 个、尚未细化”，需求索引仍把协议实机验证表述为第二阶段动作。— 已区分第二阶段估算与第三阶段 25 包事实，并把实机验证定位到 G0/后续门。
- [确认] 8 个模块均有主入口；7 个展开模块均有 `README.md`、`architecture.md`、`security.md`，`clipboard` 作为 76 行单文件保留内嵌视角。
- [当时确认，已被中期复审推翻] 4 条交付流覆盖 25 个唯一工作包；表面估时均写为 2–4 小时，但中期审核确认多项工作包的范围、依赖和真实历时不满足该边界，见下方“中期框架审核”的 `@质量负责人` 结论。
- [确认] 全部本地 Markdown 链接可解析；所有未来代码位置均明确标记 `[计划中 — 代码尚未存在]`，未将 MeshCentral 写成已通过或最终选型。

**开放项：** 无文档质量阻断。G0 两项技术阻断保持原样，属于第四阶段实证门而非第三阶段文档缺口。

## 审查会话：2026-09-03（中期框架审核）

**范围：** 用户在第三阶段门控前发起中期审核。仓库目前只有架构、模块和工作包文档，无实现、测试、锁文件或部署脚本；本轮判断的是“框架是否足以安全进入第四阶段”，不声称代码或 A01–A14 已通过。`@架构师`、`@安全工程师`、`@质量负责人` 由独立 Agent 审查，`@业务分析师` 独立核对需求与用户旅程，最后统一汇总。

### @架构师

**状态：** 需要修改

**发现：**

- [阻断] G0 范围在总架构、技术评估、远控模块和 RD-01a/b 之间不一致：部分文档要求同时验证登录前控屏、desktop-only、六旅程、输入/画面约束，实际两个工作包只覆盖 Tailscale-only WebRTC 与无 URL 启动交换。— `docs/ARCHITECTURE.md:78`、`TECHNOLOGY_EVALUATION.md:55-62`、`remote-desktop/README.md:10-12`、`private-web-remote-remote/_INDEX.md:11-16` — 修复：建立唯一 G0 清单，逐项绑定工作包、阈值、失败动作和证据。
- [阻断] `identity` 的 L1 依赖表声明无依赖，但其 L2 又依赖 `control-plane` 签发租约/关闭通道，且工作包先完成 identity 再完成租约，形成未登记反向依赖与构建环。— `docs/ARCHITECTURE.md:47-48`、`modules/identity/architecture.md:52-58`、`private-web-remote-portal-control/_INDEX.md:17-20` — 修复：由组合根编排租约后再签发派生凭据，或倒置为稳定 `LeaseVerifier` port，并同步依赖图与前置关系。
- [阻断] 第三阶段承诺“具体字段和错误码已定义”，实际仍是 `Principal/Binding/Scope/Manifest/Change` 等不可独立实现的占位类型，多数接口没有 wire envelope、错误返回、状态码映射和兼容规则。— `docs/ARCHITECTURE.md:60-73`、`modules/identity/architecture.md:18-27`、`modules/file-fabric/architecture.md:19-33` — 修复：先建立唯一、可生成且可测试的契约源，再让文档引用它。
- [阻断] `SelectPath` 允许消费者提交 `pathFacts`，与“仅认证代理提交事实、消费者只消费统一决策”冲突。— `docs/ARCHITECTURE.md:65`、`modules/control-plane/architecture.md:18-24`、`modules/control-plane/security.md:9-16` — 修复：拆为代理专用事实摄入和消费者只读决策接口；决策读取控制面权威快照并返回事实版本。
- [阻断] Portal 的统一 10 秒 API 超时短于远控建连 15 秒及文件搜索/块请求 30 秒，违反全局 deadline 规则。— `modules/portal/architecture.md:24-29`、`modules/remote-desktop/architecture.md:37-40`、`modules/file-fabric/architecture.md:46-53` — 修复：定义端到端 deadline tree；长操作快速返回 ID 后异步订阅，并提供结果查询/取消语义。
- [阻断] QG02 的证据链仍不完整：远控和 SQLite 有候选比较，其余关键选型多为“推荐理由 + 版本链接”，缺少统一的候选、拒绝理由、目标环境和替换触发矩阵。— `private-web-remote/_INDEX.md:146`、`TECHNOLOGY_EVALUATION.md:28-39` — 修复：IO-01 前补齐决策矩阵。官方源抽查确认当前所列主要版本存在，问题是证据完整性而非版本失实。
- [警告] Clipboard 健康既进入 control-plane 快照，又可由 Portal 直读 clipboard projection，存在双权威路径。— `modules/control-plane/README.md:21,32`、`modules/clipboard.md:45-53`、`docs/ARCHITECTURE.md:69` — 建议：固定唯一数据流和版本来源。
- [警告] 10×容量模型、全部跨进程失败预算、唯一回滚 DAG 与恢复 epoch 尚未闭合；24 小时元数据 RPO 可能丢失撤销、审计和幂等账本。— `modules/operations/architecture.md:29-43`、`appendix/global-concerns.md:41-58` — 建议：在 IO-01/IO-03 前明确负载维度、资源阈值、恢复后全量撤销和幂等处理。

### @业务分析师

**状态：** 需要修改

**发现：**

- [阻断] A10 要求跨目录/跨卷移动发生部分成功时准确报告，但 `ItemResult.status` 只允许 `succeeded|failed|unknown`，无法表示“目标已复制、源删除失败”等可恢复事实。— `private-web-remote/_INDEX.md:133`、`modules/file-fabric/README.md:32-38`、`modules/file-fabric/architecture.md:21-33` — 修复：为单项结果增加 `partial` 或结构化 `effects/sourceState/destinationState/recoveryAction`，并覆盖幂等重试。
- [阻断] A11 的浏览器直连大文件下载/续传旅程没有闭合契约：当前只有 `StartTransfer/PutChunk/CommitTransfer`，缺少查询已确认块、恢复、取消和最终结果查询；同时未说明跨 Origin 浏览器如何在仅请求头携带 capability 的条件下把 >3 GB 下载流式落盘。— `private-web-remote/_INDEX.md:134`、`TECHNOLOGY_EVALUATION.md:78-86`、`modules/file-fabric/architecture.md:21-31,37-40` — 修复：先做浏览器能力尖峰并补齐 transfer lifecycle API；不满足三台目标浏览器时回到数据面方案选择。
- [警告] `LockAndExit` 在 `Failed/Unknown` 时也结束控制，是架构新增的产品行为；权威需求只要求不得误报成功，没有明确失败时是否应保留会话供用户重试。— `private-web-remote/_INDEX.md:57-59`、`modules/remote-desktop/README.md:20-22` — 建议：实现前由用户确认“失败仍退出”或“保留短时只读/重试窗口”。
- [确认] 除上述两条数据面语义外，A01–A14、N01–N05 和 QG01–QG03 均已有责任模块、最早门和聚合证据入口；当前问题主要是契约可执行性，不是模块漏项。

### @安全工程师

**状态：** 需要修改

**发现：**

- [阻断] Mesh 与 Portal 的浏览器 Origin 隔离未闭合。若只按路径代理，Mesh 或其依赖失陷可同源调用 Portal API，Portal Cookie 也可能进入 Mesh。— `docs/ARCHITECTURE.md:19-21`、`appendix/global-concerns.md:10-11,27`、`modules/portal/security.md:8,17-18` — 修复：使用独立 Mesh Origin；网关清除 Portal Cookie/Authorization/CSRF 和外来身份头，拒绝 Mesh `Set-Cookie`，分别锁定 framing/CSP，并纳入 RD-01b。
- [阻断] 远控对象没有像文件对象一样定义服务端归属/IDOR 复核；`EndDesktop`、`LockAndExit`、`ReadDesktopEvidence` 不能只依赖不透明 session ID。— `modules/remote-desktop/README.md:32-39`、`modules/remote-desktop/security.md:5-21` — 修复：每次 HTTP/WS/证据读取复核父会话、来源节点、目标、租约代次、scope 和到期，并补跨主体负测。
- [阻断] 普通用户文件代理需要调用 `WhoIsForIP`，但没有最小权限访问 tailscaled LocalAPI 的方案；直接授予完整 socket/命名管道能力会破坏普通用户隔离。— `appendix/global-concerns.md:28,35`、`modules/platform-agent/security.md:7-10`、`modules/operations/security.md:7-10` — 修复：设计只暴露身份查询的特权 helper 或设备级 mTLS 双绑定，helper 不可用时失败关闭。
- [阻断] 远端文件变更后再写中心审计无法兑现“审计失败则变更失败关闭”，中心失败时远端操作不能回滚。— `appendix/global-concerns.md:12-13,49`、`modules/file-fabric/README.md:22,38` — 修复：中心先持久化 intent，代理以受限 durable journal 幂等执行，结果经 outbox 重传，并定义各崩溃切点。
- [阻断] 初始密码、设备登记/替换的根信任流程仅写“本机离线管理/部署时生成”，缺少操作者认证、无默认密码、秘密输入、审计、旧身份事务撤销及恢复流程。— `modules/identity/security.md:7-13`、`private-web-remote/_INDEX.md:92-100,149-151` — 修复：定义一次性本地 bootstrap 和受限运维身份，禁止 argv/环境字面量泄密。
- [阻断] SyncClipboard 私网迁移没有定义逐设备认证、未登记 Tailnet 节点拒绝、加密方式、旧公网凭据轮换/撤销和负向门。— `modules/clipboard.md:63-67`、`private-web-remote-integration-ops/_INDEX.md:19-25` — 修复：在 G5/A13 加入公网、其他 Tailnet 节点、错误/旧设备凭据及多余监听拒绝测试。
- [警告] 在线数据库、相对文件路径审计、屏幕帧/输入事件/测试录屏、内部签名上下文和全局残余风险的保护级别仍不足。— `appendix/global-concerns.md:58`、`modules/operations/architecture.md:41-43`、`modules/identity/architecture.md:31-34` — 建议：补静态加密/目录权限、证据保留销毁、签名 audience/method/path/body/requestId 与集中威胁模型。

### @质量负责人

**状态：** 需要修改；不建议通过第三阶段门控

**发现：**

- [阻断] FF-01 要实现 SafeFS，却只依赖 PA-01；SafeFS/回收站适配实际属于 PA-02。— `private-web-remote-files/_INDEX.md:11`、`modules/platform-agent/README.md:45-46` — 修复：FF-01 显式依赖 PA-02，或重新划清机制所有权。
- [阻断] IO-02 表面位于 IO-01 后，但 A13 实际依赖 PA-01、PC-04、PC-08 和 Portal 集成；当前“G5/A13”不是可执行的前置关系。— `private-web-remote-integration-ops/_INDEX.md:11-13`、`appendix/global-concerns.md:71` — 修复：拆迁移夹具与健康/UI/A13 集成，并写工作包 ID 依赖。
- [阻断] G0 前没有可复现的 Windows、浏览器、Tailscale、GPU/显示、内核及防火墙能力基线；其系统级防火墙改动也没有先验 watchdog/回滚演练，正式 IO-04 又在 G1–G5 之后。— `ENVIRONMENT_AUDIT.md:79-88`、`private-web-remote-remote/_INDEX.md:11-18`、`private-web-remote-integration-ops/_INDEX.md:14` — 修复：IO-01 增加只读三机 preflight，并把可验证救援/自动回退作为 RD-01a 前置。
- [阻断] IO-02 的 4 小时定义不能包含 A13 的 24 小时观察窗；RD-03、FF-05、IO-05 同样把多平台、多网络、多故障矩阵压进单个 4 小时包。— `private-web-remote/_INDEX.md:136`、各子任务工作包表 — 修复：区分工程工时与墙钟时间，按平台/门/soak 拆包并设置独立恢复点。
- [阻断] 全仓没有可执行测试命令、CI 矩阵或每包证据契约；当前只有计划目录和聚合验收编号。— `modules/operations/architecture.md:14,45-47`、四个子任务“完成定义” — 修复：在 IO-01 定义统一入口、单元/契约/跨平台/E2E/soak 分层、环境、阈值、产物和清理步骤。
- [阻断] A01 要验证公网及“其他 Tailnet 设备”拒绝，但当前 G1 只写三节点身份证据，也没有预定义可用的未登记/失效节点测试主体。— `private-web-remote/_INDEX.md:124`、`ENVIRONMENT_AUDIT.md:80`、`private-web-remote-portal-control/_INDEX.md:27` — 修复：预建临时未登记节点、失效旧节点身份和公网探针，分别验证 Grants、网关和应用层。
- [警告] A02 的 7 天会话、租约、TTL、重连等时间测试未统一要求可注入时钟；证据耐久存储、A07 P95/丢包统计口径、浏览器/构建/测试工具版本也未锁定。— `modules/identity/security.md:27-31`、`modules/operations/architecture.md:41-43`、`private-web-remote/_INDEX.md:130,146` — 建议：IO-01 一并固化虚拟时钟策略、证据仓、统计脚本和完整 toolchain manifest。
- [警告] “服务 60 秒恢复 readiness”与“单组件 RTO ≤30 分钟”名称相近但语义不同。— `modules/operations/architecture.md:38-39` — 建议：分别命名自动恢复 SLO 与人工灾难恢复 RTO，并绑定不同测试。

## 跨专家分歧

| 分歧 | 专家 A | 专家 B | 状态 | 裁决 |
|---|---|---|---|---|
| G0 应包含哪些能力 | 架构/质量：当前四处定义冲突 | 既有预审：只保留两项开放阻断 | 已在整改中裁决 | 唯一 G0 只含登录前/安全桌面、Tailscale-only、desktop-only、独立 Origin + 无 URL 启动四门；六旅程/输入/画面属于 G3 |
| “锁屏并退出”失败/未知时是否结束会话 | 当前模块：仍结束控制 | 业务：权威需求未明确 | 已在整改中裁决 | 以最小暴露为准：三态均停发输入并结束；Failed/Unknown 明示未锁且须新会话重试 |

## 已当场修正的文档问题

- [x] `TECHNOLOGY_EVALUATION.md` 将操作租约误写为 `file-fabric` 所有；已修正为 `control-plane` 拥有租约、`file-fabric` 拥有文件审计事件。
- [x] `global-concerns.md` 误把真实容量压测写成第三阶段义务；已修正为第三阶段定义模型/阈值，IO-03 和集成门执行真实压测。
- [x] 既有预审记录中“所有工作包均满足 2–4 小时”的结论已标注为被本次中期复审推翻。

## 解决清单

- [x] 统一 G0 清单、工作包、证据和失败动作，并补 G0 前环境基线与可回滚网络改动 — 已落到 8 个 `RD-01*` 包和 `IO-01a`–`IO-01d`
- [x] 消除 identity ↔ control-plane 依赖环，修正 FF-01、IO-02 等跨流依赖 — `LeaseAssertion` 离线验签，68 包依赖均可解析
- [x] 建立可生成的唯一 wire contract；修正 PathPolicy 事实入口、deadline tree、结果查询与兼容规则 — 见 `appendix/protocol-contracts.md`
- [x] 补齐 `ItemResult` 部分成功语义与浏览器 >3 GB 直连续传尖峰/契约 — 新增 `FF-00`，传输 lifecycle 完整
- [x] 设计审计 intent + 端点 durable journal + outbox 的崩溃一致性协议 — 六崩溃切点有唯一协调规则
- [x] 关闭 Mesh 独立 Origin、远控 IDOR、LocalAPI 最小权限、bootstrap 根信任和 SyncClipboard 认证/轮换边界 — 见协议、安全文档和威胁模型
- [x] 拆分超载工作包与 24h soak，定义每包命令、环境、阈值、证据和清理 — 68 包均 2–4h，墙钟独立，执行段均不超过 8 包
- [x] 补 A01 未登记 Tailnet 节点与公网拒绝测试主体；补完整 QG02 决策矩阵 — 见验证工程策略与技术评估
- [x] 裁决 LockAndExit 失败/未知后的会话行为 — 三态均退出，禁止误报，重试须新会话

## 总体状态：不通过第三阶段门控（架构方向保留）

八模块边界、单一职责、总体安全取向和 G0 先行策略可继续保留，无需推倒重来；但当前仍有开放阻断，尤其是门控范围/依赖图、可执行契约、文件一致性、安全根信任和验证工程。解决清单闭合前不应批准进入全面第四阶段。可以先做一个收敛后的 IO-01（只读环境基线、仓库/测试/契约骨架和回滚保护），但不得执行 RD-01a 的系统级网络改动或依赖 Mesh 的全面实现。

## 整改会话：2026-09-03（第三阶段问题闭合）

**范围：** 只修正中期框架审核发现的第三阶段文档、契约、依赖、安全和验证工程问题；仓库仍无实现代码，本会话不声称 G0 或 A01–A14 已通过。

**已完成：**

- 新增唯一 [wire protocol contract](../../appendix/protocol-contracts.md)，固定 envelope、错误/权限、幂等/cursor/Operation、deadline tree、`DesktopBinding`、`ItemResult`、完整 Transfer lifecycle 与审计崩溃恢复。
- 新增 [threat model](../../appendix/threat-model.md)，收口独立 Origin、全浏览器凭据剥离、远控 IDOR、peer helper、bootstrap/登记、SyncClipboard mTLS 和 R0–R3 数据分类。
- 新增 [verification strategy](../../appendix/verification-strategy.md)，定义统一命令、CI/实机矩阵、虚拟时钟、A01 三类主体、A07 统计、证据仓和 toolchain manifest。
- 建立 68 个全局唯一、2–4h 的工作包及不超过 8 包的执行段；主动工时 245h，墙钟等待单列；`FF-00` 是 >3 GiB 浏览器能力的实现前淘汰门，`IO-02h` 在 G5 聚合前退役旧公网入口。
- `IO-01a`–`IO-01d` 成为 G0 全部运维前置；系统级网络规则只有在 watchdog、独立救援和自动回滚演练后才能修改。

**整改自检：** 工作包 ID 唯一，依赖引用无未解析项，本地 Markdown 链接存在，longtask validator 通过。下一步为不参与整改的独立架构、安全和质量复审；只有复审阻断为零才改变总体阶段。

## 整改后状态：等待独立复审

中期解决清单已经文档化闭合；当前仍停留在第三阶段，不把“整改完成”误写成“实现或实机门已通过”。

## 审查会话：2026-09-03（第三阶段整改后独立复审）

**范围：** 三名未参与最终整改裁决的独立 Agent 分别从架构、安全和质量视角对当前工作区只读复审；复审时不读取本 review-log，不修改文件。初轮发现的当前快照问题继续修正并重新送审，直到三方均对最新契约给出 PASS。

### @架构师

**最终状态：** 通过，第三阶段架构阻断为零

- 确认 G0 四门/八包、构建顺序、N01–N05 责任和 IO 无回跳分段已统一。
- 确认跨设备复制已收敛为唯一 `target-pull` 数据流：单一 source/GET data plane，目标 agent 直连源端并本地 staging，Portal/`echova` 不中转正文。
- 确认 Transfer owner/executor 互斥绑定和 `ack-range` 已闭合：只有正确 target executor 在块摘要与 journal fsync 后推进 confirmed ranges。

### @安全工程师

**最终状态：** 通过，第三阶段安全阻断为零

- 确认 Portal/service/agent 三种 `ResourceBinding` 为互斥判别联合，service/agent cursor 无需伪造 Portal 会话且有跨 audience/service/部署代次/重放负测。
- 确认新增 target executor 使用 `(subjectKind,subjectBindingDigest,route,Idempotency-Key)` 独立幂等账本，不借用 owner `principalId`。
- 确认“新鲜认证下的同 key/同摘要安全重试”与“旧上下文/request ID/`jti`/proof/单次 capability 重放拒绝”已明确区分，校验顺序为认证/撤销/binding 先于 ledger。

### @质量负责人

**最终状态：** 通过，第三阶段质量阻断为零

- 重算 68 个全局唯一工作包、245h 主动工时，每包 2–4h；171 条包级依赖无悬空、无环。
- 确认 12 个执行段全覆盖且均不超过 8 包，IO 分段为 5/6/6/7 且无后向跨段依赖。
- 确认 G0 恰为八个尖峰包并传递依赖 `IO-01a`–`IO-01d`；runner 自举链、A01 主体、A07 统计、A13 传播/soak/退役、QG02 映射均已闭合。

### 主审最终静态校验

- longtask validator 通过。
- 68 个工作包 ID 唯一，总工时 245h，单包全部 2–4h；171 条显式包级依赖无未解析引用且 DAG 无环。
- 164 个 Markdown 链接已检查，所有本地目标存在；无双数据面、旧工作包计数、旧 peer helper 命名或已知阶段状态残留。

## 最终状态：通过第三阶段门控，可进入第四阶段

第三阶段文档、契约、依赖、安全和验证工程阻断已清零。当前正式执行入口是 `IO-01a`：只读 bootstrap preflight recorder 与三机脱敏 snapshot。本结论仅批准开始第四阶段，不表示 G0、实机部署、功能代码或 A01–A14 已通过。

---

## 审查会话：2026-09-03（第四阶段全量实现审查）

**执行方式：** Codex 降级隔离协议，按专家顺序独立审查；本会话审查第四阶段是否具备进入第五阶段的真实条件，不因文档已规划而把代码缺失视为完成。

### @架构师

**状态：** 需要修改

**发现：**

- [阻断] 第四阶段尚未形成可运行系统：68 个工作包中只有 `IO-01a` recorder 有实现，`identity`、`control-plane`、`platform-agent`、`remote-desktop`、`file-fabric`、`clipboard`、`portal` 的代码仍全部为计划占位；因此 G0–G6、8/8 模块神经和第五阶段入口均不成立。修复：严格按 `ARCHITECTURE.md` DAG 完成全部工作包、实机门和文档代码指针，不允许用 mock 或计划文档代替实装。
- [阻断] `IO-01a` 的环境 snapshot 已封存但 `jiang-chenx` Windows Time 未同步且 UTC 偏差超过 2 秒，按验证策略必须停止后续实机门。修复：先恢复可靠时间同步，再用当前固定 recorder hash 重跑完整三机 bundle。
- [阻断] bootstrap 历史 provenance 不完整：bundle 只保存 recorder hash，不保存产生该 bundle 的精确 recorder 与 pin；当前 `verify-bundle` 还把“与当前 recorder 不同”作为完整性错误，导致早期失败 run 在 recorder 升级后无法独立验 seal，与“重跑不覆盖首次失败、正式 runner 可导入”的契约冲突。修复：每个新 bundle 内封存 recorder/pin 副本；seal 完整性与“是否当前版本”分开报告，正式导入按受信 recorder hash 策略判定。
- [阻断] recorder 依赖本机 `python3`，但 manifest 未记录解释器实现/版本/可执行 hash；相同脚本 hash 在不同 Python 运行时上的编码、JSON、时间或 subprocess 行为不能被复算绑定。修复：manifest 写入 Python implementation/version/executable/hash，并在 `IO-01b` toolchain lock 与 `IO-01c` importer 中建立允许版本。
- [文档过时] operations 架构写成“snapshot 脱敏后签名”，当前 bootstrap 只具 hash seal，不具签名者身份或不可否认性。修复：明确 `IO-01a` 是 hash-sealed bootstrap，签名只由 `IO-01c` 正式 evidence signer 在导入/重验后产生。
- [警告] 当前目录还不是 Git 仓库，而正式证据 schema 要求 Git commit；这是 `IO-01b` 仓库/构建基线的显式前置工作，未解决前 `IO-01c` 不得签发正式证据。

### @业务分析师

**状态：** 需要修改

**发现：**

- [阻断] snapshot 的完成判定只统计每类“退出码为 0 的探针数”，不验证摘要是否含所需业务事实；空浏览器列表、空 GPU/显示字段、空规则表或不相关的成功查询都可能把类别标为 complete。修复：为 OS/显示/GPU/浏览器/Tailscale/防火墙/端口/权限/时钟/磁盘分别定义语义 validator 和必填字段，validator 结果进入 snapshot、测试和总门。
- [阻断] 三机 `tailscale version --json` 命令成功，但当前 parser 输出均为 `{}`，因此 daemon/CLI 精确版本并未进入 snapshot，与 `IO-01a` 可交付内容不符。修复：兼容实际 Tailscale JSON 字段并断言 CLI/daemon 版本非空。
- [阻断] `IO-01a` 被定义为“只读确认当前三台登记节点”，但 `tailscale_status` 只筛选并展示匹配 peer，不验证 Self 身份、固定 Tailscale IP、另外两台 peer 是否全部存在/在线，也不因意外第四节点或目标漂移给出明确诊断。修复：以固定 node inventory 做语义核验，输出 expected/observed/missing/unexpected；只有三台预期节点身份完整时登记节点事实才 complete。
- [阻断] Windows session 摘要用英文 `Active` 匹配本地化 `quser` 输出，当前真实 snapshot 报 `hasActive=false`，但同一 snapshot 同时显示活动 3840×2160 桌面；这是错误的机器事实。修复：不解析本地化状态词，改用稳定 API/数值会话状态，或把不可可靠判定明确记为 unknown，不能写 false。
- [阻断] 当前 category 通过不等于“可执行相应平台尖峰”：Linux 编码器探针缺失、完整 firewall 规则读取失败等事实未形成 `spikeBlockers`，后续执行者可能把 snapshot complete 误当 G0 环境已就绪。修复：把采集完整性与环境就绪性分成两个状态，列出 unknown/unavailable facts 及其阻断的工作包；可选工具缺失只有在存在等价事实来源时才能降级为非阻断。
- [警告] Windows Time 未同步不仅是单次偏差问题；即使某次采样偶然回到 2 秒内，来源仍为 Local CMOS Clock 且无成功同步时间。修复：时钟门同时检查偏差和同步健康，防止偶然值绕过后续证据时序要求。

### @安全工程师

**状态：** 需要修改

**发现：**

- [阻断] SSH 命令依赖用户全局配置的默认 host-key 策略，代码未显式设置 `StrictHostKeyChecking=yes`，因此 README 所称“existing, host-key-checked”并非 recorder 自身可证明的安全属性。修复：固定严格 host-key 检查、固定 known_hosts 输入并把两台目标的 host-key fingerprint/hash 写入 manifest；未知或变化立即失败。
- [阻断] 脱敏声明称“non-approved IPs”均被隐藏，但实现只处理 IPv4；snapshot 当前保留完整 Tailscale IPv6，通用文本还可能泄露其他 IPv6、裸用户名和本地化诊断中的标识。修复：使用结构化字段 allowlist，补 IPv6/用户标识脱敏与对应负测；manifest 的 redaction 声明必须和真实覆盖面一致。
- [阻断] `verify-bundle` 信任 `seal.json` 中的任意文件名并跟随符号链接，未拒绝绝对路径、`..`、目录和 bundle 外目标；未来 `IO-01c` 若复用会形成不安全导入边界。修复：只接受固定文件集合/严格 basename，使用 `lstat` 拒绝 symlink，解析后确认每个目标仍在 run 根内，并限制大小/JSONL 行数。
- [阻断] hash seal 只能检测“seal 未被重算”的偶然损坏，不能证明操作者或抵抗可写本机上的整体替换；当前文档部分位置把它描述成签名。修复：bootstrap 明确标为未签名输入；`IO-01c` 在重验后用独立证据签名密钥签发正式 index，并把 signer/key ID、签名和销毁/轮换规则纳入契约。
- [阻断] recorder 未在生成 snapshot 后执行敏感模式扫描，也未记录 evidence 根权限断言；固定 allowlist 降低了风险，但 parser/本地化输出回归仍可能把秘密或 R2 标识写入摘要。修复：封存前对全部摘要执行 fail-closed 扫描，记录扫描规则 hash、结果与 run 根 owner/mode；任何命中隔离该 run 而非发布普通 bundle。
- [警告] Windows 远程查询为每个 probe 设置 `ExecutionPolicy Bypass`。当前脚本固定且无任意输入，风险有限，但此放宽没有必要性证据；应验证删除后是否仍可运行，若必须保留则在 threat model 记录理由和边界。

### @质量负责人

**状态：** 需要修改

**发现：**

- [阻断] 现有 5 项测试只覆盖 pin、简单危险词扫描、单个 IPv4/路径脱敏、基本 tamper 和部分节点状态；没有以三平台真实 fixture 覆盖各 parser、语义 category gate、GB18030/UTF-16、本地化会话、时钟同步、SSH 失败、timeout 或 probe 缺失。修复：把本次脱敏 snapshot 派生为无敏感 fixture，逐 parser/gate 建立确定性回归测试。
- [阻断] 5 个历史 bundle 中只有最新 recorder 生成的一个能通过当前 `verify-bundle`；4 个首次失败证据因 recorder 更新而统一 FAIL，无法区分“seal 损坏”与“非当前 recorder”。这违背失败证据保留与可复核要求。修复：拆分 `integrityValid`、`trustedRecorder` 和 `currentRecorderMatch`，并为历史/未知/篡改三类 fixture 测试结果。
- [阻断] bundle 没有声明 JSON Schema 或固定文件集合，`verify-bundle` 也不校验 manifest/index/snapshot/commands 的字段、类型、数量、runId 一致性和重复 probe；删字段后重算 seal 即可被视为 valid。修复：添加版本化 schema 与跨文件不变量校验，并以删字段、重复行、错 node/runId、超大输入负测。
- [阻断] recorder 对 stdout/stderr 使用无界 `subprocess.run(..., PIPE)` 聚合；防火墙、路由或异常工具输出可耗尽控制机内存。修复：流式读取并设置单 probe 字节上限，超限时终止、记录 hash/截断状态并失败关闭。
- [阻断] 时钟门只采一个样本并把单向返回延迟全部算入负偏差，临界 2 秒时可能误阻断；也没有 clock 算法 fixture。修复：至少采 3 次、记录 RTT，使用最小 RTT 样本和明确不确定区间；同步健康独立判定。
- [警告] `exclusive_write` 对文件执行 `fsync`，但创建文件和封存后未 `fsync` run 目录；突然断电时 seal/目录项耐久性不明确。修复：每个阶段完成后 fsync 目录，并以中断点 fixture 验证不完整 run 永不被 importer 接受。
- [警告] `IO-01c` runner、scenario schema、CI 和正式 evidence importer 尚不存在，因此当前测试命令只是 bootstrap 自测，不是工作包正式证据；在其落地前必须保持这一状态区分。

## 跨专家分歧

无。四个视角均认为当前不能进入第五阶段；关于 bootstrap hash seal 与正式签名的边界，以更严格的安全结论为准：`IO-01a` 产物仅是待导入的 hash-sealed 输入，`IO-01c` 重验后才签发正式证据。

## 解决清单

- [x] `R4-01` 修复 `jiang-chenx` Windows Time 同步并重跑三机 `IO-01a` — 双 NTP peer 同步健康，candidate run 三机时钟门通过
- [x] `R4-02` 加固 recorder provenance/runtime、严格 SSH host key、结构化脱敏、固定安全导入路径和封存前敏感扫描 — recorder/pin/schema/runtime 随 bundle 封存，安全 verifier 与扫描通过
- [x] `R4-03` 为十类环境事实建立语义 validator、三平台 fixture、同步健康与多样本时钟门、输出上限和跨文件 schema 校验 — 15 项回归测试与三台实机采集通过
- [ ] `R4-04` 完成 `IO-01b` 仓库/构建/toolchain/SBOM 基线，正式记录 Git commit 与 Python bootstrap runtime — 负责人：operations
- [ ] `R4-05` 完成 `IO-01c` runner、scenario schema、CI、正式 signer/importer，并重验 `IO-01a`/`IO-01b` — 负责人：operations
- [ ] `R4-06` 按 DAG 完成 `IO-01d`、`IO-04a` 和 G0；任何系统网络改动前通过自动回滚演练 — 负责人：operations + remote-desktop
- [ ] `R4-07` 完成其余全部工作包与 G1–G6，将 8 个模块的 `[计划中]` 替换为真实代码指针 — 负责人：各模块
- [ ] `R4-08` 运行第四阶段最终多专家复审、修正文档过时项并确认 8/8 神经完成 — 负责人：review coordinator

## 总体状态：不通过第四阶段门控

`IO-01a` 已有可工作的只读 recorder 与真实三机 bundle，但其环境门和证据链仍有阻断；其余系统尚未实现。解决清单全部闭合、G0–G6 真实证据通过且模块神经为 8/8 前，不得开始第五阶段。

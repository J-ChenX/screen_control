# 验证工程策略

**最后更新：** 2026-09-03  
**状态：** 第三阶段执行契约；命令入口由 `IO-01c` 在第四阶段落地

## 1. 单一入口与工作包契约

所有工作包 ID 在四条交付流中全局唯一；依赖只引用完整 ID 或已定义的门，不使用范围缩写。每包的预计时间均为 **2–4 小时主动工程工时**，下载、重启、等待 TTL、24 小时观察等另列为墙钟时间，不得用等待填满工时。

`IO-01c` 必须首先实现以下唯一入口；在入口存在前只允许执行自举链 `IO-01a`、`IO-01b`、`IO-01c`，`IO-01d` 必须等待正式入口和前三包正式证据：

```bash
./ops/verify/run work-package <WORK_PACKAGE_ID> \
  --environment <ENVIRONMENT_ID> \
  --release deploy/releases/current/toolchain.lock.json

./ops/verify/run gate <GATE_ID> \
  --environment <ENVIRONMENT_ID> \
  --release deploy/releases/current/toolchain.lock.json
```

启动链只有一个受控例外：`IO-01a` 的第一交付物是仓库内、允许列表固定且经人工复核哈希的 `ops/bootstrap/preflight`；它只能执行 [环境审计](../tasks/private-web-remote/ENVIRONMENT_AUDIT.md) 允许的只读查询，并把脚本哈希、命令、stdout/stderr 摘要、退出码、操作者和机器时间写入追加式引导记录包。`IO-01b` 只可用同一引导记录器留下构建/toolchain/SBOM 骨架证据；`IO-01c` 的运行器自测通过后必须导入并校验两份记录包，然后以正式场景重新验证 `IO-01a` snapshot/hash 和 `IO-01b` 清单，签发正式前置证据。任何命令超出允许列表、记录包缺字段/hash 不同或正式复核不一致，`IO-01a`/`IO-01b` 均视为未完成并阻断 `IO-01d`/G0。`IO-01c` 以已知测试夹具自举验证自身 schema/签名/清理；除这三个引导包外，没有工作包可绕过正式运行器。

每个工作包场景必须在 `ops/verify/scenarios/<WORK_PACKAGE_ID>.yaml` 声明并由入口校验：前置 ID/门、允许环境、测试层、命令、夹具、超时、通过阈值、敏感级别、清理命令和期望工件。任何前置未通过、清单漂移、证据缺字段、清理失败或隔离目录外摘要改变都使该包失败关闭。人工步骤也必须由场景驱动并记录操作者、时间与复核结果，不能只写在聊天或自由文本里。

## 2. 测试分层与规范命令

| 层 | 规范命令 | 环境 | 通过阈值与产物 |
|---|---|---|---|
| 单元 | `./ops/verify/run suite unit` | Linux CI；纯 Go/TS 可含 Windows CI | 全部通过；Go 竞态覆盖并发包；JUnit、coverage、日志 |
| 契约 | `./ops/verify/run suite contract --version v1` | Linux CI，生产/相邻版本矩阵 | provider/consumer、错误、权限、版本全部通过；契约报告与模式定义哈希 |
| 浏览器组件 | `./ops/verify/run suite web` | 锁定 Node 与 Chromium/Firefox/WebKit | 全部通过；追踪、截图、axe 报告，敏感字段扫描为零 |
| 跨平台集成 | `./ops/verify/run suite platform --target <node>` | `nix`、`echova`、`jiang-chenx` | 每个目标单独判定；JUnit、系统摘要、服务日志 |
| 安全负测 | `./ops/verify/run suite security --scenario <id>` | 隔离测试环境/三机 | 所有禁止动作拒绝且无副作用；请求/网络/审计证据 |
| 端到端 | `./ops/verify/run suite e2e --journey <id>` | 三台登记节点和锁定浏览器 | 旅程阈值逐条通过；浏览器追踪、业务通道统计、端点日志 |
| 容量/故障 | `./ops/verify/run suite resilience --scenario <id>` | 隔离数据与可回滚服务 | 达到 10× 模型时显式拒绝/排队且撤销通道不饥饿；资源曲线、注入记录 |
| 恢复 | `./ops/verify/run suite recovery --scenario <id>` | 备份副本/金丝雀 | 分别验证就绪状态 SLO 与灾难恢复 RTO；时间线、完整性和代次证据 |
| 观察窗 | `./ops/verify/run suite soak --scenario <id> --duration 24h` | 三台实机 | 观察期内阈值无违例；心跳、事件、漂移与最终清理报告 |

门命令只聚合已经签名且与同一 release/environment 匹配的工作包证据，不重新执行未声明的隐式步骤。G0 是远控候选淘汰门，唯一清单见[远控子任务](../tasks/private-web-remote-remote/_INDEX.md)；G3 才执行输入、画面、生命周期、网络统计和六条完整旅程。

## 3. CI 与实机矩阵

| 触发 | 必跑矩阵 | 不允许替代的实机门 |
|---|---|---|
| PR | Go 生产版与下一兼容版 × Linux；Go 生产版 × Windows；Node 生产版；单元、竞态、契约、网页、lint、依赖/秘密扫描 | 无 |
| 主分支 | PR 矩阵 + Linux/Windows 构建产物、SBOM、迁移 fresh/upgrade/rollback、Compose smoke | 无 |
| 发布候选 | 三台真实节点 × 其实际 OS/显示/GPU；锁定 Chromium、Firefox、Windows Edge；安全负测、E2E、备份恢复 | G0、G3、G4、G5、G6 不得由容器或模拟代替 |
| 夜间/观察 | 24h SyncClipboard 长稳测试、容量/故障矩阵、依赖与镜像重扫 | 真实登录前/安全桌面、WebRTC 路径和跨机文件旅程仍在对应实机包执行 |

CI 可以并行，但同一目标上的桌面控制、网络规则和恢复场景必须持有独占环境租约。测试失败重跑必须生成新运行 ID 并保留首次失败证据，不得覆盖成通过。

## 4. 虚拟时钟与真实时间

- Go 领域代码只依赖统一 `Clock` 端口（墙钟 `Now()` + 单调计时器）；TypeScript 客户端只依赖统一 scheduler。生产适配器使用系统时钟，单元/契约测试注入可推进时钟。
- A02 的 7 天绝对到期、会话/派生能力/租约 TTL、撤销传播、重连退避、限速窗口、游标保留和恢复 epoch 必须用虚拟时钟覆盖边界前、边界点、边界后及墙钟回拨；这些测试不能真的等待 7 天。
- 真实网络 RTT、重启恢复、G3 每条 10 分钟旅程和 A13 的 24 小时观察必须使用单调真实时间。虚拟时钟不得用于伪造性能或长稳测试证据。
- 三机预检记录 UTC 偏差；偏差超过 2 秒时实机门停止，先修复环境。证据同时保存 UTC 时间与单调历时。

## 5. A01 测试主体

`IO-01a` 只读确认当前三台登记节点；`IO-01c` 建立下列不含生产秘密的夹具，`PC-10` 执行拒绝矩阵：

| 主体 | 身份 | 要证明的边界 |
|---|---|---|
| 未登记 Tailscale 私有网络节点 | 临时、无应用登记、无生产 tag/capability；测试后注销 | Grants/入口和应用层均不能建立网页、API、WS、Mesh 或文件代理会话 |
| 失效旧节点身份 | 临时节点先登记后撤销/重登记，保存旧证书/节点 ID 的隔离副本 | 旧身份在所有入口立即拒绝且不能复用新设备名 |
| 公网探针 | 不登录 Tailscale 私有网络的一次性 CI runner/受控主机，无项目凭据 | 公网 DNS/IP/Host/Origin/转发头探测不能到达有效应用会话 |

夹具名称、租期、审批人和销毁回执进入证据；不得把其他人的真实设备当作负测主体，也不得为测试扩大生产 Grants。

## 6. A07 统计口径

- 六条来源→目标旅程逐条判定，不合并或平均掩盖单条失败。每条在连接稳定后预热 30 秒，再以 1 Hz 采集连续 600 秒；少于 600 个有效样本、断线、未解释的 ICE 重协商或输入中断均失败。
- RTT 优先取浏览器 `RTCPeerConnection.getStats()` 中已选候选项配对的 `currentRoundTripTime`；原生不提供时，才用同一受控业务通道的应用心跳。`tailscale ping` 只记录映射背景，不能作为 A07 RTT。
- P95 使用最近秩：对 600 个 RTT 排序取第 `ceil(0.95 × N)` 个。丢包使用窗口内计数器增量 `lost / (received + lost)`；计数器重置或分母为零使该旅程失败。
- 每条旅程必须同时满足 P95 ≤150 ms、丢包 ≤1%、连续操作 10 分钟无断线。外部网络导致的降级必须保留原始失败结果，并由用户明确接受，工具不得自动改写阈值。
- 输出原始 JSONL、计算脚本版本/hash、汇总 JSON、图表、已选候选项配对与端点抓包哈希；统计脚本由 `IO-01c` 固定并在 CI 用已知数据集回归。

## 7. 证据存储与保留

运行产物写入受限的 `evidence/<run-id>/`；仓库只提交脱敏后的索引/复现说明，原始敏感工件存入 `echova` 的加密、0700 运维卷，并备份到独立加密位置。目录固定包含 `index.json`、`manifest.json`、`commands.jsonl`、`results/`、`artifacts/` 和 `cleanup.json`。

`index.json` 至少包含 run/work-package/gate、Git 提交、发布与工具链哈希、环境快照哈希、前置证据哈希、开始/结束 UTC 与单调历时、命令退出码、阈值/实际值、敏感级别、清理结果、操作者/复核者和所有工件 SHA-256。索引完成后签名并追加写；重跑不覆盖旧运行。

通过门的索引、清单、结果和清理回执至少保留 180 天且不少于当前版本退役后两个发布窗口。路径事实和已脱敏抓包属于 R2，默认 30 天后销毁原件，只保留 hash/脱敏摘要；屏幕帧、键值/输入文本和真实内容默认禁止成为证据。仅合成内容、显式批准的测试录屏按威胁模型独立加密并在 7 天内销毁。失败证据至少保留至问题关闭后 30 天，但不能借失败名义延长 R3 原件。销毁动作本身生成回执；不得把 Cookie、能力凭据、剪贴板内容、文件正文或密码写入索引。

## 8. 完整工具链清单

`IO-01b` 创建 `deploy/releases/current/toolchain.lock.json`，之后每次验证都校验其哈希。以下字段均为必填；目标环境尚未解析的字段会阻断相应实机包，不能写 `latest`、浮动 tag 或“系统默认”。

- 发布模式定义、Git 提交、构建时间、目标 OS/arch；Go 生产/兼容版本、modules/checksums、CGO、C 编译器与 linker；
- Node、Corepack/包管理器、TypeScript、React、构建器、测试器、锁文件哈希；Chromium/Firefox/WebKit/Edge 与自动化驱动版本；
- SQLite 编译/运行时版本及 compile options、迁移 head；Tailscale daemon/CLI/Go 模块；
- MeshCentral 容器镜像摘要、Node 基础镜像摘要、三平台 MeshAgent 二进制 SHA-256；`screen-control-peer-helper` 三平台 hash/服务沙箱/IPC 模式定义；SyncClipboard 三客户端/服务端、mTLS 网关和条件连接器的版本/二进制哈希；
- Docker Engine、Compose plugin、镜像摘要、基础镜像、systemd/PowerShell/Windows Service wrapper；
- 三机操作系统构建、kernel、桌面/session、显示分辨率/缩放、GPU/驱动/编码器、防火墙后端；
- Git、Bash、PowerShell、OpenSSL、curl、jq、tcpdump/tshark、ffprobe 与证据签名/加密/SBOM/漏洞扫描工具版本；
- 每个工具的官方来源、许可证、支持状态核验日、允许升级窗口、替换触发器和 SBOM/provenance 哈希。

目标版本以[技术候选评估](../tasks/private-web-remote/TECHNOLOGY_EVALUATION.md)为准；清单负责锁定本次发布的精确解析值，不另建第二份技术选型。

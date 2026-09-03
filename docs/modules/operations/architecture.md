# Operations — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划位置 |
|---|---|---|
| `ReleaseManifest` | 版本、digest、Agent hash、schema 与兼容窗口 | `deploy/releases/` |
| `ToolchainLock` | 构建/测试/浏览器/实机工具的精确版本、来源、hash、SBOM 与替换触发 | `deploy/releases/<release>/toolchain.lock.json` |
| `Preflight` | G0 前 hash 固定的三机只读采集、脱敏 snapshot、追加式 bootstrap bundle 与 seal 复核；后续部署预检仍在 `IO-01b+` 扩展 | `ops/bootstrap/preflight:73-154`, `ops/bootstrap/preflight:451-1173` |
| `NetworkChangeGuard` | 规则快照、独立救援、定时 watchdog、跨节点确认与自动回退 | `ops/network-guard/` |
| `DeployOrchestrator` | 有序装配、金丝雀、健康门和幂等恢复 | `ops/deploy/` |
| `BackupRestore` | SQLite online backup、配置/卷/历史及恢复验证 | `ops/backup/` |
| `Observability` | 分项健康、指标、脱敏日志和证据索引 | `internal/operations/observability/` |
| `AcceptanceHarness` | G0–G6、安全对抗、故障注入和隔离目录保护 | `ops/verify/` |
| `MigrationLedger` | cpolar/5033/尖峰配置等退出条件与清理证据 | `ops/migrations/` |

## 发布与兼容

发布顺序固定为：备份/校验 → SQLite/协议兼容扩展 → edge/control → 单台金丝雀 agent → 其余 agent → Portal 静态资源 → 观察 → contract。API/事件显式主版本，代理至少兼容相邻一个发布窗口；更高主版本或缺必填能力时拒绝操作并显示升级要求。

平台代理发布时，最小系统身份 `screen-control-peer-helper` 先于普通用户文件 agent；helper 只经受 ACL 保护的本机 IPC 返回绑定当前连接、PID/UID 或 SID、nonce、audience 和短到期的 peer 证明，不转发 LocalAPI、不得接受任意 IP/节点查询。SyncClipboard 先发布 echova 的 Tailscale mTLS gateway，再探测原生客户端能力；仅当原生客户端不能完成 mTLS 时才发布普通用户 connector。connector 只能接收本机用户 IPC 并连接 manifest 中唯一 gateway，不能成为通用 HTTP/SOCKS 代理。

回滚不逆写新格式：先恢复能读取新旧格式的兼容服务，再回滚调用方；破坏性 schema 收缩只有旧版本完全退场且恢复演练通过后执行。

## 配置与端口

- 配置分 `dev/test/prod` schema，生产秘密只以文件路径/凭据句柄引用。
- 端口不在本文臆定；部署时由 `Preflight` 选择并写入唯一 manifest，明确排除 8080、现有 5033 和非 Tailscale/LAN 裸绑定。
- 健康端点分 liveness/readiness/component，不返回秘密、绝对路径或原始网络证据。

## G0 前环境与网络变更保护

`IO-01a` 在三台目标机只运行允许列表中的只读命令，记录 OS build/内核/架构、启动与桌面 session、显示分辨率/缩放、GPU/驱动/编码器、浏览器、Tailscale 版本/地址/路径、防火墙后端与进程级能力、监听端口、权限、UTC 偏差、磁盘和恢复入口。bootstrap snapshot 经脱敏、敏感扫描和 hash seal 后作为待导入输入；它不具签名者身份。其 hash 在 `IO-01c` 正式 runner 重验并由 evidence signer 签名后，才成为 G0 的 environment ID；任一必填事实未知则不允许执行相应平台尖峰。

系统级网络规则只允许由 `NetworkChangeGuard` 修改：先从另一登记节点验证独立 SSH/控制救援，保存规则与连通性 hash，安装不依赖新规则成功的定时自动回退，再事务式应用；另一节点同时确认允许路径、禁止路径和救援仍通后才取消回退。`IO-01d` 必须先故意触发一次失联并在 5 分钟内恢复原规则；未通过时 `RD-01a-L`/`RD-01a-W` 禁止运行。

## 容量与 SLO

| 项目 | 基线 | 门 |
|---|---|---|
| 组合根 SQLite | 写队列 1024；WAL 64 MiB checkpoint | 队列/磁盘压力不阻塞身份撤销 |
| 远控 | 每目标 1 会话 | 第 2 个请求明确拒绝 |
| 文件 | 每设备 2 活跃 + 4 排队；临时空间 ≤ 可用 10%且保留 10 GiB | 空间/队列耗尽安全失败 |
| 状态订阅 | 每连接 128 条缓冲 | 慢消费者重同步，无无界内存 |
| 审计 | 在线 180 天后归档 | 恢复后可验证连续性 |
| 自动 readiness 恢复 SLO | 在依赖与数据均完整的单进程 crash/重启场景，从进程退出至 readiness 恢复 ≤60 s | 自动化故障注入；不含人工动作/数据恢复，不延长会话、不重放输入 |
| 人工灾难恢复 RTO | 从操作者声明灾难并启动 runbook，到备份恢复、完整性校验、凭据/恢复 epoch 轮换且 readiness 恢复 ≤30 min | 独立恢复演练；不得用 60 s 自动恢复测试代替 |
| 数据 RPO | 普通元数据备份 RPO ≤24 h；配置/秘密每次变更前备份 | 恢复后对备份点之后状态一律视为未知：全量撤销旧会话/租约/能力，未完成文件操作进入幂等对账，审计标记恢复缺口 |

容量负载的 10× 维度由 `IO-03b` 固定为：SQLite/审计写入率与队列深度、并发登录/撤销、每设备控制请求、文件活跃/排队与临时空间、状态订阅者与慢消费者。每项分别加压到上表限制的 10 倍请求量；通过条件是资源上限内有界、超限显式拒绝或排队、身份撤销 P95 不因其他队列超过 2 s，且停止负载后 60 s 内回到稳态。

跨进程故障矩阵由 `IO-03c` 维护唯一失败预算：edge/control/agent/Mesh/文件代理/SyncClipboard 分别注入 kill、断网、磁盘满、重复/乱序旧消息；恢复 epoch 单调增加，旧会话/输入/写能力不得重放，结果未知的文件操作必须经幂等账本查询或人工对账后才能重试。

## 验证与证据结构

`IO-01c` 实现唯一命令 `./ops/verify/run work-package <ID> ...` 与 `gate <GATE_ID> ...`。测试分 unit、contract、web、platform、security、e2e、resilience、recovery、soak；PR/主分支/发布候选/夜间矩阵及三机实机不可替代项见[验证工程策略](../../appendix/verification-strategy.md)。A02 的长 TTL 用统一可注入虚拟时钟；A07 和 24h soak 必须使用真实单调时间。

每次运行输出 `evidence/<run-id>/index.json`（本地受限产物，不默认入库），绑定 Git commit、release/toolchain/environment/前置证据 hash、命令退出码、开始结束 UTC 与单调历时、阈值/实值、敏感级别、清理结果和工件 SHA-256。通过索引签名并追加写，重跑生成新 ID 且保留首次失败。原始抓包、日志与屏幕录制进入 0700 加密运维卷及独立加密备份；仓库只记录脱敏摘要和可复现说明。保留/销毁时限及 A01 主体、A07 nearest-rank 统计只在验证策略维护。

`ToolchainLock` 的字段覆盖 Go/CGO/编译器、Node/前端依赖与锁文件、四类浏览器/驱动、SQLite/migration、Tailscale、MeshCentral/三平台 Agent、`screen-control-peer-helper`、SyncClipboard gateway/条件 connector、Docker/Compose/基础镜像、三机 OS/内核/桌面/显示/GPU/防火墙和所有抓包/媒体/签名/SBOM 工具；禁止 `latest`、浮动 tag 和“系统默认”。字段不全或实际版本/hash 漂移即相应工作包失败。

## 当前与计划文件结构

已存在：`ops/bootstrap/preflight`、`ops/bootstrap/preflight.sha256`、`ops/bootstrap/README.md` 与 `tests/operations/test_bootstrap_preflight.py`。计划中：`deploy/{compose,systemd,windows-service,releases}/`、`ops/{preflight,network-guard,deploy,backup,verify,migrations}/`、`internal/operations/observability/` 及其余 `tests/operations/` 内容。

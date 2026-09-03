# File Fabric — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `NamespaceService` | 根/卷、分页列表、搜索与对象元数据 | `internal/files/namespace/` |
| `MutationService` | 创建、覆盖、改名、复制、移动、删除与逐项结果 | `internal/files/mutation/` |
| `TransferService` | manifest、块确认、Range、恢复与提交 | `internal/files/transfer/` |
| `DeviceCopyCoordinator` | 双端授权、固定设备解析、代理直传 | `internal/files/devicecopy/` |
| `ConflictService` | 对象 identity/mtime/size 前置条件、自动改名 | `internal/files/conflict/` |
| `AuditService` | 中心 intent/receipt、端点 journal 与 outbox 协调 | `internal/files/audit/` |
| `FileRepository` | transfer/audit schema、migration、outbox | `internal/files/store/` |

平台代理中的 `SafeFS`、`TrashAdapter` 和 `FileEndpoint` 是执行边界；本模块拥有业务规则，二者不得各自复制策略。

## 契约

唯一 wire schema 是[协议契约 §2–§5、§9](../../appendix/protocol-contracts.md)，本文件不维护平行签名或错误枚举。所有潜在长操作在 3 s 内返回 `Operation`，通过通用查询/SSE/取消闭合；传输另有 Start/Query/Resume/Abort/Result/Commit 完整生命周期。

`ItemResult` 必须报告 `succeeded|partial|failed|unknown` 和结构化 `effects/sourceState/destinationState/recoveryAction`。`partial` 是单项已确认产生部分 effect（典型为同设备跨卷 move 已提交目标而源删除失败），不是批量混合结果的别名；相同幂等键只能查询/协调原执行，不能再次复制或删除。`TrashResult` 内部状态仍为 `trashed|unsupported|failed`，只有 `unsupported` 可进入永久删除准备流程。

## 对象与传输状态

- 对象引用使用不透明 ID + 目标设备 + 卷 + 文件系统 identity；路径只作展示和重新解析输入。
- transfer：`prepared → receiving → verifying → committing → completed`；任一阶段可 `paused|failed|aborted|unknown`。只有最终提交后最终文件名可见；权威确认 ranges 只包含 journal fsync 后的块。
- 已确认块集合与 manifest hash 持久化；恢复先重新授权并复核父代次、两端设备、目标前置条件和现有块摘要。
- 跨设备 copy 固定为 `target-pull`：每次 Transfer 只签发源端 `GET` 数据面与一项 capability，目标代理通过受保护控制通道取得后主动连接固定源代理，把响应流写入本机排他 staging，在块摘要与 journal fsync 后以绑定 target executor 身份推进 confirmed ranges；源端不得代表目标确认落盘。Portal/`echova` 不中转正文，也不存在第二条数据流。禁止重定向和任意 host/port。
- 浏览器下载以 Web Worker + 自定义 Authorization header + `ReadableStream` + File System Access API 直连端点，secret 仅在内存；三台目标浏览器的 >3 GiB、≤256 MiB 额外内存、切网恢复及正文不经 Portal 是 `FF-00` 前置硬门，详见协议契约 §9.2。

## 预算与容量

| 项目 | 数值 | 行为 |
|---|---|---|
| 分页 | 默认 200、最大 1000 项 | 超限截断并返回 cursor |
| 搜索 | 每 slice 最多 100k 对象或 30 s | 3 s 内同步完成，否则返回 operation；结果带可继续 cursor |
| 批量 | 每批最大 100 项 | 3 s 内返回 operation；终态逐项报告 effects |
| 块大小 | 默认 8 MiB，协商范围 1–32 MiB | manifest 固定后不可变 |
| 在途块 | 每传输最多 4；每设备 2 传输 | 背压或最多 4 个排队 |
| 块请求 | 30 s | 未确认块可重传，确认块不得重复写 |
| 路径变化恢复 | 60 s 旅程上限 | 从最后确认块恢复 |
| transfer 生命周期 | 活跃 24 h；暂停最长 24 h | 过期需新 transfer，受控清理临时对象 |
| SQLite/WAL | 写队列 1024；busy 2 s；WAL 64 MiB 触发 checkpoint | 审计写满则安全变更失败关闭 |
| 审计保留 | 180 天，按月归档；备份后清理 | 清理不影响活动幂等结果 |

## 审计模型

唯一提交语义为“中心 intent → 绑定 intent 的 capability → 端点 durable journal 分阶段 fsync → durable outbox → 中心审计/结果/receipt 同事务 → agent ack”。中心 intent 事务失败时端点没有执行权限；远端 effect 已发生而中心暂不可用时保持 `running/unknown` 并重传，不谎报失败或自动重做。跨卷 move 用目标提交与源移除两个协调点准确形成 `partial`。六个崩溃切点、恢复动作、`AuditReceipt` 字段和允许审计字段见[协议契约 §9.3](../../appendix/protocol-contracts.md)。

## 计划文件与测试

`internal/files/{namespace,mutation,transfer,devicecopy,conflict,audit,store}/`、`internal/contracts/v1/`、`tests/files/`。wire 类型从唯一协议源生成。属性/竞态测试覆盖路径穿越、TOCTOU、链接环、断点、重复块、哈希错、空间不足、跨卷部分成功、六个审计崩溃切点和撤销。均为 `[计划中 — 代码尚未存在]`。

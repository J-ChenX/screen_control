# Control Plane — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `StatusIngestor` | 认证上报、单调序号、时钟偏差与分项状态 | `internal/control/status/` |
| `SnapshotStore` | 领域快照、cursor 与 outbox | `internal/control/store/` |
| `SubscriptionHub` | 有界订阅、背压、重同步 | `internal/control/subscription/` |
| `LeaseManager` | 操作冲突、短租约、续租与撤销 | `internal/control/lease/` |
| `PathPolicy` | 唯一路径分类、优先级、防抖、原因 | `internal/control/pathpolicy/` |

## 契约

唯一 wire schema 是[协议契约 §2–§7](../../appendix/protocol-contracts.md)。实现边界分成两个不可混用的 port：`IngestAgentReport` 只接受认证 agent 的组件/路径事实；`ReadPathDecision` 只接受 `flow/sourceDeviceId/targetDeviceId` 并从 `SnapshotStore` 读取事实，调用方不能提交 facts、时钟或标签。输出总是携带 `factsVersion/validUntil/reasonCode`，消费者不得重算。

租约输出采用签名 `LeaseAssertion`。control-plane 通过 identity 验证已有主体，但不会请求 identity 为它签发对象；组合根把 assertion 交给 identity 派生 capability，从而保持 `control-plane → identity` 单向依赖。

## 状态机

- 心跳序号必须单调；旧序号只计诊断，不覆盖新事实。
- 设备 agent：最后有效上报超过 15 s 标为 stale，超过 30 s 标为 offline。单项 `ComponentFact` 使用协议契约 §7 的 freshness：host/desktop/files 15 s，clipboard.service/text/history-file 30/90/180 s；过期单项为 `unknown`，不因设备仍在线沿用旧绿色。
- LAN 候选须连续 5 s 通过身份映射及真实握手后才切入；当前路径失败立即切出。
- 同级候选用业务 RTT、丢包及失败历史比较；独立 `tailscale ping` 只作诊断。
- 切换发布 `from/to/reason/observedAt/evidenceRef`，消费者不得重算标签。

## 预算与容量

| 项目 | 数值 | 超限行为 |
|---|---|---|
| 代理心跳 | 每 5 s，±20% 抖动 | 15 s 陈旧，30 s 离线 |
| 状态请求 | 2 s | 返回带陈旧标记的最近快照或显式不可用 |
| 每订阅缓冲 | 128 条 | 丢弃增量并发 `ResyncRequired`，不阻塞摄入 |
| SQLite 写队列 | 1024 项；busy 总预算 2 s | `CAPACITY_EXCEEDED`；身份/撤销优先队列不共用 |
| 远控租约 | 30 s，10 s 续租 | 失效即停止输入并关闭通道 |
| 文件变更租约 | 60 s，20 s 续租 | 停止新块/新变更，保留受控临时对象 |
| 同目标远控 | 1 个 | 冲突明确拒绝 |
| 每设备活跃传输 | 2 个，另最多 4 个排队 | 排队超 30 s 拒绝 |

## 数据与兼容

表归属为 `control_device_facts`、`control_path_facts`、`control_path_decisions`、`control_leases`、`control_outbox`。wire 类型从[协议契约](../../appendix/protocol-contracts.md)生成到 `internal/contracts/v1/`；兼容窗口、版本 header 和升级顺序遵循其 §10，未知安全枚举、缺失 binding 或更高主版本失败关闭。

## 计划测试

确定性虚拟时钟覆盖稳定窗、抖动、接口变化、事实乱序、慢订阅和重启；契约负测必须证明 Portal/remote/files 提交 `facts` 字段会被拒绝。N01–N05 真实证据由集成任务消费同一 `PathDecision`，不得另建测试专用策略。

# Control Plane — 状态、租约与选路

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

汇聚三台代理的分项事实，并提供唯一的状态快照/订阅、操作租约和 `PathPolicy` 决策。

## 核心流程

| 场景 | 流程 |
|---|---|
| 状态/路径事实上报 | 认证代理 → `StatusIngestor` 校验设备绑定、单调序号与时间 → 更新权威事实 → 发布版本化快照 |
| 页面订阅 | 授权主体 → 当前快照 + cursor → 有界事件流 → 慢消费者收到重同步标记 |
| 获取租约 | 会话/目标/操作 → 冲突与容量检查 → 短租约 → 续租或失效 |
| 自动选路 | `PathPolicy` 只读取已提交权威事实 → 候选分类 → 5 秒稳定窗/立即失败回退 → 带 `factsVersion` 的决策 |

## 业务规则

- 在线是分项状态：主机、desktop、files、clipboard 分别有采集时间和陈旧标记；不能用单一绿灯替代。
- `PathPolicy` 是优先级、防抖、标签与切换原因的唯一实现；只有认证 agent 可提交事实，远控、文件和门户请求中不得携带 `pathFacts`，只能按来源/目标读取决策。
- 同一目标首版最多一个远控控制租约；文件操作租约可并存但受设备容量限制。
- 陈旧或未知路径不得标为直连；分区时拒绝新的远控、删除、覆盖和最终提交租约。
- 租约失效不重放请求或输入；续租不能突破父会话绝对到期。

## 对外契约

字段、route、envelope、错误、权限、幂等、cursor 和 deadline **只**由[协议契约 §2–§7](../../appendix/protocol-contracts.md)定义。本表仅索引所有权。

| 接口组 | 权威条目 | 消费者 |
|---|---|---|
| 认证事实摄入 | agent `control/reports` | `platform-agent` |
| 快照/订阅 | `control/snapshot`、`control/events` | `portal`、领域模块 |
| 只读选路 | `control/path-decisions/{flow}/{source}/{target}` | remote、files、portal |
| 租约 | `control/leases` acquire/renew/release | 组合根、remote、files |

状态机和预算见[架构](architecture.md)，权限边界见[安全](security.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| PC-04（4h） | 状态模型、心跳摄入、快照与有界订阅 | 首页分项状态、A14 |
| PC-05（3h） | 操作租约、冲突矩阵、撤销联动 | A02、A05、A10 |
| PC-06（4h） | `PathPolicy` 契约、事实分类、防抖与测试夹具 | N01–N05、QG03 |

所属交付流见 [门户与控制面任务](../../tasks/private-web-remote-portal-control/_INDEX.md)。

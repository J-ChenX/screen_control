# 子任务：门户与控制平面

**父任务：** [private-web-remote](../private-web-remote/_INDEX.md)  
**状态：** 第四阶段待执行；等待 `IO-01a`–`IO-01d` 与 G0 通过  
**范围：** `identity`、`control-plane`、`portal`

## 继承目标与边界

本流不重新发现需求，完整继承父任务 A01–A02、N01–N05、QG01–QG03 及跨模块契约。它交付安全入口、会话/撤销、状态与租约、唯一 `PathPolicy` 和 UI 壳，不实现平台代理、文件系统或远控内核。

## 工作包规则

下表 ID 在全项目唯一；“主动工时”不含 CI 排队、重启和观察等待。所有包都必须通过 `./ops/verify/run work-package <ID> ...` 执行其同名场景，并按[验证工程策略](../../appendix/verification-strategy.md)保存命令、阈值、工件和清理回执。`G0` 指[远控流唯一 G0 清单](../private-web-remote-remote/_INDEX.md)全部通过。

执行按两个有界段恢复：`PC-A = PC-01..PC-06`（6 包，身份/控制面 checkpoint），`PC-B = PC-07..PC-11`（5 包，Portal 与 G1/G2 证据 checkpoint）。段内仍严格按下表 DAG，而非按编号盲目串行；每段结束须更新 `_ACTIVE.md` 和签名证据索引。

## 工作包

| 顺序 | ID | 模块 | 可交付内容 | 主动工时 | 明确前置 | 主要验证场景 |
|---|---|---|---|---|---|---|
| 1 | PC-01 | identity | edge socket peer、证书、设备登记、签名内部身份上下文及拒绝路径 | 4h | `G0`、`IO-01c` | 登记/未登记 peer、伪造转发头与 LocalAPI 失败关闭契约 |
| 2 | PC-02 | identity | Argon2id、限速、Cookie、CSRF 与登录/改密处理 | 4h | `PC-01` | 参数基准、限速窗口、CSRF/Cookie 负测 |
| 3 | PC-03 | identity | 会话、派生凭据、outbox 和持久撤销链 | 4h | `PC-02` | 退出/改密/设备撤销递归终止与重启恢复 |
| 4 | PC-04 | control-plane | 状态摄入、快照、订阅、cursor 与背压 | 4h | `PC-03`、`PA-01` | 乱序/重复/慢消费者/重同步契约 |
| 5 | PC-05 | control-plane | 操作租约、冲突、代次和撤销联动 | 3h | `PC-03`、`PC-04` | 并发冲突、到期、撤销和组合根编排契约 |
| 6 | PC-06 | control-plane | 唯一 `PathPolicy` 及 N01–N05 决策/失败契约 | 4h | `PC-04`、`PC-05`、`PA-01` | 五类网络事实、抖动、防回退与版本契约 |
| 7 | PC-07 | portal | React 壳、登录、路由、API/事件领域客户端 | 4h | `PC-02`、`PC-03`、`PC-04` | 登录/过期/重同步、CSP 与敏感存储负测 |
| 8 | PC-08 | portal | 设备分项状态、路径决策、降级和错误呈现 | 4h | `PC-04`、`PC-06`、`PC-07` | stale/unknown/partial 状态和键盘可访问性 |
| 9 | PC-09 | portal | desktop/files 编排、租约交接与危险确认组件 | 4h | `PC-05`、`PC-08`、`RD-02`、`FF-04a` | mock provider 的权限/冲突/结果未知/确认负测 |
| 10 | PC-10 | identity + operations | A01 未登记 Tailnet、失效旧身份与公网主体拒绝矩阵 | 3h | `PC-01`、`PC-03`、`IO-01c` | A01 全入口拒绝且无会话/租约/代理副作用 |
| 11 | PC-11 | identity | A02 7 天会话、TTL、撤销和重连的虚拟时钟矩阵 | 3h | `PC-03`、`PC-05`、`IO-01c` | 边界前/点/后、墙钟回拨、重启与旧代次拒绝 |

`PC-09` 只验证 UI 编排和稳定 provider 契约；真实远控与文件集成分别由 `RD-03a` 和 `FF-05a` 执行。A01 三类负测主体及销毁规则见[验证工程策略 §5](../../appendix/verification-strategy.md)，不能用三台已登记节点互相冒充“其他 Tailnet 设备”。

## 完成定义

- G1：`PC-01`、`PC-02`、`PC-03`、`PC-10`、`PC-11` 全部通过；A01–A02 的三类拒绝主体和虚拟时钟边界均有独立证据。
- G2：`PC-04`、`PC-05`、`PC-06` 契约测试通过；Portal 不含重复选路、租约或授权逻辑。
- 每包证据必须绑定同一 release/toolchain/environment hash；重跑不覆盖首次失败。
- 每个工作包完成时同步对应模块代码指针；实现前均保持 `[计划中 — 代码尚未存在]`。

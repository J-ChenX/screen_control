# Identity — 入口身份与会话

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

对浏览器与代理执行“双重身份”认证，并拥有会话、派生凭据及递归撤销的唯一实现；自身不依赖控制面。

## 边界

- 包含：`edge-gateway`、设备登记、密码登录、会话、派生凭据、撤销代次、CSRF 与登录限速。
- 不包含：操作授权策略、设备状态、文件路径规则、远控内核权限；分别归 `control-plane` 与对应领域模块。
- 不信任：客户端 IP/设备名、`Host`、转发身份头、查询串令牌或任意上游声称的节点身份。

## 核心流程

| 场景 | 流程 | 计划代码 |
|---|---|---|
| 浏览器进入 | socket peer → LocalAPI `WhoIsForIP` → 登记校验 → HTTPS → 门户 | `cmd/edge-gateway/`、`internal/identity/peer/` |
| 密码登录 | 节点/全局限速 → Argon2id 校验 → 建立 7 天绝对会话 → 设置安全 Cookie | `internal/identity/login/`、`internal/identity/session/` |
| 派生授权 | 组合根先取得签名 `LeaseAssertion` → identity 离线验证 assertion 与父会话 → capability / desktop-launch / channel / transfer | `internal/identity/grant/` |
| 撤销 | 退出、改密、设备撤销或到期 → 增加撤销代次 → 写持久 outbox；领域消费者订阅并自行关闭活动通道 | `internal/identity/revocation/` |

## 业务规则

| 规则 | 结果 |
|---|---|
| 节点未登记或稳定节点 ID 不匹配 | 在密码校验前拒绝，不透露登记状态 |
| 会话绝对到期 | 创建后最多 7 天；访问与服务重启均不延长 |
| 退出 | 仅撤销当前会话及其全部派生对象 |
| 改密 | 撤销所有会话、派生对象与活动通道；新密码生效后旧代次永久失效 |
| 设备撤销/替换 | 撤销该稳定节点全部身份；替换设备必须人工重新登记 |
| 派生凭据 | 最小 scope、绑定父 ID/代次、来源节点、目标、操作摘要、签名租约 assertion 与绝对到期；不得成为通用会话 |
| 日志 | Cookie、密码、令牌、查询串、请求体和私钥均不得记录 |

## 对外契约

字段、route、envelope、错误映射、权限和 deadline **只**由[协议契约 §2–§6](../../appendix/protocol-contracts.md)定义。本表仅索引所有权，不是第二份 wire schema。

| 接口组 | 权威条目 | 消费者 |
|---|---|---|
| 登录/会话 | Identity v1 `auth/*` | `portal` |
| 浏览器/代理认证上下文 | `PrincipalRef`、`AgentRef` | edge、组合根、`control-plane`、代理端点 |
| 派生 | `GrantRequest` + `LeaseAssertion` | 组合根代表各领域模块调用 |
| 撤销 | Identity v1 `identity/revocations` + 绑定 cursor | 各活动通道 |

内部组件、存储和预算见[架构](architecture.md)，威胁见[安全](security.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| PC-01（4h） | edge peer 身份、证书、bootstrap/登记表与拒绝路径 | A01、SG03 |
| PC-02（4h） | Argon2id 定标、登录限速、安全 Cookie/CSRF | A02 |
| PC-03（4h） | 会话/派生链持久化、撤销广播与重启恢复 | A02、QG03 |
| PC-10（3h） | 未登记 Tailnet、失效旧身份和公网主体拒绝矩阵 | A01 |
| PC-11（3h） | 7 天绝对会话、TTL 与撤销虚拟时钟矩阵 | A02 |

所属交付流见 [门户与控制面任务](../../tasks/private-web-remote-portal-control/_INDEX.md)。

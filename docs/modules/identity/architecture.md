# 身份模块 — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `edge-gateway` | TLS、真实对端识别、受控反代、签名内部上下文 | `cmd/edge-gateway/` |
| `DeviceRegistry` | 三台稳定节点登记、替换与撤销代次 | `internal/identity/device/` |
| `LoginService` | 密码验证、限速、CSRF 与会话签发 | `internal/identity/login/` |
| `CredentialGraph` | 派生对象、最小作用域、父链校验 | `internal/identity/grant/` |
| `RevocationHub` | 持久撤销、游标订阅、活动连接终止通知 | `internal/identity/revocation/` |
| `IdentityRepository` | 身份模块 schema/migration；只经组合根写 SQLite | `internal/identity/store/` |

## 接口与依赖倒置

跨进程字段、HTTP 路由、错误信封结构、权限、幂等和游标仅引用[协议契约 §2–§6](../../appendix/protocol-contracts.md)，本文件不维护平行签名。

身份模块是依赖图根，不导入或调用 `control-plane`。组合根负责先取得控制面签名的 `LeaseAssertion`，再提交稳定 `GrantRequest`；`CredentialGraph` 只用配置的验证公钥离线校验断言、父会话和绑定。验证器端口由 `internal/contracts/v1` 提供，测试可用固定签名夹具，因此身份模块可在控制面之前独立实现。撤销方向同样单向：身份模块提交持久事件，领域消费者订阅并关闭自己的通道，身份模块不回调租约服务。

## 状态与存储

- 表归属：`identity_devices`、`identity_password`、`identity_sessions`、`identity_derived`、`identity_revocations`、`identity_login_buckets`。
- 会话令牌和派生令牌仅保存 SHA-256 摘要；密码使用带版本参数的 Argon2id 编码。
- SQLite 事务同时提交状态变化和事务发件箱撤销事件；消费者按单调游标读取，不能仅依赖内存广播。
- `edge-gateway → portal` 只经权限受限 Unix 套接字；内部上下文以短期签名封装并绑定受众、HTTP 方法、规范路径、body 摘要、请求 ID 和绝对到期，门户逐项复核。

## 预算与容量

| 项目 | 数值 | 超限行为 |
|---|---|---|
| LocalAPI 身份查询 | 500 ms，最多 1 次 100 ms 抖动重试 | 拒绝新请求，不降级信任 IP/头部 |
| 门户/Mesh 上游连接 | connect 2 s；握手 5 s；空闲按路由独立设置 | 返回 `503` 且 `Cache-Control: no-store` |
| 密码请求体 | 8 KiB | `413` |
| Argon2id 并发 | 部署实测后固定，初始上限 2 | 排队最多 2 s，随后 `RATE_LIMITED` |
| 登录失败桶 | 每节点 5 次/15 min；全局 20 次/15 min | 指数延迟，成功不抹除全局异常信号 |
| 浏览器会话 | 7 天绝对到期 | 立即撤销派生链 |
| 普通能力凭据 | 最长 5 min | 调用方重新申请，禁止刷新旧凭据 |
| desktop-launch | 60 s、单次使用 | 使用或超时即销毁 |
| 撤销传播目标 | 2 s 内抵达进程，5 s 内关闭通道 | 超时由通道自身租约兜底关闭 |

Argon2id 的内存、迭代和并行度在 `echova` 实机以“单次目标 250–500 ms且最坏并发不触发交换”为门控，结果写入部署配置与证据，不在源码散落常量。

## 依赖与失败

| 依赖 | 用法 | 失败关闭 |
|---|---|---|
| tailscaled LocalAPI | `WhoIsForIP`、证书 | 无法确认 peer/证书时拒绝新连接 |
| SQLite | 登记、会话、派生、撤销 | 不签发；已有对象按缓存中的绝对到期与撤销代次从严处理 |
| `LeaseAssertion` 稳定契约与配置公钥 | 离线验证控制面已签发租约；无运行时调用 | 签名、绑定、代次或到期无效时不签发 |

依赖方向固定为 `control-plane → identity contract`；组合根编排两者。断言签名方不可用只阻断新租约，身份模块登录/撤销仍可独立工作。

## 计划文件结构

`cmd/edge-gateway/`、`internal/identity/{peer,device,login,session,grant,revocation,store}/`、`internal/contracts/v1/`、`tests/identity/`。传输协议类型由[协议契约](../../appendix/protocol-contracts.md)生成，不手写 `identity/v1` 副本。均为 `[计划中 — 代码尚未存在]`。

# 跨模块协议契约（唯一规范源）

**最后更新：** 2026-09-03  
**状态：** 第三阶段实现基线；代码均为 `[计划中 — 代码尚未存在]`

## 1. 权威性与生成规则

本文是 `identity`、`control-plane`、`remote-desktop`、`file-fabric` 与门户组合根之间跨进程传输协议契约的唯一规范源。模块文档只解释职责和实现，不得复制或改写字段、错误码、权限、幂等、游标、截止时间或状态枚举。冲突时以本文为准。

第四阶段先把本文等价编码为 `api/contracts/v1/openapi.yaml`、`api/contracts/v1/asyncapi.yaml` 和共享 JSON Schema，再生成 Go/TypeScript 类型；CI 必须执行“生成后工作树无差异”和跨实现契约测试。不得先手写第二套 DTO。内部函数可以使用领域类型，但跨进程必须转换到本文类型。

传输采用 HTTPS + JSON UTF-8；事件采用 SSE，二进制块采用 HTTPS body。API 前缀固定为 `/api/v1`，数据面前缀固定为 `/data/v1`。请求和响应的 `Content-Type` 必须精确匹配；未知字段可忽略，未知枚举、缺少必填字段或非 `1` 主版本必须失败关闭。本文对象中列出的字段均必填且不得为 `null`，仅带 `?` 的字段可省略；示例中的 `null` 是该字段明确允许的值。字符串默认 1–256 UTF-8 字节，`displayPath/query/text/reason` 上限分别为 4096/1024/512/256 字节；数组默认最多 100 项，另有端点上限时取更小值。

## 2. 公共类型与信封结构

ID 只定位对象，不授予权限。持久资源 ID 由其服务端所有者生成不可枚举的 128 bit 随机值，使用 `pri_/dev_/agt_/svc_/ses_/drv_/crd_/lea_/dsk_/obj_/vol_/op_/trn_/cur_/evt_/int_/aud_/prf_/dec_/chl_` 前缀；`key_` 是发布清单中固定的签名公钥 ID。`req_` 由第一受信接入层生成，`itm_` 由已认证调用方为批内逐项幂等生成，`con_`/`boot_` 由对应本机 helper/gateway 进程生成；后三类同样为 128 bit 随机 base64url 且接收方校验格式/唯一性。`fsIdentity` 是平台对象身份的受保护编码，不属于随机 ID。时间是 UTC RFC 3339（微秒可选），时长是正整数毫秒，大小/序号是 0 到 2^63−1 的 JSON 整数；服务端拒绝浮点、重复键和越界整数。签名/摘要对象先按 RFC 8785 JSON Canonicalization Scheme 编码；摘要是 SHA-256 小写 hex，签名是 Ed25519 base64url，验证密钥由运维模块配置而非 payload 自声明。

`Page<T>` 固定为 `{items:T[],nextCursor:string|null,snapshotVersion:integer}`；`ErrorRef` 固定为 `{code,messageCode,details}`，其中 `messageCode` 是本地化密钥而非依赖原文。SSE 的 `id` 等于事件游标、`event` 等于规范事件枚举、`data` 使用成功信封结构；每 15 s comment heartbeat，不携带领域状态。

浏览器可携带可选、不受信的 `X-Correlation-ID`（1–64 个安全可打印字符，仅供日志关联，不参与授权/幂等）；任何互联网/Tailnet 接入服务必须删除外部 `X-Request-ID` 和内部身份头，并在完成连接级认证后生成规范 `req_`。已认证 agent/service 主动发起的内部调用可由调用方作为第一受信 ingress 生成 `req_`，接收方按身份在有界窗口内拒绝重复。此后每个内部 HTTP 调用必须携带该请求 ID；安全写操作还必须携带 `Idempotency-Key`（16–64 个 base64url 字符）和 `X-CSRF-Token`（仅门户 Cookie 会话）。代理、数据面和内部调用不使用门户 Cookie，使用 `Authorization: Capability <opaque>` 或部署身份认证。成功响应固定为：

```json
{"apiVersion":"v1","requestId":"req_*","data":{}}
```

失败响应固定为 `application/problem+json`：

```json
{
  "type":"urn:screen-control:error:stale-object",
  "title":"无法完成请求",
  "status":409,
  "code":"STALE_OBJECT",
  "requestId":"req_*",
  "retryable":false,
  "retryAfterMs":null,
  "details":{}
}
```

`details` 只能使用对应端点模式定义的允许字段，生产响应不得含本地绝对路径、IP、凭据、调用栈或依赖原文。稳定映射如下；未列出的内部错误统一为 `INTERNAL/500`。

| HTTP | 稳定 code | 语义 |
|---|---|---|
| 400 | `INVALID_ARGUMENT`、`UNSUPPORTED_VERSION` | 格式、未知枚举或版本不可接受 |
| 401 | `UNAUTHENTICATED`、`EXPIRED`、`REVOKED` | 无有效主体；浏览器不细分 |
| 403 | `PERMISSION_DENIED`、`ORIGIN_REJECTED`、`CSRF_REJECTED`、`UNREGISTERED_DEVICE` | 主体有效但无权；登录前不泄漏登记状态 |
| 404 | `NOT_FOUND` | 对象不存在或调用者无权看见；IDOR 默认使用此码 |
| 409 | `CONFLICT`、`STALE_OBJECT`、`LEASE_CONFLICT`、`IDEMPOTENCY_MISMATCH` | 当前状态不允许 |
| 410 | `CURSOR_EXPIRED`、`OPERATION_EXPIRED`、`TRANSFER_EXPIRED` | 服务端不再保留恢复状态 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超限 |
| 422 | `SPECIAL_OBJECT`、`CROSS_DEVICE_MOVE_FORBIDDEN`、`HASH_MISMATCH`、`TRASH_UNSUPPORTED` | 格式正确但领域约束不允许 |
| 423 | `LEASE_EXPIRED` | 租约已失效，禁止继续写或输入 |
| 429 | `RATE_LIMITED`、`CAPACITY_EXCEEDED` | `retryAfterMs` 必填 |
| 507 | `INSUFFICIENT_SPACE` | 预留空间失败，未提交最终对象 |
| 503 | `DEPENDENCY_UNAVAILABLE`、`AUDIT_UNAVAILABLE`、`STALE_FACTS`、`UNKNOWN_PATH` | 失败关闭；是否可重试由 `retryable` 指明 |

## 3. 主体、权限与凭据

`PrincipalRef` 固定字段为 `{principalId, sessionId, sourceDeviceId, revocationGeneration, expiresAt}`；`AgentRef` 为 `{deviceId, agentInstanceId, revocationGeneration}`。服务端从已认证上下文产生这些字段，忽略并拒绝浏览器提交的同名身份头。

所有可通过不透明 ID 查询、取消、提交或取得结果的状态对象都保存判别联合 `ResourceBinding`：

- `PortalResourceBinding = {subjectKind:"portal-session",principalId,parentSessionId,sourceDeviceId,targetDeviceId?,revocationGeneration,scope,leaseId?,leaseGeneration?,filterDigest?,expiresAt}`；禁止 service/agent 字段。
- `ServiceResourceBinding = {subjectKind:"service",serviceId,deploymentGeneration,audience,scope,filterDigest,expiresAt}`；禁止伪造 principal/session/device 字段。
- `AgentResourceBinding = {subjectKind:"agent",deviceId,agentInstanceId,revocationGeneration,audience,scope,filterDigest,expiresAt}`；禁止 principal/session/service 字段。

`Operation`、`Cursor`、search、`Transfer`/manifest/chunk/result、permanent-delete `Challenge`、desktop/evidence 均加载适用绑定，并把当前认证上下文与该 union 分支的全部字段逐一复核后才返回或产生副作用；只知道 ID 返回不泄漏存在性的 `NOT_FOUND`。身份模块撤销订阅游标使用 `ServiceResourceBinding`，代理 report/控制订阅可使用 `AgentResourceBinding`，用户领域对象使用 `PortalResourceBinding`。运维模块管理身份读取仍须独立权限、目的和审计，不绕过对象绑定。

`target-pull` 是唯一需要两类受信主体操作同一传输的特例，服务端因此保存互不替代的 `TransferBinding={owner:PortalResourceBinding,executor:AgentResourceBinding}`：所有者只能调用门户 Query/Resume/Abort/Result/Commit，并仅在 `browser-pull` 下调用 `ack-range`；执行器只能以受保护 agent-control 身份在 `target-pull` 下调用该传输的 `ack-range`。执行器必须精确绑定 manifest.target 的 `deviceId/agentInstanceId/revocationGeneration`、`audience=file-transfer-target`、作用域、filter 摘要和到期；非 `target-pull` 传输禁止执行器分支。路由先按 mode 选定唯一分支再全量比对，不得在 owner/executor 间 OR、fallback 或用一方凭据代替另一方。

`InternalIdentityContext` 只在入口端与固定本机消费者之间的 OS-peer-authenticated UDS/named 管道传输，固定为 `{iss,aud,gatewayBootId,principalId?,sessionId?,sourceDeviceId,revocationGeneration,method,path,bodyDigest,requestId,correlationId?,jti,connectionId,deadlineAt,iat,nbf,exp}`。`aud`、规范 method/path/body 摘要与实际调用必须精确相等，`exp-iat` 最长 5 s；`deadlineAt` 是业务截止时间且不得晚于接入预算，不能用认证 `exp` 代替。消费者校验启动代次、本机连接、时间窗和签名后，在不少于 `exp` 的有界缓存中原子消费 `jti`。缺字段、重放、错误 audience/连接、网关重启旧代次或缓存不可用均在领域 handler 前失败关闭；客户端提供的同名头必须先删除。

`LeaseAssertion` 为控制面签名的稳定对象：

```json
{
  "leaseId":"lea_*","principalId":"...","sessionId":"ses_*",
  "sourceDeviceId":"dev_*","targetDeviceId":"dev_*",
  "operation":"desktop.control|file.read|file.mutate|file.transfer",
  "operationDigest":"sha256:<hex>","generation":1,
  "issuedAt":"...","expiresAt":"...","signerKeyId":"...","signatureAlg":"Ed25519","signature":"..."
}
```

组合根先向控制面获取租约，再把断言和规范化 `GrantRequest` 交给身份模块。身份模块只验证稳定断言的签名、字段、到期及父会话，不调用控制面；控制面只调用身份模块认证，不反向请求身份模块签发租约。因此不存在运行时或构建依赖环。身份模块将断言的绑定复制进派生凭据，领域服务消费时必须同时复核父代次、作用域、来源、目标、操作摘要和绝对到期。

`GrantRequest` 固定为 `{kind, scopes[], sourceDeviceId, targetDeviceId, objectIds[], operationDigest, leaseAssertion, intentId?, requestDigest?, ttlMs}`；安全文件变更时 `intentId/requestDigest` 必填且必须等于中心已提交意图。`kind` 为 `api-capability|desktop-launch|desktop-channel|file-transfer|permanent-delete`。未知作用域拒绝。不透明秘密只在响应体出现一次，只保存摘要，不进入 URL、日志、持久浏览器存储或 SSE。

### 3.1 普通用户代理的对端绑定证明

普通用户 `platform-agent`/文件端点不得直接获得 tailscaled LocalAPI 套接字或命名管道权限。设备安装一个独立最小权限 `screen-control-peer-helper`；辅助进程只绑定配置中本机 Tailscale 地址的专用文件端口并自行 `accept` 连接，从真实套接字读取连接 tuple 后只调用 `WhoIsForIP`。其本地 IPC 只有 `AcceptAuthenticatedStream -> {stream,PeerBindingProof}`：Linux 以受限 Unix 套接字 + `SCM_RIGHTS` 移交原连接 FD，Windows 保持原套接字并以每连接专用、ACL 限定的 named 管道代理。它不能代理任意 LocalAPI 方法、任意 URL、调用方声称的 IP、登记查询或领域授权。

成功返回短期签名 `PeerBindingProof`：

```json
{
  "proofId":"...","connectionId":"con_*","helperBootId":"...","audience":"file-endpoint",
  "localDeviceId":"dev_*","remoteDeviceId":"dev_*","localAddress":"...","remoteAddress":"...",
  "transport":"tcp","socketBindingDigest":"sha256:...","observedAt":"...","expiresAt":"...",
  "helperKeyId":"...","signatureAlg":"Ed25519","signature":"..."
}
```

证明最长 5 s、仅使用一次并绑定 connection/audience/socket；代理校验辅助进程启动代次公钥、设备、能力凭据来源和被移交的当前连接，并在读取请求、验证能力凭据且生成规范请求 ID 后把三者原子绑定。辅助进程不可用、IPC 调用进程不匹配、连接/代次错绑或证明过期时文件入口失败关闭。LocalAPI 原始结果、IP 和证明不返回浏览器。edge-gateway 可在其独立特权边界内直接调用 LocalAPI，不把该权限传给普通用户代理。

权限矩阵：

| 接口组 | 必须身份 | 额外绑定 |
|---|---|---|
| 身份模块登录 | 登记套接字对端 + 密码 | 源站、CSRF login context |
| 门户读 | 有效门户会话 + 登记套接字对端 | 仅限当前主机 Cookie、允许源站 |
| 状态/路径事实写 | 独立代理身份 | 身份设备必须等于 payload `deviceId`；无浏览器事实写入口 |
| 租约/领域命令 | 门户会话 | 来源、目标、操作摘要、幂等键 |
| 桌面对象 | 桌面能力凭据或同一父会话 | `principalId/sessionId/source/target/lease generation/scope/expiry` 全量复核 |
| file 对象/transfer | 对应能力凭据 + 数据面连接的 `PeerBindingProof` | 父代次、来源/目标/对象/manifest/expiry/真实对端全量复核 |
| 审计证据读 | 受限运维模块身份 | 目的、保留策略与读取审计 |

## 4. 幂等、游标与异步操作

所有安全写操作的账本密钥为 `(subjectKind,subjectBindingDigest,route,Idempotency-Key)`，并保存规范请求 SHA-256、首次结果或 `operationId`、创建时间和保留期限。`subjectBindingDigest` 是对已认证且已全量复核的当前 `PortalResourceBinding`/`ServiceResourceBinding`/`AgentResourceBinding` 分支做 RFC 8785 + SHA-256；不存在的字段不得借用另一分支补齐。因此目标执行器以自己的代理绑定幂等确认，不借用所有者 `principalId`。认证/撤销/binding 校验必须先于账本查询；相同账本密钥 + 相同摘要返回原结果，不重复执行；相同密钥 + 不同摘要返回 `IDEMPOTENCY_MISMATCH`。不得把网络断开解释为失败；客户端先查询 operation/资源状态。账本至少保留到对象绝对到期后 24 h；永久删除记录与审计同保留期。

幂等重试不等于认证重放：已绑定主体在新鲜且有效的认证上下文中，使用新请求 ID、同一 `Idempotency-Key` 和相同请求摘要重试时，必须返回账本中的原结果且不重复副作用；重用旧 `InternalIdentityContext`/request ID/`jti`/`PeerBindingProof`/明确标记为单次的能力凭据或已过期、已撤销、旧代次身份则在账本前拒绝。

`Cursor` 是服务端签名的不透明 `cur_*`，内部绑定数据流、主体、filter、最后提交序号和到期。客户端不得构造或跨主体复用。服务端必须先提交状态/审计和事务发件箱，再发布游标。过期返回 `CURSOR_EXPIRED`；订阅缓冲溢出发送 `resync-required`，客户端重新获取快照，不猜测缺失事件。

任何可能超过同步预算的动作均返回 HTTP `202` 和 `Operation`，而不是占用门户的统一超时：

```json
{
  "operationId":"op_*","kind":"desktop.start|desktop.end|desktop.lock-exit|file.search|file.mutate|file.commit|file.device-copy",
  "state":"accepted|running|waiting-input|succeeded|partially-succeeded|failed|unknown|cancelled",
  "progress":{"completedUnits":0,"totalUnits":null,"messageCode":"ACCEPTED"},
  "resultRef":null,"error":null,"createdAt":"...","updatedAt":"...","expiresAt":"...",
  "cancellable":true
}
```

`progress.totalUnits`、`resultRef` 和 `error` 明确允许 `null`；非空 `error` 使用 `ErrorRef`。`failed` 表示已知未产生未申报副作用；`unknown` 表示必须协调/查询，不允许自动重做；`partially-succeeded` 必须带领域结果。取消是幂等请求，只保证不开始新的副作用；已发生的副作用仍必须在结果中报告。通用接口为：

| Method/path | 结果 | 权限 |
|---|---|---|
| `GET /api/v1/operations/{operationId}` | 当前 `Operation` | 当前上下文全量匹配 `ResourceBinding`，或受限运维模块 + 读取审计 |
| `POST /api/v1/operations/{operationId}:cancel` | `202 Operation` | 全量匹配 `ResourceBinding`；同一幂等规则 |
| `GET /api/v1/events?cursor=...` | SSE `operation-updated|domain-change|resync-required` | 游标全量绑定主体/来源/filter/撤销代次/到期 |

## 5. 截止时间树与重试

最外层到期由接入层写入受信内部上下文；子调用必须使用 `min(父剩余时间, 本行预算)`，预留至少 250 ms 返回响应，禁止下游自行延长。同步受理超时不是业务失败，客户端按幂等键或操作查询。

| 操作 | 接入预算 | 子预算/终态预算 | 重试 |
|---|---|---|---|
| 登录/改密/退出 | 6 s | LocalAPI 0.5 s；身份存储总计 1.5 s；Argon2 排队 2 s + 执行 ≤0.5 s；响应预留 ≥0.5 s | 登录不自动重试；退出同密钥可查 |
| 快照/operation/transfer 查询 | 3 s | 身份模块 0.5 s；数据库 2 s | 安全 GET 最多 1 次抖动重试 |
| 租约/派生凭据 | 3 s | 身份模块 0.5 s；control store 2 s | 只按同一幂等键重试 |
| 桌面 start/end/lock | 3 s 返回 `202` | 建连 15 s；关闭 5 s；锁屏确认 10 s | 不自动重发输入或锁屏；查操作 |
| List/Stat | 5 s | 代理 4 s | 安全 GET 最多 1 次 |
| Search/Mutate/Commit/DeviceCopy | 3 s 返回 `202` | 搜索单 slice 30 s；mutation 单项 30 s；传输整体按资源 TTL | 只查/恢复，禁止盲重做 |
| 二进制块/Range | 每请求 30 s | 哈希/落盘包含在内 | 未确认 range 可重传 |
| 状态/审计事务发件箱 | 后台单次 5 s | 指数退避 1 s–5 min，直到 TTL/人工处置 | 事件 ID 去重 |

## 6. 身份模块 v1

| Method/path | request.data 必填字段 | 成功 data | 特殊错误 |
|---|---|---|---|
| `POST /api/v1/auth/login` | `{password,csrfToken}`；peer/Origin 来自连接 | `{session:{sessionId,sourceDeviceId,expiresAt}}` + 仅限当前主机 Secure HttpOnly Cookie | `RATE_LIMITED`；其余认证原因统一 |
| `POST /api/v1/auth/logout` | `{}` + 幂等键 | `{revocationGeneration,revokedAt}` | — |
| `POST /api/v1/auth/password:change` | `{currentPassword,newPassword}` + 幂等键 | `{revocationGeneration,changedAt}` | `RATE_LIMITED` |
| `GET /api/v1/auth/session` | 无 | `PrincipalRef` | `UNAUTHENTICATED` |
| internal `POST /api/v1/identity/grants` | `GrantRequest` + 调用服务身份 | `{credentialId,secret,kind,scopes,expiresAt}` | `LEASE_EXPIRED`,`PERMISSION_DENIED` |
| internal `POST /api/v1/identity/revocations` | `{subjectType,subjectId,reason}` + 幂等键 | `{revocationGeneration,revokedAt}` | `NOT_FOUND` |
| internal `GET /api/v1/identity/revocations?cursor=` | 无 | SSE `{eventId,subjectType,subjectId,generation,reason,occurredAt,cursor}` | `CURSOR_EXPIRED` |

门户 Cookie 必须是门户主机名的仅限当前主机 Cookie，`Path=/; Secure; HttpOnly; SameSite=Strict`；不得设置 `Domain`，也不得发送到桌面源站。

## 7. 控制面 v1

代理写入和消费者读取严格分离。只有 `StatusIngestor` 可写路径事实；`ReadPathDecision` 总是读取控制面已提交的权威事实版本，消费者请求中没有 `facts` 或 `now` 字段。

`ComponentFact` 为 `{component:"host|desktop|files|clipboard.service|clipboard.text|clipboard.history-file",state:"ready|degraded|unavailable|unknown",reasonCode,observedAt,sequence}`。`unavailable` 只表示代理主动观测到失败；控制面根据最后观测年龄派生 `unknown`：host/desktop/files 为 15 s，clipboard.service/text/history-file 分别为 30/90/180 s。设备代理心跳 30 s 未到才把设备标为 offline；不得用设备 15/30 s 心跳阈值覆盖三项剪贴板新鲜度。`PathFact` 为 `{flow:"desktop|file",sourceDeviceId,targetDeviceId,candidate:"lan-direct|internet-direct|peer-relay|derp|offline",handshake:"passed|failed|unknown",rttMs,lossPpm,interfaceClass:"tailscale|physical-lan|internet|unknown",observedAt,sequence,evidenceRef}`。

| Method/path | request.data | 成功 data | 权限/语义 |
|---|---|---|---|
| 代理 `POST /api/v1/control/reports` | `{deviceId,agentInstanceId,sequence,observedAt,components[],pathFacts[]}` | `{acceptedSequence,snapshotVersion}` | 认证代理；设备匹配；旧 sequence 不覆盖 |
| `GET /api/v1/control/snapshot` | 无 | `{version,generatedAt,devices:[{deviceId,components[],pathDecisions[]}]}` | 门户会话 |
| `GET /api/v1/control/events?cursor=` | 无 | SSE `{eventId,snapshotVersion,change,cursor}` | 主体绑定游标 |
| `GET /api/v1/control/path-decisions/{flow}/{sourceDeviceId}/{targetDeviceId}` | 无 | `PathDecision` | Portal/领域服务只读 |
| `POST /api/v1/control/leases` | `{targetDeviceId,operation,operationDigest,ttlMs}` + 幂等键 | `LeaseAssertion` | 门户会话；固定操作枚举 |
| `POST /api/v1/control/leases/{leaseId}:renew` | `{generation}` + 幂等键 | `LeaseAssertion` | 同一主体/绑定；不越父到期 |
| `POST /api/v1/control/leases/{leaseId}:release` | `{reason}` + 幂等键 | `{releasedAt}` | 同一主体或撤销器 |

`PathDecision` 固定为 `{decisionId,flow,sourceDeviceId,targetDeviceId,path,reasonCode,factsVersion,decidedAt,validUntil,evidenceRefs[]}`。`path` 为 `lan-direct|internet-direct|peer-relay|derp|offline`；事实陈旧、身份冲突或未知时只能返回 `offline`，并带 `STALE_FACTS`/`UNKNOWN_PATH` reason，不能接受调用方补充事实。

## 8. 远程桌面 v1

`DesktopBinding` 为 `{desktopSessionId,principalId,parentSessionId,sourceDeviceId,targetDeviceId,leaseId,leaseGeneration,scope:"desktop.control",revocationGeneration,expiresAt}`，服务端持久保存。以下每次 HTTP、iframe 引导、WS 升级、WS 首条认证、输入批次、结束/锁屏及证据读取都必须根据已认证上下文重新加载并全量匹配绑定；仅知道 `dsk_*` 一律不足。

| Method/path | request.data | 成功 data |
|---|---|---|
| `POST /api/v1/desktops` | `{targetDeviceId,leaseId,pathDecisionId}` + 幂等键 | `202 Operation(kind=desktop.start,resultRef=/api/v1/desktops/dsk_*)` |
| `GET /api/v1/desktops/{desktopSessionId}` | 无 | `{binding,state,pathDecisionId,createdAt,connectedAt,endedAt,endReason}`；绑定对门户脱敏 |
| `POST /api/v1/desktops/{desktopSessionId}:end` | `{reason}` + 幂等键 | `202 Operation(kind=desktop.end)` |
| `POST /api/v1/desktops/{desktopSessionId}:lock-exit` | `{nonce}` + 幂等键 | `202 Operation(kind=desktop.lock-exit)` |
| 运维模块 `GET /api/v1/desktops/{desktopSessionId}/evidence` | 无 | `{pathDecisionId,candidateSummary,displaySummary,inputSummary,redactions[]}` |

状态固定为 `requested|authorizing|connecting|active|ending|ended|failed`；锁屏结果固定为 `{status:"confirmed|failed|unknown",observedAt,platformEvidenceRef,recoveryAction}`。`failed/unknown` 不得误报已锁；会话结束策略由 `lock-exit` 操作明确记录，客户端不得自行推断。输入帧固定绑定 `{desktopSessionId,leaseGeneration,sequence,events[]}`，断线后序号代次作废且永不重放。

跨主体、跨来源、跨目标、旧租约 generation、旧作用域、过期能力凭据对上述每个入口都返回不泄漏的 `NOT_FOUND` 或 `REVOKED`，并纳入契约负测。

门户源站固定为 `https://portal.<tailnet-dns>`，Desktop/Mesh 主机源站固定为 `https://desktop.<tailnet-dns>`，禁止仅用同主机路径隔离。门户必须用精确 `targetOrigin=https://desktop.<tailnet-dns>` 的 `postMessage` 建立 `MessageChannel`，接收端同时校验 `event.origin`、`event.source` 和一次性 nonce，才可接收仅驻内存的 `desktop-launch`；禁止 `"*"` targetOrigin。

入口端可在桌面主机签发 `__Host-mesh-route`：`Secure; HttpOnly; SameSite=Strict; Path=/` 且无 `Domain`。它只选择已授权的内部 route/shard，本身不授予桌面权限；每个敏感入口仍校验内存 launch/channel credential 与完整 `DesktopBinding`。入口端转发 Mesh 前必须剥离该路由 Cookie、所有 Cookie、Authorization、CSRF 和外来身份头；Mesh 响应出现任意 `Set-Cookie` 时中止响应、记录 G0 安全失败并关闭会话，不得仅删除后继续。

## 9. 文件数据面 v1

`ObjectRef` 为 `{objectId,deviceId,volumeId,fsIdentity,displayPath,observedAt}`；`displayPath` 不参与授权。`Precondition` 为 `{objectId,fsIdentity,parentObjectId,parentFsIdentity,size,mtime,digest?}`。`Manifest` 为 `{direction:"upload|download|device-copy",sourceDeviceId,targetDeviceId,sourceObjectId?,destinationParentObjectId?,destinationName?,size,chunkSize,sha256,conflictPolicy:"fail|replace|auto-rename"}`，其规范 JSON SHA-256 是 `manifestDigest`。

读取/变更控制面：

| Method/path | request.data/query | 成功 data |
|---|---|---|
| `GET /api/v1/files/{deviceId}/entries?parent=&cursor=&limit=` | 已认证 query；limit ≤1000 | `Page<ObjectRef>` |
| `POST /api/v1/files/searches` | `{deviceId,rootObjectId,query,limit}` | `200 Page`（3 s 内）或 `202 Operation(kind=file.search)` |
| `GET /api/v1/files/{deviceId}/objects/{objectId}` | 无 | `{object:ObjectRef,type,size,mtime,permissions,storageType}` |
| `POST /api/v1/files/mutations` | `{leaseId,items:[MutationItem...]}` + 幂等键 | `202 Operation(kind=file.mutate)` |
| `POST /api/v1/files/permanent-delete:prepare` | `{deviceId,objectId,trashEvidenceId}` + 幂等键 | `{challengeId,text,expiresAt}`；服务端保存 binding/object/precondition/intended text 摘要 |
| `POST /api/v1/files/permanent-delete:commit` | `{challengeId,confirmationText}` + 新幂等键 | 全量复核 Challenge `ResourceBinding`、对象前置条件、文本和未使用状态后 `202 Operation(kind=file.mutate)`；原子单次消费 challenge |

`MutationItem` 为 `{itemId,action:"mkdir|rename|copy|move|trash|replace|permanent-delete",source:ObjectRef?,destinationParent:ObjectRef?,destinationName?,precondition}`。跨设备 `move` 在受理前返回 `CROSS_DEVICE_MOVE_FORBIDDEN`；同设备跨卷移动可产生部分结果。

`ItemResult` 固定为：

```json
{
  "itemId":"...","status":"succeeded|partial|failed|unknown","error":null,
  "effects":[{"kind":"destination-created|destination-replaced|source-removed|source-trashed|metadata-updated","state":"confirmed|not-applied|unknown","object":null,"observedAt":"..."}],
  "sourceState":"unchanged|removed|trashed|unknown|not-applicable",
  "destinationState":"absent|created|replaced|unknown|not-applicable",
  "recoveryAction":"none|retry-same-key|resume-operation|remove-destination|manual-reconcile",
  "auditReceiptId":null
}
```

`error` 明确允许 `null`，非空时使用 `ErrorRef`；`effects[].object` 允许 `null`，非空时使用 `ObjectRef`。`partial` 表示至少一个副作用已确认、另一个期望副作用已知未发生，例如跨卷移动已提交目标但源删除失败；`unknown` 表示副作用无法确定。相同幂等键重试必须返回账本结果或执行协调，不得再次复制/删除。批量操作终态由逐项结果聚合：全部成功为 `succeeded`，混合/partial 为 `partially-succeeded`，任何 unknown 且无法立即协调为 `unknown`。

### 9.1 传输生命周期

`Transfer` 固定为：

```json
{
  "transferId":"trn_*","operationId":"op_*","manifestDigest":"sha256:...","transferMode":"browser-push|browser-pull|target-pull",
  "state":"prepared|receiving|paused|verifying|committing|completed|failed|aborted|unknown",
  "chunkSize":8388608,"confirmedRanges":[{"start":0,"endExclusive":8388608,"sha256":"..."}],
  "receivedBytes":0,"totalBytes":0,"expiresAt":"...","resultRef":null,
  "dataPlane":{"role":"source","origin":"https://files-<device-id>.<tailnet-dns>","path":"/data/v1/transfers/<transfer-id>/content","methods":["GET"],"acceptRanges":true}
}
```

`<device-id>/<tailnet-dns>/<transfer-id>` 是响应生成时替换的模板记法，传输协议中必须是设备登记表解析出的精确 HTTPS 源站和实际 ID，不得出现通配符或接受客户端 origin。`path` 只含传输 ID，不含秘密。每个传输恰有一个 `dataPlane`/capability，并由 `Manifest.direction` 判别生成：upload=`browser-push + destination/PUT`，期望对端为 manifest.source；download=`browser-pull + source/GET`，期望对端为 manifest.target；device-copy 固定为 `target-pull + source/GET`，由目标代理通过受保护 agent-control 通道取得能力凭据、主动直连固定源代理并把响应流写入本机暂存区，期望对端为 manifest.target。Portal/echova 不读取或转发 device-copy 正文；其他 mode/role/method 组合失败关闭，能力凭据不能跨绑定使用。控制面生命周期：

| Method/path | request.data | 成功 data |
|---|---|---|
| `POST /api/v1/transfers` | `{manifest}` + 幂等键 | `201 {transfer,capability:{role,expectedPeerDeviceId,secret,expiresAt,allowedRanges}}`；与唯一 `dataPlane` 对应 |
| `GET /api/v1/transfers/{transferId}`（Query） | 无 | `Transfer`，含权威确认 ranges |
| `POST /api/v1/transfers/{transferId}:resume`（Resume） | `{manifestDigest,fromRanges[]}` + 幂等键 | `{transfer,capability}`；重验主体/对象/前置条件/块摘要并换新同一 role |
| `POST /api/v1/transfers/{transferId}:ack-range` | `{start,endExclusive,sha256,manifestDigest}` + 幂等键 | `Transfer`；`browser-pull` 由所有者在浏览器流式落盘并校验后确认，`target-pull` 只由绑定目标执行器在本机暂存区与日志 fsync 后确认 |
| `POST /api/v1/transfers/{transferId}:abort`（Abort） | `{reason}` + 幂等键 | `202 Operation`；停止新块并受控清理 |
| `GET /api/v1/transfers/{transferId}/result`（Result） | 无 | `{state,resultObject?,sha256?,itemResult?,error?}`；未终态为 `409 CONFLICT` |
| `POST /api/v1/transfers/{transferId}:commit` | `{destination,precondition,manifestDigest}` + 幂等键 | `202 Operation(kind=file.commit)` |

数据面：上传 `PUT /data/v1/transfers/{id}/content` 必须带 `Authorization: Capability <opaque>`、`Content-Range`、块 `Digest`；下载 `GET` 必须带同一 Authorization、单一 `Range`（可从 0 开始）和 `If-Match: \"<manifestDigest>\"`。成功响应带 `Accept-Ranges: bytes`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`ETag: \"<manifestDigest>\"` 和该 range 的 `Digest`。上传块只有在目标端点落盘、摘要和日志 fsync 后由端点直接确认；`browser-pull` range 只有在浏览器落盘、摘要并以所有者绑定成功调用 `ack-range` 后确认；`target-pull` range 只有在目标代理将数据写入本机排他暂存区、验证摘要并 fsync 块/journal 后，以执行器绑定调用 `ack-range` 才确认。源代理仅服务 `GET`，永远不得确认目标落盘；错 target/instance/代次、错 mode 或未 fsync 均失败关闭。旧认证上下文/proof/明确标记为单次的能力凭据重放在账本前拒绝；正确执行器使用新认证上下文以同密钥 + 同摘要重试，返回原确认结果且不重复产生副作用。Query 返回对应 mode 的权威已确认 ranges，执行者只重传未确认 range。

### 9.2 浏览器 >3 GB 直连策略与硬门

门户不代理正文。它先从文件数据面控制 API 取得 `Transfer` 和当前浏览器方向唯一匹配的短期能力凭据，再启动专用网页 Worker；能力凭据只经内存 `MessageChannel` 传递，worker 只对匹配 role/origin/method 使用带 `Authorization: Capability` 的跨源站 `fetch` 直连目标代理，并把 `ReadableStream` 增量写入浏览器 File System Access API 的用户选定文件。每个 range 完成后 worker 校验 `Digest`、查询权威已确认 ranges 并持久化不含秘密的 `{transferId,manifestDigest,confirmedRanges,fileHandle}` 恢复元数据；恢复必须重新取得对应 role 的能力凭据。禁止 `blob()`、整文件内存/OPFS 缓冲、URL 能力凭据、Cookie、重定向和 service-worker 秘密缓存。

目标代理 CORS 只允许精确门户源站、`GET/PUT/OPTIONS` 和 `Authorization,Content-Range,Range,If-Match,Digest,X-Correlation-ID`；它删除外部 `X-Request-ID`，完成 `PeerBindingProof`/capability 校验后自行生成规范请求 ID；`Vary: Origin`，禁 credentials，preflight 失败关闭。每个数据面连接都必须通过 `screen-control-peer-helper` 取得 §3.1 的一次性 `PeerBindingProof`，并确认证明的真实 `remoteDeviceId` 等于能力凭据 `expectedPeerDeviceId`；普通用户代理无 LocalAPI 权限，辅助进程不可用时失败关闭。

`FF-00` 必须在 `FF-03a`/`FF-03b` 正式实现前，于三台锁定版本的目标浏览器上完成独立尖峰：稀疏/生成式 >3 GiB 文件全程流式写盘、暂停/刷新/网络切换后 range 恢复、最终 SHA-256 一致、峰值浏览器额外内存 ≤256 MiB、正文不经过 `echova`，且 URL/Referer/日志/storage 无能力凭据。任一目标浏览器缺少 File System Access/流式能力或未过门，不得静默回退为门户中转，必须回到数据面选型并修订本契约后再实现。

### 9.3 审计意图 + 日志 + 事务发件箱

安全变更采用以下唯一提交协议：

1. 组合根在中心 SQLite 同一事务写入 `{intentId,requestDigest,idempotencyKey,principal,target,plannedEffects,state=prepared}` 和发送事务发件箱；失败则返回 `AUDIT_UNAVAILABLE`，端点未收到执行能力凭据，零副作用。
2. 身份模块签发只绑定该 `intentId/requestDigest` 的短期执行能力凭据。代理收到后先写本机普通用户可写但其他用户不可写的持久化日志 `prepared` 并 fsync 文件及父目录，然后才允许文件系统副作用。
3. 操作用随机排他 staging/tombstone 和对象身份模块划分可协调提交点。每个提交点后写 `destination-committed`、`source-removed` 等副作用及对象证据并 fsync；跨卷移动必须先提交目标再尝试源删除，因此可精确成为 `partial`。
4. 代理把日志终态或阶段性副作用写持久化事务发件箱并持续重传。中心按 `eventId` 去重，在同一事务更新意图、写允许字段审计、保存 `ItemResult/TransferResult` 和响应事务发件箱，随后返回 `AuditReceipt`。
5. 收到回执后代理标记 acknowledged；清理仅在保留窗后进行。门户只有读到中心回执才显示终态成功；中心不可达时显示 `running/unknown` 并查询，不把“远端可能已改变”报告为失败或重做。

崩溃恢复必须按下表自动协调，禁止只靠超时猜测：

| 崩溃切点 | 恢复行为 | 对外状态 |
|---|---|---|
| 中心意图事务前/失败 | 无能力凭据、无端点副作用 | `failed/AUDIT_UNAVAILABLE` |
| 意图已提交，代理日志前 | 同密钥重发原 capability/命令 | `accepted` |
| 代理 `prepared` 后、首副作用前 | 按 precondition 确认未执行后继续或安全取消 | `running/cancelled` |
| 副作用后、日志阶段 fsync 前 | 用暂存区标记、源/目标 fsIdentity 和摘要协调，补写准确副作用；无法判定则 `unknown` | `running/unknown` |
| 日志副作用已 fsync、中心回执前 | 事务发件箱重传；绝不再次执行 | `running` |
| 中心回执后、代理确认前 | 中心返回同一回执，代理幂等 ack/清理 | 已保存终态 |

`AuditReceipt` 为 `{auditReceiptId,intentId,eventId,itemId?,resultDigest,committedAt}`。审计允许字段为 `time,requestId,intentId,principalDevice,targetDevice,permissionDomain,action,relativeDisplayPath,result,objectType,bytes,transferId,effects`；不得记录正文、密码、Cookie、Authorization、能力凭据、查询串或完整绝对路径。

## 10. 兼容与验收门

服务端只提供 v1；客户端发送 `Accept-Version: 1`。相邻一个已发布代理 minor 版本可在同一 v1 下共存；新增字段只能 optional 且必须有安全默认，删除/重命名字段或改变枚举语义必须升主版本。部署顺序为 tolerant reader → producer → 收紧校验器；回滚反向进行。更高主版本、未知安全枚举或缺少绑定一律失败关闭。

契约测试至少覆盖：错误 envelope/HTTP 映射、每个权限矩阵的跨主体负测、三种 `ResourceBinding` 分支互斥、service 游标跨 audience/跨 service/旧 deployment generation/重放拒绝、三类主体各自的账本密钥隔离、同密钥同摘要幂等重试/异摘要拒绝/旧认证上下文重放拒绝、游标过期与溢出、操作取消/unknown、PathPolicy 拒绝消费者事实、DesktopBinding 每入口 IDOR、严格 `targetOrigin`/route Cookie/上游 `Set-Cookie` 失败关闭、`PeerBindingProof` 伪造/重放/helper 不可用、`ItemResult.partial/effects`、传输 direction/mode/role/method/expected-peer 映射与 Query/Resume/Abort/Result、`target-pull` 只允许正确目标执行器在暂存区摘要与日志 fsync 后确认（源 agent/错 target/旧 instance/旧代次拒绝；新认证同密钥 + 同摘要安全返回原结果）、>3 GB 浏览器直连门，以及审计六个崩溃切点。


## G0 文件桥接的当前设备规则（2026-09-10）

本节仅说明现有 G0 桥接，不改变上文生产文件数据面协议。按用户要求，`POST /api/v1/files/sessions`（Mesh 协议 5）的 `targetDeviceId` 可以是经服务端识别的当前电脑；仍须通过来源身份、登记目标、在线状态和会话归属校验。`POST /api/v1/desktops`（协议 2）仍拒绝当前设备并返回 `409 SELF_TARGET_NOT_ALLOWED`。手机没有文件代理，文件会话仍返回 `403 TARGET_NOT_SUPPORTED`，通过浏览器上传/下载访问手机文件。

多选复制由门户沿用现有单文件协议顺序执行，逐文件等待目标 `uploaddone` 确认，单文件上限 512 MB；覆盖逐项确认，取消、失败、超时或断线停止后续文件，报告已确认数量及未确认结果，不重放。此行为不等同于生产端点直传、断点续传或目录递归复制。

### G0 文件执行身份修复

文件会话 API、所有权与协议 5 消息保持兼容，执行端改为经固定 SSH 目标启动的普通用户文件进程。标准流采用 4 字节大端长度加正文帧，单帧不超过 1 MiB；首次返回 `workerReady/version=1/uid`。进程与门户均拒绝 root/SYSTEM 身份，缺少普通用户配置时返回 `FILE_IDENTITY_UNAVAILABLE` 或 `TUNNEL_SETUP_FAILED`，禁止回退旧 Mesh 文件通道。只接受既有文件操作，未知命令返回 `action:error`；不会传入或执行浏览器提供的命令。

上传沿用 `upload/uploadstart/uploadack/uploaddone/uploaderror` 与 `reqid`，先在目标目录创建临时文件，校验长度及原目标未变化、同步并替换后才发送 `uploaddone`。权限不足不截断已有文件；中断不重试。覆盖不提供权限提升或自动接管历史 root 文件的能力。

文件列表支持名称、修改时间、大小排序及升降序，目录保持优先。Ctrl/⌘ 多选后右键“压缩选中项（当前设备）”，调用设备自带系统 tar 生成 `.tar.gz`，仅保存在当前设备当前目录，不触发跨设备复制。支持普通文件和文件夹，拒绝符号链接、特殊文件、同名输出及目录越界；输入总大小上限 512 MB、执行最长 2 分钟。失败不发布目标包，成功以 `compressed/reqid/name` 确认；断线后结果未确认须检查目录，不自动重试。请求为 `compress/reqid/path/name/names`，后端独立校验且不接受工具路径、命令或跨设备目标。

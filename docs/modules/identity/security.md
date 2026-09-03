# Identity — 安全

**最后更新：** 2026-09-03

## 权限

| 操作 | 前置条件 | 复核点 |
|---|---|---|
| 打开登录页/登录 | 已登记 Tailscale 稳定节点 | 网关真实 socket peer |
| 读取会话 | 节点与会话绑定均有效 | 每次 HTTP/WS 建立 |
| 改密 | 当前密码会话 + CSRF + 再认证 | 提交事务前 |
| 初始 bootstrap | `echova` 本地控制台 + 受限运维 OS 身份 + 一次性激活文件 | 建立首个密码和登记信任锚前 |
| 设备登记/替换 | 两端本地生成请求，`echova` 本地控制台显式核对稳定节点 ID/设备公钥指纹；不提供网页 API | 写入登记表前及事务提交时 |
| 签发派生凭据 | 有效父链 + 对应领域授权/租约 | 签发及消费两端 |

## 根信任与设备生命周期

系统初装时处于 `UNINITIALIZED`：没有默认密码、默认设备、远程 setup URL 或可用业务会话，网关除本机健康检查外一律返回不可用。安装器生成仅属 `screen-control-admin` 运维 OS 身份、模式 `0600`（Windows 为等价专用 ACL）的一次性激活文件；`screen-control-admin bootstrap` 只能从 `echova` 的本地控制台运行，先由 OS 重新认证操作者，再以关闭回显的 TTY 或显式秘密文件描述符读取两次密码。密码、恢复材料或登记批准值不得出现在 argv、环境变量、shell 历史、剪贴板、URL 或日志。成功事务同时写入密码散列、登记签名锚、恢复代次和审计事件，并通过操作者指定的离线文件描述符输出一次加密恢复包及其校验指纹，然后原子销毁激活文件；恢复包不在主机在线卷留副本。审计提交或恢复包安全输出失败时整个 bootstrap 回滚，重复 bootstrap 失败关闭。

每个端点由本机受限登记工具在 OS 凭据存储内生成不可导出的设备密钥，并输出含稳定 Tailscale 节点 ID、公钥、平台和单次 nonce 的签名请求。操作者在 `echova` 本地控制台核对请求摘要、目标机器上显示的公钥指纹及 LocalAPI 返回的稳定节点 ID，逐设备明确批准；批准产物绑定设备 ID、公钥、用途、登记代次和绝对有效期。不得仅凭设备名、IP 地址、Tailnet 成员资格、旧备份或知道网页密码完成登记。

设备替换是单个持久事务：先把旧设备登记代次递增并标记撤销，再登记新稳定节点 ID/公钥；outbox 必须关闭旧设备的会话、派生能力、租约、传输和远控通道。事务或 outbox 入队任一步失败时，新设备不得生效；旧设备不能以旧登记请求或凭据重新加入。恢复只允许同一受限运维身份从本地控制台导入加密恢复材料；恢复完成必须增加全局恢复代次、轮换登记签名锚并使恢复前会话、能力及待批准请求全部失效。bootstrap、批准、拒绝、替换和恢复均写入不可静默关闭的安全审计，内容只含操作者 OS 标识、设备 ID/公钥指纹、代次、结果和时间，不含秘密。

## 网关与内部身份上下文

- Portal 与 Mesh 必须是两个独立 HTTPS Origin（不同 host），只按精确 SNI/Host 分流，禁止用同一 Origin 的路径代理。Portal 会话 Cookie 使用 `__Host-` 前缀、`Path=/`、无 `Domain`，因此不会发送到 Mesh Origin。
- Mesh Origin 的首个文档只能是网关拥有的无秘密启动壳；Portal 后端取得的一次性、极短期 desktop-launch 由父页面以限定目标 Origin 的 `postMessage` 交给该壳，再用受保护请求头完成后端交换。启动值不进入 URL、Referer、Cookie、持久存储或 Mesh 上游。壳只接受精确 Portal Origin/来源窗口且消费后清零；未交换前不得建立 Mesh iframe/WS/WebRTC 会话。交换成功后由网关而非 Mesh 设置 `__Host-mesh-route`（`Secure; HttpOnly; SameSite=Strict; Path=/`）不透明路由 Cookie；它只引用网关内存中的来源/目标/租约/撤销代次/绝对期限，不能成为 Portal 会话，并且在转发 Mesh 上游前总被删除。网关重启、租约结束或撤销立即失效该路由会话，重连必须重新交换。
- 浏览器进入任一 Origin 时，网关都以真实 socket peer 调用 LocalAPI 并核对登记。发往 Mesh 上游前无条件删除包括网关自有 route Cookie 在内的全部 `Cookie`、`Authorization`、CSRF、外来 `X-Forwarded-*`/`Forwarded`、`X-Screen-Control-*` 及重复/歧义身份头；只在受限本机上游连接重新生成内部上下文。Mesh 响应出现任何 `Set-Cookie` 即拒绝响应、关闭升级/通道并告警，不尝试改写后放行；只有网关自己的启动交换 endpoint 可以生成/清除 `__Host-mesh-route`。
- 网关每次启动生成不持久化的签名子密钥和 `gatewayBootId`，经带 OS peer 身份的本机控制通道把公钥交给固定消费者；重启后旧启动代次上下文立即无效。网关签发的内部身份上下文至少包含 `iss`、精确 `aud`、`gatewayBootId`、主体/稳定节点 ID、会话 ID 与撤销代次、HTTP method、规范化 path/route、body digest、服务端生成的 `requestId`、可选不受信 `correlationId`、一次性 `jti`、独立业务 `deadlineAt`、`iat/nbf/exp`（认证上下文最长 5 s）及本机连接 ID；`deadlineAt` 不得用 `exp` 代替或向后延长。它只经带 OS peer 凭据校验的 Unix domain socket/Windows named pipe 传输；消费者校验签名、issuer/audience/启动代次、方法/路径/正文、连接、时间、deadline 和撤销代次，并在不少于 `exp` 的有界缓存中原子消费 `jti`。重复、缺字段、时钟越界、缓存不可用或连接不符均失败关闭。
- WS/流式连接只允许在握手时把一次性上下文换成绑定该物理连接、来源/目标、租约及绝对期限的内存 channel context；不得把握手上下文复用于重连。输入帧另带会话内严格单调序号，重复/乱序即丢弃并审计，网络重试不得重发输入。

## 威胁与缓解

| 威胁 | 缓解 |
|---|---|
| 伪造 IP/转发头 | 仅信 socket peer + LocalAPI；清除外来身份头 |
| Mesh 同源窃取/上游设 Cookie | 独立 Origin、host-only Portal Cookie、网关剥离所有浏览器凭据和外来身份头、拒绝任何 Mesh `Set-Cookie` |
| 密码暴力破解/Argon2 DoS | 双维度令牌桶、并发/内存预算、统一错误与请求体限制 |
| 会话数据库泄漏 | 仅存不透明令牌摘要；Cookie `HttpOnly; Secure; SameSite=Strict` |
| CSRF/恶意 Origin | 写操作双提交或请求头 CSRF；精确 Origin；拒绝 `null` |
| 派生权限扩大 | 作用域集合只能收窄；目标/来源/动作/期限均参与签名和存储校验 |
| 撤销丢失 | 持久代次 + outbox + 短租约；重启从数据库恢复 |
| URL/日志泄密 | 所有敏感字段统一脱敏；查询串不能承载凭据；原始请求体不记录 |
| 本机上游伪造/重放身份 | OS peer 约束通道 + 5 s 签名上下文 + method/path/body/连接绑定 + 原子一次性 `jti` |
| 默认口令或旧设备接管 | 无默认密码的一次性本地 bootstrap；设备公钥双端核验；替换事务递增代次并递归撤销 |

## 安全测试

- A01 伪造节点、旧登记、Host/Origin/头部和非 Tailnet 入口矩阵。
- A02 密码错误、限速、CSRF、7 天到期、退出/改密/设备撤销与服务重启矩阵。
- A01 固定准备四类主体：三台已登记节点、一个临时未登记 Tailnet 节点、一个已替换/撤销旧节点凭据和一个公网探针；分别在网络 Grants、网关 peer 校验和应用登记层断言拒绝，测试后撤销临时节点。
- bootstrap 测试覆盖无默认密码、非本地 TTY/错误 OS 身份、argv/env 秘密扫描、激活文件重用、并发首次初始化、替换事务故障注入、旧凭据/旧登记请求拒绝及恢复后全局失效。
- Mesh 隔离测试断言两个 Origin 不同、Portal Cookie 不发往 Mesh、恶意 Mesh 无法调用 Portal API、外来/重复身份头被删除、Mesh `Set-Cookie` 导致失败关闭，以及 iframe/WS 各自复核 Origin/租约/撤销。
- 内部上下文测试覆盖错误 audience/method/path/body/requestId/连接、过期/未来时间、重复 `jti`、重启后旧上下文及 WS 重连重放；任何一次都不得到达领域 handler。
- 属性测试保证 `child.scope ⊆ parent.scope`、`child.expiry ≤ parent.expiry`，任何父代次变化均使子对象失效。

集中资产、信任区、滥用场景和残余风险见[项目威胁模型](../../appendix/threat-model.md)。

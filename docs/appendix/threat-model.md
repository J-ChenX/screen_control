# 私人网页远控 — 集中威胁模型

**最后更新：** 2026-09-03  
**适用阶段：** 第三阶段设计门；第四阶段每个安全相关工作包必须提交对应验证证据

## 1. 范围、资产与信任区

本模型覆盖浏览器、`edge-gateway`、Portal、MeshCentral/MeshAgent、identity/control-plane、三机 platform agent 与 peer helper、文件数据面、SyncClipboard gateway/connector、在线数据库、备份和验收证据。Tailscale 只提供网络成员与加密传输事实，Tailnet 成员资格本身不是应用授权。

| 信任区 | 允许入口 | 核心假设与边界 |
|---|---|---|
| 用户浏览器 | 两个精确 HTTPS Origin | 浏览器可能有扩展/XSS；Portal 与 Mesh 不同 Origin，凭据不落持久存储 |
| echova edge | 真实 Tailscale socket、宿主 LocalAPI | 唯一浏览器入口；按 SNI/Host 分流；不信转发头 |
| echova 本机服务 | UDS/named pipe + OS peer 身份 | Portal/Mesh/SQLite/SyncClipboard 本体不直接暴露用户网络 |
| 端点普通用户 | 文件、状态、剪贴板 connector | 不得拥有 root/SYSTEM、LocalAPI 或屏幕能力 |
| 端点系统服务 | MeshAgent、peer helper | 按职责拆分；helper 只有连接身份查询，MeshAgent 只有桌面能力 |
| 数据与证据 | 加密卷、独立加密备份、隔离证据目录 | owner、用途、保留期、销毁日均可追踪；内容默认不进入证据 |

最高价值资产包括：密码散列与会话/派生链、设备登记锚及每设备私钥、屏幕帧和键盘输入、用户文件及路径、剪贴板正文/历史、Mesh/SyncClipboard 关联凭据、审计和恢复材料。攻击者模型包括公网客户端、未登记 Tailnet 节点、已撤销/被替换设备、恶意网页/iframe、失陷 Mesh 上游、普通本机用户、被盗备份，以及能触发重试/重连/崩溃的网络攻击者。取得端点或 echova 系统管理员权限的攻击者属于残余风险，不假设软件隔离仍完整。

## 2. 数据分类与默认处置

| 等级 | 数据示例 | 静态/传输保护 | 日志、证据与保留 |
|---|---|---|---|
| `R0 公开` | 静态产品版本说明、无环境信息的帮助文本 | 完整性校验 | 可进入普通构建日志 |
| `R1 内部` | 脱敏健康码、组件版本、合成测试结果 | TLS；服务目录最小权限 | 结构化证据默认 30 天 |
| `R2 敏感元数据` | 在线身份库、密码散列、设备 ID/公钥、会话/能力摘要、相对文件路径、操作/审计记录、网络路径事实 | TLS；主机加密卷 + `0700/0600` 或等价 ACL；备份另钥加密 | 只记录最小字段；导出路径用带项目密钥 HMAC；安全审计默认 180 天 |
| `R3 内容/秘密` | Cookie/Authorization/CSRF、私钥、恢复材料、启动值、屏幕帧、键值/输入文本、文件与剪贴板正文、真实测试录屏 | 凭据用必要内存/OS 不可导出存储；用户文件不由本项目复制持久化；SyncClipboard 正文仅可在其加密用户数据库/历史/队列及独立加密备份按功能目的持久化；端到端受验 TLS；禁 core/swap | 凭据、帧和输入在传输/会话结束清除且禁止记录；SyncClipboard 内容遵循用户配置的历史/队列保留和显式清理，备份同周期；例外录屏仅合成内容、独立加密且 7 天销毁 |

SQLite 的 WAL/SHM/临时文件、SyncClipboard DB/历史/队列、容器层、诊断 bundle、浏览器 trace、packet capture、core dump 和备份按其中最高等级处理，不能因载体不同而降级。R3 业务持久化例外只限 SyncClipboard 自身功能存储/备份，不授权写入项目日志或普通证据。所有导出证据都必须有 owner、purpose、classification、createdAt、destroyAt 和内容摘要；到期精确销毁并产生不含敏感内容的回执。

## 3. 主要威胁、控制与验证

| ID | 威胁/滥用场景 | 必须控制 | 第四阶段最早证据 |
|---|---|---|---|
| TM-01 | 公网或未登记 Tailnet 节点进入系统 | Grants + 真实 socket `WhoIsForIP` + 稳定节点登记三层校验；无 IP/头部降级 | 已登记、临时未登记、已撤销旧节点、公网四主体拒绝矩阵 |
| TM-02 | Mesh 与 Portal 同源导致 Cookie/API 窃取 | 不同 host 的独立 Origin；Portal `__Host-` Cookie；精确 CSP/framing | 恶意 Mesh 夹具不能收到 Cookie、调用 Portal API 或被任意页面 frame |
| TM-03 | Mesh 上游注入身份/持久 Cookie | 网关删除 Cookie/Authorization/CSRF/Forwarded/项目身份头；仅网关可设不可透传的 route Cookie；任何上游 `Set-Cookie` 失败关闭 | HTTP、错误页和 WS 路径的头部端到端断言 |
| TM-04 | 内部身份上下文伪造或重放 | OS peer 通道；签名 audience/method/path/body/requestId/连接；5 s 时限；原子 `jti` | 字段篡改、重复、过期、重启、跨连接/WS 重连均在 handler 前拒绝 |
| TM-05 | 默认密码、伪登记或旧设备恢复 | 无默认密码的一次性本地 bootstrap；OS 再认证；设备公钥指纹核对；替换/恢复递增代次 | 并发 bootstrap、非本地调用、旧请求/凭据、事务故障注入 |
| TM-06 | 普通文件代理借 LocalAPI 扩权 | 只接受真实连接的最小 peer helper；普通代理无 LocalAPI ACL；证明绑定连接且一次性 | 普通用户 ACL、任意 IP 查询、跨连接重放、helper/LocalAPI 故障测试 |
| TM-07 | 文件 IDOR/SSRF/路径竞态 | 能力绑定主体/两端/动作/对象/清单/租约；固定登记端点；句柄级 no-follow；禁重定向 | 跨主体 ID、任意 URL、symlink/reparse、替换竞态负测 |
| TM-08 | 撤销后通道或输入继续 | 持久撤销代次/outbox；短租约；通道主动关闭；输入严格序号且不重试 | 退出/改密/替换/断网/重启期间实测无后续画面、写入或输入重放 |
| TM-09 | SyncClipboard 被其他节点或旧公网凭据使用 | loopback 服务 + Tailscale mTLS gateway/connector；逐设备证书与 peer/登记双绑定；成功后撤销公网凭据 | 未登记/公网/错误/旧/错配证书、明文和多余监听拒绝矩阵 |
| TM-10 | 数据从日志、数据库、录屏、崩溃转储或证据泄露 | R0–R3 分类；加密卷/独立备份；敏感字段禁记；录屏例外和定时销毁 | 权限/卷断言、敏感模式扫描、core/swap 检查、到期销毁演练 |
| TM-11 | 系统级 MeshAgent 变成通用 RCE | 禁终端/文件/剪贴板/命令/共享链接/自动升级；构建 hash 和防火墙固定 | 配置/功能枚举负测、服务身份/进程树网络策略漂移测试 |
| TM-12 | 恶意主动文件或文件名攻击浏览器 | attachment、nosniff、限制 CSP、文本节点、无同源预览 | 恶意文件名/MIME/HTML/SVG 下载夹具 |

控制的详细所有者分别见 [identity 安全](../modules/identity/security.md)、[platform-agent 安全](../modules/platform-agent/security.md)、[Portal 安全](../modules/portal/security.md)、[operations 安全](../modules/operations/security.md)和 [Clipboard](../modules/clipboard.md)。证据必须能定位 release manifest、测试主体、配置摘要和时间，但不得附带 R3 数据。

## 4. 残余风险与接受门

| 风险 | 当前处理 | 可接受条件/触发动作 |
|---|---|---|
| MeshCentral 原版不能证明 Tailscale-only ICE 或无 URL 启动交换 | G0 候选，尚不可视为最终选型 | 三平台端点强制、切网/对抗证据及无 URL 单次交换全部通过；需长期 fork、TURN-only 或降级凭据规则则淘汰 Mesh |
| 端点系统管理员/root 可读取屏幕或篡改代理 | 项目内权限分离不能抵御宿主完全失陷 | 将该设备立即标记失陷、撤销登记并替换设备密钥；不声称在宿主管理员对手下保密 |
| 浏览器扩展、无障碍 API 或宿主截屏可观察画面/输入 | CSP/Origin 只能限制网页上下文 | 仅在受控个人浏览器使用；发现浏览器/设备失陷即结束会话并撤销设备；不提供“安全输入”保证 |
| Tailscale 控制平面/账户被接管 | 应用层仍要求登记、会话、逐设备证书 | 任何未知节点/密钥变化触发全局撤销和重新登记；若稳定节点事实不可验证则停止入口 |
| 文件/剪贴板/屏幕内容在目标应用自身存储中已有副本 | 本项目只能控制自身数据流 | 文档明确保留边界；验证只使用合成内容，不承诺清除第三方应用历史 |
| 加密卷在主机已解锁且服务运行时不能抵御宿主管理员 | 静态加密主要保护关机磁盘/备份 | 结合专用 UID/ACL、最小挂载和审计；宿主入侵按设备失陷处置 |
| 极短身份上下文依赖本机时钟和有界重放缓存 | 单调时钟/连接绑定降低窗口 | 时钟异常或缓存不可用失败关闭；不得扩大 TTL 解决可用性问题 |

残余风险只能由项目所有者在本地运维审查中按条接受，记录风险 ID、证据、接受期限和复审日；不得以“仅私人使用”整体豁免。Mesh 两项 G0 风险在证据完成前不可接受。新增跨信任区数据流、新持久化、公共监听、管理员能力或第三方上游时，必须先更新本模型并重新运行受影响负向门。

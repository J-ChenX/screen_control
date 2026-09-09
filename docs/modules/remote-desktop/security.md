# 远程桌面 — 安全

**最后更新：** 2026-09-03

## 仅桌面权限

唯一允许能力是主屏画面、键盘和鼠标。必须禁用并以负向测试证明不可达：Terminal、Files、PowerShell、命令、录制、共享链接、音频、剪贴板、管理界面、普通 Mesh 登录和代理自动升级。

## 威胁与缓解

| 威胁 | 缓解 |
|---|---|
| Mesh 同源窃取门户身份 | Portal/Desktop 使用独立主机源站；严格 `targetOrigin`/接收端 `origin+source+nonce`；门户 Cookie 为仅限当前主机；桌面路由清除 Cookie/Authorization/CSRF/外来身份头，Mesh `Set-Cookie` 使请求失败关闭 |
| 绕过门户访问 Mesh | Mesh 只监听受限内部网络；桌面源站只暴露最小适配器；iframe/WS 分别复核，原生 Mesh 界面不可路由 |
| URL 令牌泄漏 | G0 强制后端交换；URL、Referer、存储与所有日志扫描为零 |
| 裸 LAN/公网媒体 | 进程级端点防火墙 + 无公网 STUN + 运行时三联路径证据 |
| 撤销后继续控制 | 2 s 撤销事件 + 30 s 租约兜底 + 主动关闭 WS/WebRTC |
| 断线后卡键/重放 | 单调序号、断线清空输入队列、恢复创建新代次 |
| 锁屏误报 | 只有平台代理确认才为成功；超时永远是 Unknown |
| 高权限扩散 | MeshAgent 与普通用户文件代理进程、秘密、端口和 IPC 分离 |
| 远控 IDOR | 每个对象访问和 WS/输入入口全量复核 `DesktopBinding`，会话 ID 从不作为授权 |

契约负测逐入口覆盖跨主体、跨来源、跨目标、旧租约代次、错误作用域、已撤销及过期能力凭据，以及 `targetOrigin="*"`、伪造 postMessage、路由 Cookie 直达和 Mesh `Set-Cookie`；预期行为见[协议契约 §8](../../appendix/protocol-contracts.md)。G0-1 至 G0-4 任一失败即架构阻断，不能用界面隐藏、服务器 TURN 或长期分叉规避。

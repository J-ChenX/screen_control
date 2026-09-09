# 远程桌面 — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码/配置 |
|---|---|---|
| `DesktopCoordinator` | 领域状态机、租约、结束与撤销 | `internal/desktop/coordinator/` |
| `LaunchExchange` | 无 URL 的单次启动交换 | `internal/desktop/launch/` |
| `MeshAdapter` | 最小 Mesh API/WS 映射，不暴露通用用户会话 | `internal/desktop/mesh/` |
| `PathVerifier` | 对照 `PathDecision` 校验 getStats/端点/Tailscale 映射 | `internal/desktop/pathverify/`、`web/src/features/desktop/evidence/` |
| `InputGate` | 单调输入序列、路径漂移停发、不重放 | `internal/desktop/inputgate/` |
| `DisplayPolicy` | 发送端上限、宽高比、坐标变换、无音频 | `internal/desktop/display/` |

## 状态机

`requested → authorizing → connecting → active → ending → ended`；任一阶段可进入 `failed`。`lock-requested → lock-confirmed|lock-failed|lock-unknown → ending` 是独立子状态。只有服务端确认的 `active` 能接收输入；输入带桌面绑定、租约代次和单调序号。启动、结束和锁屏均在 3 s 内返回 `Operation`，建连/关闭/锁屏确认在后台截止时间内完成；调用方用操作查询/SSE，不持有 10–15 s 同步请求。

唯一传输协议契约、状态枚举和截止时间树见[协议契约 §4–§5、§8](../../appendix/protocol-contracts.md)。

## 对象归属与 IDOR 复核

服务端为每个会话持久保存 `DesktopBinding`。`desktopSessionId` 不具备权限；HTTP、iframe 引导、WS 升级、WS 首条认证、每批输入、结束、锁屏和证据读取都必须从认证上下文重新加载并匹配 `principalId/parentSessionId/sourceDeviceId/targetDeviceId/leaseId/leaseGeneration/scope/revocationGeneration/expiresAt`。证据接口还需独立运维模块权限。任一不匹配返回不泄漏对象存在性的拒绝并关闭已建通道。

## G0 证据协议

- 端点规则：Ubuntu 记录 systemd/cgroup 与 nftables/eBPF 生效证据；Windows 记录按程序、精确 Tailscale 地址/适配器的防火墙证据。规则缺失时代理不得启动。
- 路径证据三联：浏览器 `RTCPeerConnection.getStats()` 选中候选项配对、两端抓包摘要、Tailscale 节点/连接映射；原始抓包进入受限测试产物，不入仓库。
- 对抗：注入物理 LAN、公网 ICE/STUN、未知候选项；必须连接失败而非改标签继续。
- 源站隔离：门户 `https://portal.<tailnet-dns>` 与桌面 `https://desktop.<tailnet-dns>` 使用不同主机源站；桌面只交付最小启动壳和适配器，不暴露原生 Mesh 界面。门户以严格 `targetOrigin` 的 `postMessage + MessageChannel` 交付一次性 nonce/capability，接收端复核 `origin/source/nonce` 后仅置于框架内存。
- 网关清洗：入口端可在桌面主机使用不授权、仅选路的 `__Host-mesh-route` Cookie；进入 Mesh 上游前必须连同门户 Cookie、Authorization、CSRF 和全部外来身份头剥离。Mesh 返回任何 `Set-Cookie` 时中止响应、关闭会话并记 G0 失败，而非清洗后继续。两个源站分别设置 CSP/framing，Mesh 失陷不得同源调用门户 API。
- 启动交换：浏览器网络记录、Referer、网关/Mesh/容器日志与 storage 均无令牌；一次使用、60 s 超时、绑定来源/目标/desktop-only/租约。

## 预算

| 项目 | 数值 | 失败行为 |
|---|---|---|
| 启动交换 | 60 s 单次使用 | 使用/超时销毁 |
| 命令受理 | 3 s | 返回 `202 Operation`；超时按幂等键查询 |
| 后台建连 | 15 s | 操作失败、结束会话并释放租约 |
| 租约 | 30 s，10 s 续租 | 停发输入，5 s 内关闭通道 |
| 路径漂移检测 | 每 2 s 或浏览器事件触发 | 立即停发，最多 15 s 重协商 |
| 输入在途 | 每会话最多 64 条、单调序号 | 溢出丢弃并终止，不排队重放 |
| 单目标 | 1 会话 | `LEASE_CONFLICT` |
| 媒体 | 最多 1080p、无 audio track | 发现越界立即结束并记门失败 |

## 依赖与失败

身份模块、租约、PathPolicy 任一无效即关闭；Mesh 控制面不可用不影响目标锁态。普通结束从不调用锁屏。`lock-exit` 的 Failed/Unknown 也关闭控制通道但明确保持“锁态未知”，禁止误报。候选通过 G0 后才创建生产 Mesh 配置；尖峰目录和凭据由运维模块明确退出。

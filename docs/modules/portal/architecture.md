# 门户 — 架构

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

**最后更新：** 2026-09-04

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `AppShell` | 路由、导航、错误边界、会话过期 | `web/src/app/`（导航、路由和错误边界已实现；会话接入计划中） |
| `DomainClient` | 版本化 HTTP API、CSRF、问题详情 | `web/src/api/client.ts` 已实现 G0 快照、桌面和文件会话；生产错误与身份契约待实现 |
| `ChangeStream` | 游标订阅、退避、全量重同步 | `web/src/realtime/` |
| `DeviceOverview` | 分项状态与统一路径标签 | `web/src/app/App.tsx` 每 5 秒读取 G0 权威快照；正式事件流计划中 |
| `DesktopView` | 远控生命周期与锁屏三态 | `web/src/features/desktop/MeshDesktop.tsx` 已接入三机 G0 一次性会话与 WS 中继；生产租约/独立源站仍待实现 |
| `FileExplorer` | 文件导航、批量、传输与确认 | `web/src/features/files/MeshFiles.tsx` 已接入三机 G0 协议 5 文件会话；生产文件数据面领域接入仍在计划中 |

## 数据流与状态

当前 G0 由回环地址 Go 桥接读取 MeshCentral 管理 WebSocket，并通过 `/api/v1/control/snapshot` 向门户返回三台登记设备状态。桌面启动先创建内存中的一次性 `dsk_*` 协议 2 会话；文件管理创建独立 `fil_*` 协议 5 会话；二者均由同源中继转发 WebSocket。上游账号、密码、cookie 与 `rauth` 不进入浏览器响应、URL 或网页 Storage。桌面和文件使用分离账号，写请求只接受明确列出的 loopback/Tailnet 门户源站。

开发装配的唯一规范入口为 `${SCREEN_CONTROL_DEV_ORIGIN}`，三台登记设备全部使用该地址。Vite 只在 `echova` 的 Tailscale 地址提供业务页面；`127.0.0.1:5173` 是兼容监听，导航请求以 `308` 跳转到规范入口。Go 桥接仍只监听回环地址并由 Vite 代理。其他两台登记电脑均已从自身系统发起 HTTP/API 请求并得到成功响应；Windows 的本地代理例外包含 Tailscale 私有网络域名。该入口依赖 Tailscale 私有网络隧道加密，但在 Tailscale Serve 尚未启用前没有浏览器 HTTPS，不能作为生产入口验收。

生产目标仍是：初次导航由 Go 组合根校验身份并交付带 CSP nonce 的静态壳；浏览器读取快照后以绑定主体的不透明游标订阅增量。收到 `resync-required`、游标过期、版本跳跃或 10 s 内无法恢复的流错误时丢弃本地派生状态并重新取快照。界面状态只保存展示所需 ID，不把 Cookie、能力凭据、desktop-launch 或文件 Authorization 写入 local/session storage。

跨进程字段、错误信封结构、权限、幂等、游标、操作与截止时间树只引用[协议契约 §2–§5](../../appendix/protocol-contracts.md)。Desktop/文件长操作均在 3 s 内返回 `Operation`，门户通过 SSE/查询显示 `accepted/running/partially-succeeded/unknown` 并提供受契约约束的取消；超时后不得自动重发写操作。文件批量结果按结构化副作用展示，不把 `partial` 合并成“成功”或“失败”。

## 预算与体验

| 项目 | 数值 | 行为 |
|---|---|---|
| 首屏静态资源 | gzip 后目标 ≤ 500 KiB | 超限作为构建警告并列包分析 |
| 快照/operation/transfer 查询 | 3 s；安全 GET 最多重试 1 次 | 失败保留旧状态并标陈旧；遵循父截止时间 |
| 普通 List/Stat | 5 s；安全 GET 最多重试 1 次 | 超时显示可重试，不清空当前列表 |
| 长命令受理 | 3 s 返回 `202 Operation` | 超时按幂等键/operation 查询，禁止盲重发 |
| 二进制 Range | 每请求 30 s，由网页 Worker 直连代理 | 只重传 Query 未确认 range |
| 事件重连 | 0.5/1/2/4/8 s + 抖动，上限 10 s | 随后全量重同步 |
| 状态陈旧展示 | 15 s 警告，30 s 离线 | 显示观测时间，不伪造实时 |
| 远控恢复提示 | 15 s 旅程上限 | 超时结束会话，不补发输入 |
| 文件续传提示 | 60 s 旅程上限 | 展示最后确认块和重新授权状态 |

## 浏览器安全

- 门户 `https://portal.<tailnet-dns>` 与桌面 `https://desktop.<tailnet-dns>` 使用不同主机源站。门户 CSP 默认 `default-src 'self'`，只对白名单桌面 frame/connect origin 精确放行；门户自身 `frame-ancestors 'none'`。桌面只允许被门户精确 origin 嵌入，并以独立 CSP 禁止连接门户 API。
- 门户会话 Cookie 为仅限当前主机，绝不设置 `Domain`。门户用严格 `targetOrigin` 的 `postMessage + MessageChannel` 向桌面框架交付一次性 nonce/capability，接收端复核 `event.origin/event.source/nonce` 后仅驻内存，禁止 `"*"`。
- 入口端可在桌面主机使用不授权、仅选路的 `__Host-mesh-route` Cookie，但进入 Mesh 前须剥离全部 Cookie、Authorization、CSRF 和外来身份头；Mesh 出现任何 `Set-Cookie` 时中止响应和会话并记录门失败。
- `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、HSTS；生产禁 source map 公网暴露。
- 所有 HTML/Markdown/文件名按文本渲染；下载不做同源预览。
- React/Node 锁定基线；不用 RSC 与 `react-server-dom-*`。

## 计划文件结构与测试

UI/UX 位于 `web/src/app/` 与 `web/src/styles.css`，G0 API、桌面和文件接入位于 `web/src/api/`、`web/src/features/desktop/`、`web/src/features/files/` 和 `internal/g0bridge/`。现有测试覆盖固定设备范围、文档路由、状态筛选、协议 2/5 选择、权威快照、登记设备校验、来源限制、文件名校验和凭据不出现在 API 响应。后续组件测试仍须覆盖权限不足、操作取消/结果未知、会话过期和键盘可访问性；生产安全测试覆盖独立桌面源站、Cookie/header/`Set-Cookie` 清洗；浏览器旅程覆盖三台桌面浏览器尺寸和文件直连硬门。

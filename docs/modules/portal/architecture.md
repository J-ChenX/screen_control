# Portal — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `AppShell` | 路由、导航、错误边界、会话过期 | `web/src/app/` |
| `DomainClient` | 版本化 HTTP API、CSRF、问题详情 | `web/src/api/` |
| `ChangeStream` | cursor 订阅、退避、全量重同步 | `web/src/realtime/` |
| `DeviceOverview` | 分项状态与统一路径标签 | `web/src/features/devices/` |
| `DesktopView` | 远控生命周期与锁屏三态 | `web/src/features/desktop/` |
| `FileExplorer` | 文件导航、批量、传输与确认 | `web/src/features/files/` |

## 数据流与状态

初次导航由 Go 组合根校验身份并交付带 CSP nonce 的静态壳；浏览器读取快照后以绑定主体的 opaque cursor 订阅增量。收到 `resync-required`、cursor 过期、版本跳跃或 10 s 内无法恢复的流错误时丢弃本地派生状态并重新取快照。UI 状态只保存展示所需 ID，不把 Cookie、capability、desktop-launch 或文件 Authorization 写入 local/session storage。

跨进程字段、错误 envelope、权限、幂等、cursor、operation 与 deadline tree 只引用[协议契约 §2–§5](../../appendix/protocol-contracts.md)。Desktop/文件长操作均在 3 s 内返回 `Operation`，Portal 通过 SSE/查询显示 `accepted/running/partially-succeeded/unknown` 并提供受契约约束的取消；超时后不得自动重发写操作。文件批量结果按结构化 effects 展示，不把 `partial` 合并成“成功”或“失败”。

## 预算与体验

| 项目 | 数值 | 行为 |
|---|---|---|
| 首屏静态资源 | gzip 后目标 ≤ 500 KiB | 超限作为构建警告并列包分析 |
| 快照/operation/transfer 查询 | 3 s；安全 GET 最多重试 1 次 | 失败保留旧状态并标陈旧；遵循父 deadline |
| 普通 List/Stat | 5 s；安全 GET 最多重试 1 次 | 超时显示可重试，不清空当前列表 |
| 长命令受理 | 3 s 返回 `202 Operation` | 超时按幂等键/operation 查询，禁止盲重发 |
| 二进制 Range | 每请求 30 s，由 Web Worker 直连代理 | 只重传 Query 未确认 range |
| 事件重连 | 0.5/1/2/4/8 s + 抖动，上限 10 s | 随后全量重同步 |
| 状态陈旧展示 | 15 s 警告，30 s 离线 | 显示观测时间，不伪造实时 |
| 远控恢复提示 | 15 s 旅程上限 | 超时结束会话，不补发输入 |
| 文件续传提示 | 60 s 旅程上限 | 展示最后确认块和重新授权状态 |

## 浏览器安全

- Portal `https://portal.<tailnet-dns>` 与 Desktop `https://desktop.<tailnet-dns>` 使用不同 host Origin。Portal CSP 默认 `default-src 'self'`，只对白名单 Desktop frame/connect origin 精确放行；Portal 自身 `frame-ancestors 'none'`。Desktop 只允许被 Portal 精确 origin 嵌入，并以独立 CSP 禁止连接 Portal API。
- Portal 会话 Cookie 为 host-only，绝不设置 `Domain`。Portal 用严格 `targetOrigin` 的 `postMessage + MessageChannel` 向 Desktop frame 交付一次性 nonce/capability，接收端复核 `event.origin/event.source/nonce` 后仅驻内存，禁止 `"*"`。
- edge 可在 Desktop host 使用不授权、仅选路的 `__Host-mesh-route` Cookie，但进入 Mesh 前须剥离全部 Cookie、Authorization、CSRF 和外来身份头；Mesh 出现任何 `Set-Cookie` 时中止响应和会话并记录门失败。
- `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、HSTS；生产禁 source map 公网暴露。
- 所有 HTML/Markdown/文件名按文本渲染；下载不做同源预览。
- React/Node 锁定基线；不用 RSC 与 `react-server-dom-*`。

## 计划文件结构与测试

`web/src/{app,api,realtime,features,components}/`、`web/tests/` 与 `internal/portal/http/`。组件测试覆盖权限不足、结构化部分成功、operation 取消/结果未知、会话过期和键盘可访问性；安全测试覆盖独立 Desktop Origin、Cookie/header/`Set-Cookie` 清洗；浏览器旅程覆盖三台桌面浏览器尺寸和文件直连硬门。均为 `[计划中 — 代码尚未存在]`。

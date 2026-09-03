# Portal — 安全

**最后更新：** 2026-09-03

## 边界

- Portal 只编排视图，不决定节点登记、领域授权、路径许可、锁屏结果或文件操作结果。
- Portal 会话 Cookie 仅由浏览器自动携带到 Portal Origin；capability 与 desktop-launch 只保存在内存并经受保护头/后端交换使用。Mesh Origin 只能使用网关自有、host-only、不可透传上游的短时 route Cookie，不接收 Portal 会话 Cookie。
- localStorage/sessionStorage 不保存 Cookie 镜像、CSRF、能力、文件对象授权、启动凭据或敏感诊断。
- Portal 与 Mesh 使用不同 HTTPS Origin；Portal Cookie 为 host-only `__Host-` Cookie，浏览器不得向 Mesh Origin 发送。独立 Origin 是安全边界，不得退化为同 Origin 路径代理。

## 浏览器策略

| 风险 | 控制 |
|---|---|
| XSS/文件名注入 | 所有外来文本按文本节点渲染；禁不受信 HTML；依赖锁定与 CSP |
| CSRF/恶意 Origin | 写操作携带 identity 提供的 CSRF；服务端精确 Origin 复核 |
| clickjacking | Portal `frame-ancestors 'none'`；Mesh Origin 响应只允许精确 Portal Origin framing，禁止通配符/`null`/自身以外父页面 |
| token 泄漏 | `Referrer-Policy: no-referrer`；URL/日志/持久存储禁凭据；生产禁公开 source map |
| Mesh 上游失陷 | 网关剥离 Portal Cookie/Authorization/CSRF/所有外来身份头；任何 Mesh `Set-Cookie` 响应失败关闭；Portal CSP 的 `frame-src`/`connect-src` 仅列精确 Mesh Origin |
| UI 授权旁路 | 服务端领域 API 每次重验；隐藏按钮不视为安全控制 |
| 主动文件内容 | 首版只下载 attachment + nosniff，无同源预览 |

## 跨 Origin 启动

Portal 只向 identity 后端请求一次性、绑定来源/目标/租约的 desktop-launch，并保存在父页面内存。Mesh Origin 的初始页面由网关提供静态启动壳，不是 Mesh 管理 UI；父页面通过带精确 `targetOrigin` 的 `postMessage` 发送启动值。启动壳必须同时验证 `event.origin` 等于精确 Portal Origin、`event.source` 等于预期父窗口、消息 schema/nonce 正确，然后用受保护请求头向 Mesh Origin 网关交换并立即清空内存。交换只能得到网关设置的 `__Host-mesh-route` HttpOnly 路由 Cookie；Cookie 引用网关内存状态、绝不传给 Mesh，且不能调用 Portal API。任何超时、重复消息、窗口导航、Origin 变化、网关重启或后退/刷新都要求重新签发，不得把 desktop-launch 放进 URL、Cookie、DOM 属性或 Web Storage。Mesh 管理/登录 UI 永不暴露。

## 危险操作呈现

覆盖、移动、删除、永久删除和锁屏必须渲染服务端标准确认模型与操作摘要；确认值只对单次操作有效。`failed`、`unknown`、部分成功和陈旧前置条件分别呈现，不能折叠为成功。

## 测试

浏览器测试覆盖恶意文件名、跨 Origin、CSRF 缺失、会话撤销、能力不落盘、后退/刷新、iframe/WS 绕过、部分成功和结果未知；安全头由端到端响应断言而非只测配置对象。专门的恶意 Mesh 夹具必须尝试读取 Portal Cookie、同源调用 Portal API、注入 `Set-Cookie`、伪造身份头、从非 Portal 父页面 frame、重放 `postMessage` 和重连 WS，所有尝试均失败关闭。

屏幕内容和输入事件的数据处理等级、保留规则及浏览器端残余风险见[项目威胁模型](../../appendix/threat-model.md)。

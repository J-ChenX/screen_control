# Portal — 统一网页

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

提供唯一桌面网页入口，编排三台设备、控屏、文件和剪贴板视图，但不复制身份、选路或领域规则。

## 信息架构

| 路由 | 内容 | 领域来源 |
|---|---|---|
| `/login` | 密码登录、限速反馈 | `identity` |
| `/` | 三设备卡片及 host/desktop/files/clipboard 分项状态 | `control-plane` |
| `/devices/:id/desktop` | desktop-only 启动、路径与锁屏三态 | `remote-desktop` |
| `/devices/:id/files/*` | 系统根/卷根、搜索、批量、传输 | `file-fabric` |
| `/settings/security` | 改密、退出当前会话 | `identity` |

## 交互规则

- UI 只展示服务端领域状态；不从原始字段自行推断在线、路径或权限。
- 禁止远程终端、命令输入、跨设备移动、回收站恢复/清空和 Mesh 管理入口。
- 危险操作使用领域返回的标准确认模型；覆盖需展示陈旧前置条件，永久删除必须第二次确认。
- desktop 视图离开、标签页关闭或网络断开只调用普通结束，保持目标原锁态。
- 所有错误显示“发生了什么、是否执行、如何恢复”；结果未知不得用成功提示。

## 对外接口摘要

| 接口 | 签名 | 消费者 |
|---|---|---|
| 静态应用 | `ServeApp(principal) -> ImmutableAssets` | browser |
| 领域路由 | `RenderRoute(route,domainState) -> View` | browser |

内部组件和状态模型见 [架构](architecture.md)，会话与浏览器边界见 [安全](security.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| PC-07（4h） | React 壳、登录、路由、API/事件客户端 | A01–A02 |
| PC-08（4h） | 设备卡片、分项状态、错误与路径标签 | 首页、N05、A13 |
| PC-09（4h） | desktop/files 页面编排与危险确认组件 | A05、A08–A12 |

所属交付流见 [门户与控制面任务](../../tasks/private-web-remote-portal-control/_INDEX.md)。

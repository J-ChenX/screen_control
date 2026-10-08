# 路线图与实现边界

本页是面向仓库读者的导航，不新建工作包、不改变优先级，也不承诺发布时间。详细范围以[需求索引](tasks/private-web-remote/_INDEX.md)、[决策记录](tasks/private-web-remote/DECISIONS.md)和各交付流的前置证据为准。

## 当前可用：G0 桥接

已有 Go/React 门户、MeshCentral 真实桌面中继、普通用户 SSH 文件通道、桌面与手机交互、流式文件及文件夹复制、SyncClipboard 侧车和默认关闭的 HTTPS 网关。Rust 协议核心以独立候选工件接入部分实机，尚不能将局部收益或运行状态外推为全项目生产验收。

操作与限制见[使用指南](USAGE.md)，历史测量与未验证范围见[内存评估](performance/MEMORY.md)。

## 仍需正式验证

登录前、锁屏、安全桌面、重启恢复、来源身份与网络拒绝等 G0 项，以及画面、输入、连接生命周期和性能旅程等 G3 项，必须分别满足工作包定义并留下真实设备证据。CI、隔离浏览器回归或某一次实机检查不能替代完整门；当前不宣布 G0/G3 已通过。

详见[远控交付流](tasks/private-web-remote-remote/_INDEX.md)与[验证策略](appendix/verification-strategy.md)。

## 生产规划

| 方向 | 计划与前置关系 | 权威入口 |
| --- | --- | --- |
| 身份与会话 | 正式登记、登录、派生凭据与持久撤销链 | [身份模块](modules/identity/README.md) |
| 控制面与代理 | 统一状态、租约、PathPolicy 与平台代理适配 | [控制面](modules/control-plane/README.md)、[平台代理](modules/platform-agent/README.md) |
| 远程桌面 | 独立源站、会话生命周期与对应实机验收 | [远控模块](modules/remote-desktop/README.md) |
| 文件数据面 | 生产权限、续传、完整性校验、回收站与端点传输 | [文件模块](modules/file-fabric/README.md) |
| 集成与运维 | 剪贴板健康、备份恢复、容量、长稳和可追溯发布 | [集成与运维交付流](tasks/private-web-remote-integration-ops/_INDEX.md) |

推进顺序按[架构依赖与阶段门](ARCHITECTURE.md#构建顺序与最早验证门)。发现文档与实现冲突时，先核对日期、变更和证据；不从此页直接推进下一个阶段。

# 平台代理 — 三机代理运行时

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

在三台设备上以分离身份运行代理公共能力，并提供 Linux/Windows 锁屏、文件与回收站适配。

## 进程与权限边界

| 进程 | 身份 | 能力 | 禁止 |
|---|---|---|---|
| MeshAgent | 系统服务所需身份 | 登录前桌面、安全桌面、键鼠 | 文件 API、终端、剪贴板、任意命令、自动升级 |
| `screen-control-agent` | 指定普通登录用户 | 状态、路径事实、普通用户文件、回收站、SyncClipboard 诊断 | root/SYSTEM、sudo/UAC、屏幕捕获和高权限句柄 |
| `screen-control-peer-helper` | 最小系统服务身份 | 仅接受专用 Tailscale 文件端口、向 LocalAPI 查询该已接受连接的对端、把连接与短时证明移交普通用户代理 | 通用 LocalAPI、任意地址查询、证书/路由读取、文件/桌面/命令能力 |

MeshAgent 与普通用户代理不得共享长期秘密、IPC 命令通道或可继承高权限句柄；只通过服务端的版本化领域契约协作。对端辅助进程只通过专用、带操作系统对端身份和固定模式定义的本机通道移交它实际接受的单条连接，不能充当第三个通用代理。

## 核心流程

| 场景 | 流程 |
|---|---|
| 启动 | 校验配置/权限/防火墙前置 → 对端辅助进程自检 LocalAPI 与专用监听 → 认证本机稳定节点 → 上报组件能力 |
| 心跳 | 采集 host/desktop/files/clipboard 与真实链路事实 → 单调序号上报 |
| 固定系统动作 | 验证租约/操作摘要 → 调用平台锁屏 API → 回报 Confirmed/Failed/Unknown |
| 文件对象 | 逐组件不跟随链接打开 → 核验普通用户权限/类型 → 返回受限句柄能力 |
| 回收站 | 核验文件系统与用户回收站 → `Trashed|Unsupported|Failed` |

## 对外接口摘要

| 接口 | 语义签名 | 消费者 |
|---|---|---|
| 固定锁屏 | `Lock(lease,operationDigest) -> Confirmed|Failed|Unknown` | 远程桌面 |
| 解析对象 | `ResolveObject(capability,path,mode) -> ObjectHandle` | 文件数据面 |
| 回收站 | `Trash(capability,handle) -> Trashed|Unsupported|Failed` | 文件数据面 |
| 提交临时对象 | `CommitTemp(capability,temp,destination,precondition) -> CommitResult` | 文件数据面 |
| 状态采集 | `CollectStatus() -> Components + PathFacts` | 控制面 |

详细适配、错误和预算见 [架构](architecture.md)，隔离要求见 [安全](security.md)。
跨模块资产和残余风险见[项目威胁模型](../../appendix/threat-model.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| PA-01（4h） | 跨平台进程骨架、配置、认证、心跳与服务安装 | A14、QG03 |
| PA-02（4h） | Linux/Windows 锁屏、句柄路径、回收站适配契约 | A05、A08、A12 |
| PA-03（4h） | 最小系统 `screen-control-peer-helper`、专用 IPC 与服务沙箱 | SG02、A08 |
| PA-04（3h） | 普通用户代理的一次性 `PeerBindingProof` 校验、失效与负测 | SG02、A08 |

所属交付流见 [远程控屏任务](../../tasks/private-web-remote-remote/_INDEX.md)；文件适配的真实集成由文件流继续完成。

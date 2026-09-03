# Platform Agent — 架构

**最后更新：** 2026-09-03

## 内部组件

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `AgentRuntime` | 配置、生命周期、认证、更新兼容与健康 | `cmd/screen-control-agent/`、`internal/agent/runtime/` |
| `StatusCollector` | 组件、接口、实际业务链路事实 | `internal/agent/status/` |
| `PlatformActions` | 固定锁屏、系统信息；无命令字符串入口 | `internal/agent/platform/` |
| `SafeFS` | 句柄级路径解析与对象分类 | `internal/agent/safefs/` |
| `TrashAdapter` | FreeDesktop/Windows 回收站适配 | `internal/agent/trash/` |
| `FileEndpoint` | Tailscale HTTPS、无 Cookie 能力消费 | `internal/agent/fileendpoint/` |
| `PeerHelper` | 以最小系统身份接受专用文件连接，仅为实际 socket 调用 `WhoIsForIP`，将连接和证明移交普通用户代理 | `cmd/screen-control-peer-helper/`、`internal/peerhelper/` |

## 平台适配

| 能力 | Ubuntu | Windows |
|---|---|---|
| 服务 | systemd user/system 单元按职责分离 | Windows Service；文件代理以 `operator` 账户或等价受限凭据 |
| 锁屏 | 固定 D-Bus/loginctl 桥接，目标为当前图形会话 | `LockWorkStation` 等固定 API；不启动 PowerShell/cmd |
| 路径 | `openat2` 优先，受约束 `openat` 回退需等价测试 | `CreateFile` 后核验 final path、volume、reparse tag |
| 回收站 | freedesktop Trash 语义并核验同文件系统/所有者 | Shell file operation/recycle API，确认目标普通用户上下文 |
| 秘密 | 0600 文件或系统凭据存储 | DPAPI/Credential Manager + ACL |
| LocalAPI 隔离 | helper 通过私有 Unix socket 访问 LocalAPI；以 `SCM_RIGHTS` 原子移交已认证连接与证明 | helper 访问命名管道；作为固定端口 TCP→受限 named-pipe stream broker，不把 LocalAPI 句柄交给普通用户 |

## 最小权限 peer helper

`screen-control-agent` 不得直接获得 tailscaled LocalAPI socket/命名管道权限。`screen-control-peer-helper` 只绑定配置中本机 Tailscale 地址的专用文件端口，并从它实际 `accept` 的 socket 读取 peer/local address；随后调用 `WhoIsForIP`，核对其稳定节点 ID 和目标地址/端口。登记、capability 与动作授权仍由普通代理持有的领域契约复核，helper 不读取登记库，也不决定业务授权。Linux 将原连接 FD、不可伪造的本机连接 ID 与签名证明在同一受控 IPC 消息中移交；Windows helper 保持原 socket 并通过每连接专用 named pipe 双向代理，证明绑定该 pipe 实例。普通用户代理不能提交 IP 让 helper 代查。

helper API 只有 `AcceptAuthenticatedStream -> {stream, PeerBindingProof}`，没有任意查询、证书、路由、登记、文件、进程或命令方法。证明由每次 helper 启动时仅驻留 helper 内存的临时私钥签名，包含来源/目标稳定设备 ID、原 socket 五元组、连接 ID、helper 启动代次、`aud=file-endpoint`、`iat/exp≤5s`；代理经已校验 OS peer 的首次握手取得该启动代次公钥，再校验 audience、连接绑定和代次并原子消费证明。helper 的可执行文件、服务配置、IPC ACL、监听地址或 LocalAPI 自检漂移时，helper 停止接受连接，agent readiness 变红且文件 API 失败关闭；绝不回退到转发头、来源 IP 字符串或设备级共享秘密。

## 契约与错误

```text
Lock(lease, operationDigest) -> LockResult{status, observedAt, evidence}
ResolveObject(capability, path, mode) -> ObjectHandle{opaqueId,type,volume,identity,permissions}
Trash(capability, handle) -> TrashResult
CommitTemp(capability, temp, destination, precondition) -> CommitResult
CollectStatus() -> AgentReport{sequence,observedAt,components,pathFacts}
AcceptAuthenticatedStream() -> AuthenticatedStream{stream,peerBindingProof}
```

稳定错误：`UNAUTHENTICATED`、`REVOKED`、`UNSUPPORTED`、`PERMISSION_DENIED`、`SPECIAL_OBJECT`、`STALE_OBJECT`、`CAPACITY_EXCEEDED`、`RESULT_UNKNOWN`。平台原始错误只进脱敏诊断，不成为跨模块契约。

## 预算与容量

| 项目 | 数值 | 行为 |
|---|---|---|
| 启动前置检查 | 10 s | 失败则不监听、不注册健康 |
| peer 身份查询/证明 | 500 ms；证明最长 5 s 且仅消费一次 | helper/LocalAPI/IPC 任一不可用即拒绝连接，不做身份降级 |
| 心跳 | 5 s；上报超时 2 s | 退避至 30 s，保持原序号语义 |
| 固定锁屏确认 | 5 s | 不能确认则 `Unknown`，远控端不得报成功 |
| 文件 API 请求头 | 5 s；请求总时限由动作决定 | 过期即拒绝，不延长 capability |
| 每设备传输 | 2 活跃、4 排队 | 超限显式拒绝/排队 |
| 分块 | 默认 8 MiB；最多 4 块在途/传输 | 内存预算固定，背压到读取端 |
| 临时空间 | 默认最多可用空间 10%，且保留 10 GiB | 无法预留即拒绝开始 |
| 临时对象 TTL | 24 h；每小时扫描 | 仅清理带本项目标记且无有效租约对象 |

## 计划文件结构

共享接口只在 `internal/agent/{runtime,status,platform,safefs,trash,fileendpoint}/`；helper 隔离在 `internal/peerhelper/`，普通代理不可导入其 LocalAPI 客户端。平台差异使用 build tags 放于同包 `*_linux.go` / `*_windows.go`，不复制策略。测试包括 Linux/Windows 单元、句柄级对抗夹具、IPC ACL/错误主体/伪造 IP 请求、helper 崩溃与重启、LocalAPI 不可用和两平台真实服务重启。均为 `[计划中 — 代码尚未存在]`。

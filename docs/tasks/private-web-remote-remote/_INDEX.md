# 子任务：远程控屏

**父任务：** [private-web-remote](../private-web-remote/_INDEX.md)  
**状态：** 第四阶段执行中；运维前置已通过，MeshCentral G0 隔离尖峰已完成本地静态校验，实机八包尚未执行
**范围：** `platform-agent` 的运行/锁屏边界、`remote-desktop` 与 MeshCentral 隔离候选

## 工作包规则

下表 ID 在全项目唯一；“主动工时”不含重启、下载、人工登录切换和观察等待。每包执行同名 `ops/verify/scenarios/<ID>.yaml`，命令与证据遵循[验证工程策略](../../appendix/verification-strategy.md)。所有 G0 包只在隔离尖峰目录/数据卷运行，不产生生产选型承诺。

执行按三个有界段恢复：`RD-A = RD-01a-L/RD-01a-W/RD-01b/RD-01c..RD-01g`（8 个 G0 包，候选淘汰检查点），`RD-B = PA-01..PA-04 + RD-02`（5 包，代理/生命周期检查点），`RD-C = RD-03a..RD-03f`（6 包，G3 检查点）。每段结束须更新 `_ACTIVE.md` 和签名证据索引。

## 唯一 G0 清单

### 当前执行记录

`deploy/spike/meshcentral/` 已固定 MeshCentral 1.2.5、Node 基础镜像摘要、npm lock/integrity、三个登记地址、独立 Portal/Desktop 源站、禁用 URL login token/账号注册/剪贴板/录制/Agent 更新，并新增只绑定 `echova` Tailscale 地址的 host-network Compose 与失败即拒绝静态校验。该校验只证明尖峰输入闭合，不证明任何 G0 门通过。由于 MeshCentral 1.2.5 自带建号 CLI 会把新密码放入原生进程参数，尖峰已增加无网络一次性 provisioner：从 stdin 读取明文，使用固定版本的 MeshCentral 哈希实现派生验证器，只把验证器交给建号路径，明文不进入原生 argv、环境、config、URL 或输出。实机执行仍须先获得对服务安装、网络规则和三机重启窗口的明确授权。

G0 **只含以下四个架构淘汰门**。输入连续 10 分钟、分辨率/坐标、六条完整来源→目标旅程及 A07 统计属于 G3，不得混入 G0 或用 G0 证据替代。

| G0 条目 | 绑定工作包 | 通过阈值 | 失败动作 | 最小证据 |
|---|---|---|---|---|
| G0-1 三个目标平台登录前/安全桌面可控 | `RD-01c`、`RD-01d`、`RD-01e` | `nix`、`echova` 重启后 GDM 画面和键鼠有效；Windows 登录、锁屏、UAC 安全桌面画面和键鼠有效；目标桌面无需先登录用户会话 | 任一目标失败即淘汰 Mesh 候选，停止 `PC-01` 及后续实现，进入架构修改；不自动换候选 | 每机 manifest/hash、重启时间线、服务状态、脱敏录屏/帧哈希、键鼠回执、清理回执 |
| G0-2 仅限 Tailscale WebRTC 失败即拒绝 | `RD-01a-L`、`RD-01a-W` | Linux 与 Windows 的 MeshAgent 进程树只能连接登记 Tailscale 地址；公网 STUN、物理 LAN/公网候选、规则缺失/漂移均不能建立或保持媒体；规则重启后仍在 | 任一平台不能持久、进程级失败关闭，需长期分叉或只能服务器中转即淘汰；看门狗自动回滚网络改动 | 浏览器已选候选项配对、双端抓包哈希、Tailscale 映射、规则前后哈希、注入负测、watchdog/救援证明 |
| G0-3 仅桌面权限负测 | `RD-01f` | 独立最小身份只可桌面；Terminal、Files、PowerShell、命令、录制、分享、剪贴板、设置和代理更新全部拒绝且无副作用 | 任一旁路可用或只能靠界面隐藏即淘汰候选 | 权限清单、HTTP/WS 负测、Agent/服务审计、`noAgentUpdate` 和三平台二进制哈希 |
| G0-4 独立源站 + 无 URL 单次启动交换/绕过负测 | `RD-01b`、`RD-01g` | 门户与 Mesh 使用独立精确源站；`postMessage` 双向校验精确 origin/source 且发送使用精确 `targetOrigin`；后端一次性启动交换绑定父会话、来源、目标、作用域、租约/代次/到期；edge-only `__Host-mesh-route` 不透传上游，Mesh 任意 `Set-Cookie` 响应失败关闭；秘密不进 URL/Referer/日志/存储；普通登录/UI/WS/Host/Origin 绕过全拒绝，撤销后真实通道终止 | 只能使用 URL 令牌、需要长期分叉、Origin/Cookie 无法隔离或存在任一旁路即淘汰候选 | 浏览器 trace/HAR 脱敏扫描、`postMessage` 错 origin/source 负测、Cookie 上下游捕获、Mesh `Set-Cookie` 注入、网关/Mesh 日志扫描、重放/错绑/过期/绕过矩阵、撤销时间线 |

G0 聚合命令为 `./ops/verify/run gate G0 ...`，只接受上表八个工作包同一 release/environment 的通过证据。网络规则包必须先通过 `IO-01d`，不得直接改系统级防火墙。

## 工作包

| 顺序 | ID | 模块 | 可交付内容 | 主动工时 | 墙钟约束 | 明确前置 | 主要验证场景 |
|---|---|---|---|---|---|---|---|
| 1 | RD-01a-L | 远程桌面 + 运维模块 | Ubuntu MeshAgent 进程树仅限 Tailscale 规则、漂移探测和对抗夹具 | 4h | 2 次服务重启 | `IO-01a`、`IO-01c`、`IO-01d` | `nix`/`echova` 公网 STUN、LAN/公网候选、缺规则均失败关闭 |
| 2 | RD-01a-W | 远程桌面 + 运维模块 | Windows 按程序、地址、适配器的仅限 Tailscale 规则和对抗夹具 | 4h | 2 次服务重启 | `IO-01a`、`IO-01c`、`IO-01d` | 规则漂移、程序替换、LAN/公网候选均失败关闭 |
| 3 | RD-01c | 远程桌面 | `nix` 重启后 GDM 控屏尖峰 | 3h | 1 次完整重启 | `IO-01a`、`IO-01c`、`RD-01a-L` | 无用户桌面会话时画面/键鼠有效 |
| 4 | RD-01d | 远程桌面 | `echova` 重启后 GDM 控屏尖峰 | 3h | 1 次完整重启 | `IO-01a`、`IO-01c`、`RD-01a-L` | 不影响 8080/现有项目；登录前画面/键鼠有效 |
| 5 | RD-01e | 远程桌面 | Windows 登录、锁屏和 UAC 安全桌面控屏尖峰 | 4h | 1 次重启 + UAC 切换 | `IO-01a`、`IO-01c`、`RD-01a-W` | 三种安全状态画面/键鼠有效 |
| 6 | RD-01f | 远程桌面 | 仅桌面独立身份与服务端能力负测 | 3h | 无 | `IO-01c`、`RD-01c`、`RD-01d`、`RD-01e` | 非桌面路由、协议和代理操作全部拒绝 |
| 7 | RD-01b | 远程桌面 + 身份模块 | 独立 Mesh 源站、精确 `postMessage`、edge-only `__Host-mesh-route` 与无 URL 一次性启动交换尖峰 | 4h | 无 | `IO-01c`、`RD-01f` | 凭据绑定/一次性/到期；Cookie 不透传；Mesh `Set-Cookie` 失败关闭；敏感扫描为零 |
| 8 | RD-01g | 远程桌面 + 身份模块 | Mesh UI/普通登录/HTTP/WS/Host/Origin/`postMessage`/Cookie 绕过负测 | 3h | 无 | `RD-01b` | 错 origin/source、通配 targetOrigin、Cookie 注入与所有普通入口拒绝，无通用 Mesh 会话 |
| 9 | PA-01 | 代理 | 跨平台普通用户运行时、认证、心跳与原生服务安装骨架 | 4h | 每平台 1 次服务重启 | `G0`、`IO-01b`、`IO-01c` | Linux/Windows install/start/upgrade/remove 与 A14 骨架 |
| 10 | PA-02 | 代理 | 锁屏、显示句柄、SafeFS 句柄和回收站的平台适配 port/夹具 | 4h | 无 | `PA-01` | 普通用户权限、关闭句柄、拒绝提权与平台错误映射 |
| 11 | PA-03 | 代理 + 运维模块 | 最小系统身份 `screen-control-peer-helper`、专用 IPC 与服务沙箱 | 4h | 每平台 1 次服务重启 | `PA-01`、`IO-01b` | 只返回本连接的对端绑定证明，不暴露 LocalAPI/任意查询/网络能力 |
| 12 | PA-04 | 代理 | 普通用户文件代理的辅助进程证明校验、缓存/失效和跨主体负测 | 3h | 无 | `PA-02`、`PA-03` | PID/UID/SID/连接/nonce/audience 错绑、重放、辅助进程停止全部失败关闭 |
| 13 | RD-02 | 远程桌面 | 桌面会话状态机、结束/撤销/异常和锁屏三态 | 4h | 无 | `PC-03`、`PC-05`、`PA-02` | 父会话/来源/目标/租约复核，重复/超时/结果未知 |
| 14 | RD-03a | 远程桌面 + 门户 | 门户嵌入、启动交换、真实 WS/WebRTC 生命周期集成 | 4h | 无 | `PC-09`、`RD-02` | 启动、结束、撤销、重连且无 URL/存储秘密 |
| 15 | RD-03b | 远程桌面 | A03–A06 三目标生命周期、画面、无音轨和坐标自动矩阵 | 4h | 每目标 1 次状态切换 | `RD-03a` | 登录前/异常结束/锁屏三态、编码上限、缩放映射 |
| 16 | RD-03c | 远程桌面 | `nix` 为来源到另两台的两条 A07 旅程 | 3h | 预热 + 2×10 分钟 | `PC-06`、`RD-03a`、`RD-03b` | 两条旅程各自 P95/丢包/连续性通过 |
| 17 | RD-03d | 远程桌面 | `echova` 为来源到另两台的两条 A07 旅程 | 3h | 预热 + 2×10 分钟 | `PC-06`、`RD-03a`、`RD-03b` | 两条旅程各自 P95/丢包/连续性通过 |
| 18 | RD-03e | 远程桌面 | `jiang-chenx` 为来源到另两台的两条 A07 旅程 | 3h | 预热 + 2×10 分钟 | `PC-06`、`RD-03a`、`RD-03b` | 两条旅程各自 P95/丢包/连续性通过 |
| 19 | RD-03f | 远程桌面 + 控制面 | N01–N03、N05 控屏正常、切网、抖动和失败恢复矩阵 | 4h | 场景稳定窗另计 | `PC-06`、`RD-03c`、`RD-03d`、`RD-03e` | LAN 稳定 5 秒、控屏切网 15 秒恢复、状态真实、输入停发/不重放；N04 由文件流验证 |

## 完成定义

- G0 只按“唯一 G0 清单”裁决；八个包任一失败即停止候选，保留证据并执行架构修改流程，不自动安装 RustDesk/Guacamole。
- G3 要求 `RD-02`、`RD-03a` 至 `RD-03f` 全部通过。六条 A07 旅程逐条采用[统一统计口径](../../appendix/verification-strategy.md)，每条连续 10 分钟，不允许汇总平均掩盖失败。
- Mesh/Agent 版本、容器摘要、三平台哈希、配置、防火墙规则和证据工具链固定；尖峰入口与规则按场景清理，生产转正只在 G0 后发生。

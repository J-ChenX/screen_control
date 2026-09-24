# MeshAgent 在线假象、控屏黑屏与指标缺失

日期：2026-09-23（北京时间）。状态：已修复高水位节流等待链并部署；第三方异常触发原因、内存增长根因及长期稳定性仍待验证。

## 用户可见现象

门户主机设备显示在线，打开桌面后黑屏或持续加载；同一设备的 CPU、内存指标为“暂不可用”，GPU 指标仍更新。其他在线设备的指标正常。

## 已确认的现场证据

- 门户、MeshCentral、MeshAgent 三个服务均为 active/running；健康 API 返回成功。目标处于活动 X11 会话且未锁屏。
- Tailscale IPv6 双向直连可用，往返约 10–14ms；SSH、门户 HTTP 正常。连接层可达不能证明 MeshAgent 正在处理消息。
- API 快照中目标设备 state=online，cpuPercent、memoryUsedBytes、memoryTotalBytes 均为 null；GPU 为 live。
- MeshAgent 主进程阻塞于 `pipe_read`。其子进程为 `addr2line <address> -e /opt/screen-control/meshagent/meshagent`，处于 D 状态，等待点为 `mem_cgroup_handle_over_high`。
- 子进程标准输出连接到管道，主进程处于管道读取；现场组合支持“主进程等待符号解析子进程，而子进程被内存高水位节流阻塞”的判断。
- addr2line 的 ELAPSED 为 16283 秒（约 4 小时 31 分）。这是进程存活时间，不能证明它在整个时段都处于同一等待点；可以确认其启动早于当天 IPv6 网络调整。
- MeshAgent TCP 连接仍为 ESTABLISHED，接收队列约 1,369,229 字节，说明在线连接与积压消息可以并存。该连接同时被 addr2line 继承，是否影响掉线检测需继续核对。
- 服务内存高水位为 512 MiB，硬上限为 768 MiB；MemoryCurrent 约 553,832,448 字节。cgroup `memory.events`：high=7,928,353，max=0，oom=0，oom_kill=0，oom_group_kill=0。high 是累计事件计数，不是内存大小或持续时间。
- 日志存在更早一次 OOM 后重启的记录，但本轮 cgroup 的 OOM 计数为 0，不能把本次卡死归为新发生的 OOM kill。

## 原因判断与未决问题

直接故障是 MeshAgent 未继续消费和处理消息；当前堆栈与计数指向符号解析子进程遭受 memory.high 节流，父进程同步等待，导致桌面和 CPU/内存采样一并停顿。GPU 采样走独立路径，因此仍可更新。

尚未确认触发 addr2line 的原始异常、内存增长来源，以及是否存在底层采集缺陷。现场未保留 core、完整原生调用栈或可复现输入；不能据此断言 SIGSEGV、具体泄漏点或单一永久根因。IPv6 调整不是目前证据支持的直接原因。

## 已执行恢复与验证

1. 重启既有 `screen-control-meshagent.service`；普通停止进入 stop-sigterm，进程未及时退出。
2. 对该服务组执行 SIGKILL，原重启操作随后完成；未修改内存预算、程序二进制、路由器配置或项目源码。
3. 新代理 active/running，Result=success，初始内存约 26.9 MB。
4. 使用无键鼠注入的浏览器探针打开目标桌面，实际接收并绘制 3840×2160 画面。探针普通结束会话，没有锁屏，也没有保存屏幕内容。
5. API 连续两次恢复 CPU、内存及 GPU 数据：CPU 约 0.80% / 0.67%，内存已用约 11.52 GB，总量约 33.32 GB，GPU 为 live。

此次只完成恢复与短测，未完成长期稳定性验证。不要将服务重启视为永久修复。

## 针对性修改入口与建议

| 入口 | 建议验证的问题 |
|---|---|
| `deploy/g0/meshagent/linux/screen-control-meshagent.service`、实际安装的内存 drop-in | memory.high 是否让代理及异常处理子进程永久失去进展；用受控内存压力验证超时、退出及恢复，不能仅提高上限掩盖增长 |
| MeshAgent 原生符号解析/子进程调用路径（第三方固定工件） | addr2line 调用是否同步且无期限；增加有界等待、失败降级、子进程资源隔离或非阻塞诊断前，先确认具体上游代码与工件版本 |
| `internal/g0bridge/mesh.go`、`internal/g0bridge/server.go` | 在线连接与响应活性分离；持续无 CPU 响应、桌面首帧超时不应仍被当作功能健康；注意单项采样失败不能直接触发重启 |
| `web/src/features/desktop/MeshDesktop.tsx` | 区分“隧道已连”和“已收到首帧”；没有首帧时提供明确错误与有界重试，不能一直黑屏 |
| `tests/operations/test_meshagent_g0.py`、`tests/performance/desktop-memory.mjs` | 添加保持 TCP 连接但代理不响应、诊断子进程阻塞、memory.high 压力、停止升级与恢复测试 |

建议验收：首次画面、CPU/内存采样、普通断开/重连、长时间空闲与持续控屏、内存增长与节流事件增量；异常恢复不得重放键鼠、自动锁屏或中断其他设备。活性检测与自动恢复应有连续失败门槛、冷却和最大频率。

相关背景：[内存评估与现有回滚方案](MEMORY.md)。该文档记录的是本次现场事实与后续排查建议，不批准放宽安全边界或替换第三方工件。

## 2026-09-23 针对性修复

上述现场证据和恢复步骤保持原始适用范围。本次修复既有内存策略造成的无限节流路径，不替换固定 MeshAgent，也不将未知的原生异常或内存增长宣布为已修复。

- `MemoryHigh=infinity` 取消代理 cgroup 的高水位节流，`MemoryMax=768M`、`MemorySwapMax=128M` 和 `OOMPolicy=kill` 保持不变。硬上限仍保护主机；无法回收时允许整个代理组退出并恢复。依据：[内核 cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)，`memory.high` 只节流而不会调用 OOM killer，不能把它当作有超时的内存保护。
- 明确 `TimeoutStopSec=15s`、`KillMode=control-group`、`SendSIGKILL=yes`，让不响应 SIGTERM 的父子进程按期限升级清理。真正不可中断的内核等待仍可能推迟退出，不能承诺任何 D 状态都能在 15 秒内结束。
- `StartLimitIntervalSec=300`、`StartLimitBurst=3` 配合原有 5 秒重启等待限制失败循环。包含首次启动在内，5 分钟最多 3 次启动；触发后保持失败，排查后由管理员清除失败状态并启动，不无限打断会话。
- 既有部署通过单独的 `60-stall-recovery.conf` 覆盖和 `configure-stall-recovery.sh` 热更新，未重建门户或混入工作区其他修改。未添加基于 CPU 单项缺样的自动重启，也未修改锁屏、输入重放、网络规则或第三方工件。

### 验证与部署

- 10 项 MeshAgent 运维测试通过；root systemd 静态校验通过，仅有系统其他既有单元警告。
- 4 项显式启用的隔离系统回归通过：缩小预算复现子进程分配内存被节流、父进程读管道等待，取消高水位后继续执行；子进程超过硬上限使整个组退出并自动恢复；忽略 SIGTERM 的父子进程在停止超时后均被清理；连续失败只启动 3 次后停止。测试单元和临时文件已清理。这些是同类等待链模拟，不是第三方异常的原始输入复现。
- echova、nix 的实际 cgroup 均为 `memory.high=max`、`memory.max=805306368`、`memory.swap.max=134217728`；代理保持 active，热更新未触发重启。门户健康及快照 HTTP 200，两台 CPU/内存有数据。
- 真实浏览器从对端控制 echova（3840×2160）与 nix（2880×1800），各在 1440 / 390 视口完成三轮连接、画面绘制、画质切换及普通结束，共 12 轮通过。停止后画布均归还到 1×1、未关闭位图数为零；未注入键鼠、未保存屏幕、未触发锁屏。
- echova 的热回滚与再次应用已验证通过。当前回滚入口：echova `/var/lib/screen-control/stall-recovery-t3NHybSK/rollback.sh`，nix `/var/lib/screen-control/stall-recovery-kMICE3K9/rollback.sh`，均需 sudo。回滚仅恢复/移除本次覆盖并重载单元；会恢复旧的节流风险。备份保留供排查，不覆盖 2026-09-22 的历史回滚。

尚未完成：原生异常及泄漏根因、24 小时空闲与持续控屏、Windows/其他代理的同类保护、应用层活性判定和首帧超时提示。取消本服务高水位仅消除已记录的节流路径，不保证所有网络在线但代理不响应的故障均可自动恢复，也不构成 G0/G3 正式验收。

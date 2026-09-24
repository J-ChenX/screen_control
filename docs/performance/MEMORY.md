# 内存预算与语言选型评估

适用范围：当前 G0 桥接、MeshCentral/MeshAgent 与网页桌面。2026-09-22 的测量不是 G0/G3 正式验收，也不覆盖离线设备或长期运行。

## 后台与使用期间分别计量

- 后台：无人控屏、文件窗口关闭时，分别采样门户服务组、MeshCentral 容器、每台 MeshAgent 及独立 SyncClipboard。不要将整机“已用内存”归给门户。
- 使用期间：分别采样控制端浏览器、门户中继、被控端代理/采集子进程、按需文件进程；至少包含原画质、流畅模式、传输、反复连接与结束后的回落。
- Linux `MemoryCurrent` 是整个 cgroup 的计费内存，包含子进程及部分内核/文件缓存；RSS 是进程驻留页；PSS 按共享比例计量。不要简单相加父子进程 RSS（采集进程可能 fork 共享页）。Swap 单独列出。Go `B/op` 是每次分配总量，不能当成 RSS。
- 浏览器 JS 堆不含全部解码、画布、GPU 和网络存储；本次另测专用 Chrome 进程组 PSS，并检查位图释放和画布尺寸。强制 GC 只用于停止后的比较，不进入产品运行路径。

## 当前保护与释放规则

| 位置 | 预算与策略 |
|---|---|
| Linux MeshAgent 服务及子进程 | `MemoryHigh=infinity`、`MemoryMax=768M`、`MemorySwapMax=128M`；`OOMPolicy=kill` 配合既有 `Restart=always`。2026-09-23 取消会阻塞同步诊断的高水位节流；触及硬上限且无法回收时结束整个代理组，随后重启。停止超时 15 秒，5 分钟最多 3 次启动。 |
| Go 门户服务及本地 SSH 子进程 | `GOMEMLIMIT=128MiB` 软预算，服务组 `MemoryHigh=192M`、`MemoryMax=256M`、`MemorySwapMax=64M`；`OOMPolicy=kill` 配合既有失败重启。Go 软预算不包含全部本机库、映射和子进程。 |
| 桌面/文件会话 | 两类合计最多 16 个，正在建连也占配额。满额返回 HTTP 503 / `SESSION_CAPACITY_EXCEEDED`；失败建连归还配额。未领取会话仍按 90 秒到期；领取失败、断线、结束及时释放，停止不再需要的计时器。 |
| 桌面中继 | 每方向固定 32 KiB 复制缓冲，保留 WebSocket 消息类型与边界，写端背压传到读端。消息限额仍为 64 MiB；超限/取消时关闭部分消息，不报告完整成功。 |
| 浏览器图块 | 最多 128 个未完成图块、16 MiB 压缩内容、同时最多 2 个解码任务、64 MiB 已解码位图。使用 Blob/ImageBitmap，避免 base64 副本；按原协议序号绘制，绘制完立即 `close()`。异常或超预算结束连接并提示手动重连，不丢弃增量图块继续显示损坏画面。 |
| 结束桌面 | 清理图块、协议累积缓冲和回调；迟到解码结果立即关闭；画布降到 1×1 归还后备存储。普通结束不锁屏，不重放输入。 |
| 文件 | 保留已有逐块背压、1 MiB 协议帧限、分页目录和虚拟列表。小于等于 16 MiB 的浏览器下载使用内存，更大下载使用 OPFS，设备间传输不聚合整个文件。未更换文件协议或限制文件总大小。 |

浏览器图块预算约束应用保留量，不是浏览器总内存硬上限；解码器临时分配、Canvas、GPU、WebSocket 及浏览器自身另占内存。普通用户文件进程在远端按需运行，不会因门户的 cgroup 上限而自动受到跨机器限制。MeshCentral 是独立服务，本次未修改其配置。SyncClipboard 的附加优化见下文，账号、历史条数、保留期限和同步能力保持不变。

## 2026-09-22 实测

部署前：

- `echova` MeshAgent 主进程 RSS 8,234,412 KiB（约 7.85 GiB），匿名内存约 7.85 GiB，另有 Swap 553,348 KiB（约 540 MiB）；服务组约 7.92 GiB，已运行约 14.5 天，没有内存上限。
- `nix` 代理服务组 4,855,087,104 字节（约 4.52 GiB），没有内存上限。父进程和采集子进程 RSS 均很大，不能相加冒充实际物理内存。
- 门户服务组约 9.6 MiB，MeshCentral 容器约 214 MiB；另观测到 SyncClipboard 桌面端约 992 MiB RSS、服务端约 388 MiB RSS。未对剪贴板历史或缓存做清理，不能推定这些都是泄漏。

两台在线 Linux 代理重启并施加预算后均恢复在线。后续短测：`echova` 服务组约 28 MiB，`nix` 控屏期间约 53 MiB，门户约 9.4 MiB；未触发自动重启。这一降幅主要来自释放此前累积的内存，**不证明第三方代理的长期泄漏已修复**。已知上游有[相似报告](https://github.com/Ylianst/MeshAgent/issues/354)，但不能据此断定同一根因。须进一步用对应固定版本的符号化采样或隔离复现定位；不直接替换已固定哈希的代理。

中继基准（锁定 Go，1 MiB 消息，50 次，环回真实 WebSocket）：

| 方式 | B/op | allocs/op | ns/op |
|---|---:|---:|---:|
| 原完整消息缓冲 | 2,269,806 | 935 | 1,533,373 |
| 固定缓冲流式中继 | 47,242 | 1,300 | 746,240 |

每次分配字节减少约 97.9%，小分配次数增加。时间数据仅为本机微基准，不作为端到端帧率结论。

真实 Chrome 通过可信入口控制 `nix`（2880×1800），桌面 1440 与手机 390 视口，各完成三轮连接、原画质/流畅切换、正常结束，无远端输入、无屏幕保存：旧版结束后画布仍为 2880×1800，新版每轮结束为 1×1，位图保留数为零。桌面第三轮结束 PSS 从约 623 MiB 降到约 478 MiB；手机第三轮结束从约 492 MiB 降到约 356 MiB。逐轮数据见[测量记录](memory-20260922.json)。该 PSS 属于专用浏览器实例，受内容、Chrome 缓存和采样顺序影响，不能外推为所有手机的确定降幅。JS 堆回收后约 3.2–3.4 MiB，变化不大，说明只看 JS 堆会漏掉画布/图像资源。

## SyncClipboard 附加优化

客户端和服务端单独计量。优化前 `echova` 客户端约 992 MiB RSS、另有约 868 MiB Swap；`nix` 客户端约 1.83 GiB RSS、另有约 392 MiB Swap。服务端约 395 MiB RSS、55 MiB Swap，其 .NET Server GC 在 28 逻辑核主机上产生了 56 个 GC 相关线程。

检查固定的 3.1.5 源码与已安装 runtimeconfig 后，采用 .NET 官方运行时配置，不升级或重编第三方软件：

- 两种角色均用 `System.GC.Server=false`（Workstation GC），`System.GC.ConserveMemory=5`；服务端托管堆及 GC 记账预算为 256 MiB，桌面客户端为 384 MiB。JSON 中 `HeapHardLimit` 是十进制字节数，不使用环境变量的十六进制写法。
- 服务端既有 `syncclipboard.service` 设置高水位 384 MiB、总内存上限 512 MiB、Swap 64 MiB。
- 客户端使用**已有** XDG 自动生成的 `app-xyz.jericx.desktop.syncclipboard@autostart.service`，高水位 640 MiB、总内存上限 768 MiB、Swap 128 MiB，失败时重启。此前手工启动的实例位于浏览器 cgroup，不能对那个混合组施加限制；本次先通过程序既有退出管道正常结束旧实例，再启动已有自启动单元，确认只有一个实例。
- 主程序 runtimeconfig 预算对直接启动同样有效；总进程组预算仅对上述 systemd 单元中的实例有效。自定义启动方式和升级覆盖 runtimeconfig 后须复核。没有设置全局 .NET 环境，避免影响其他程序。

初步复测：`echova` 服务端服务组约 155 MiB，客户端服务组约 248 MiB；`nix` 客户端服务组约 509 MiB，均未发生自动重启。服务端 GC 相关线程从 56 降至 0（Workstation GC 仍会执行垃圾回收）。前后 RSS/cgroup 数值口径不同，因此不据此计算精确百分比；进程重启亦释放了旧积累，不能把全部降幅归功于 GC 配置。

已验证两台在线客户端的已配置同步入口、当前剪贴板读取和历史查询 HTTP 200；服务端前后当前剪贴板及首屏历史响应哈希一致。4 路并发的 100 次只读历史查询和 SignalR 协商通过。未注入测试剪贴板、没有降低历史数量或清除用户历史；因此不将这些读操作冒充图片/文件跨端完整写入同步验收。两台 Linux 的历史面板各打开/关闭三轮，通过已有程序命令和 X11 窗口关闭事件操作，不选择历史项、不保存画面；`echova` 活动 RSS 约 423–435 MiB，`nix` 约 462–463 MiB，Swap 均为零且 PID 未变。`nix` 最初采用 512 MiB 高水位时回收事件较多，最终调整为 640 MiB 高水位并保留 768 MiB 硬上限，避免频繁节流；调整后连续 20 秒采样未新增高水位事件。关闭面板未立即回到冷启动占用，仍有运行时/图像缓存；不宣称缓存泄漏已修复。逐轮数值见[测量记录](memory-20260922.json)，复测命令为 `python3 tests/performance/syncclipboard-memory.py`。尚无 24 小时结论。

配置工具及模板：`deploy/g0/suite/configure-syncclipboard-memory.py`、`syncclipboard-server-memory.conf`、`syncclipboard-desktop-memory.conf`。工具只修改指定主程序的 runtimeconfig 三项属性，原字节备份为同目录 `.before-memory-<UTC>`，保留其他字段和权限。运行示例与步骤见[套件说明](../../deploy/g0/suite/README.md#syncclipboard-内存配置)。两台已部署 Linux 均保存 `$HOME/.local/state/screen-control/memory-20260922/rollback-clipboard.sh`；恢复对应 runtimeconfig 备份、移除本次单元覆盖并重启，客户端文件恢复需要 sudo。

托管堆预算不包含 Avalonia/Skia 图像、SQLite、运行时本机代码等全部资源，所以另设进程组上限。回收更积极可能增加 CPU 与暂停时间；存活对象超过预算可能导致 OOM，并影响当次未完成同步。限制的是内存，不改变剪贴板同步协议、文件大小、数据库或保留期限。依据：[.NET GC 官方配置说明](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector)。

## C++ / Rust 是否值得

结论：当前不建议重写 Go 门户；若后续替换桌面采集/编码模块，优先考虑 Rust 做生命周期与有界队列管理，并复用成熟的原生采集/编解码库。

| 方案 | 可能收益 | 当前局限与成本 |
|---|---|---|
| 保留 Go，优化流式转发与资源释放 | 已验证减少分配；软预算与 cgroup 保护可直接部署 | GC 有堆余量，仍需控制存活对象与并发；软预算不是硬上限。 |
| 门户重写为 Rust | 无追踪式 GC，资源可按所有权及时释放 | 当前门户仅约 10 MiB，收益上限远低于代理的数 GiB。会话、Tailscale 身份、文件权限、网关等必须重新验证；无等价实现，不能宣称确定比例。 |
| 门户重写为 C++ | RAII、缓冲池与原生库可细控分配 | 同样无法释放另一个进程的内存；手动资源、生命周期和并发错误的维护成本更高。 |
| 替换/修复 MeshAgent 采集模块 | 对实际瓶颈更有针对性，可限制帧池、发送队列和采集进程生命周期 | [MeshAgent 本身已有原生 C/C++ 与脚本运行时](https://github.com/Ylianst/MeshAgent)，换语言不自动修复泄漏。重写须重新覆盖 Windows 安全桌面、Linux X11、断线恢复和权限边界，不属于本次直接迁移。 |
| SyncClipboard 改写为 Rust/C++ | 可能减少 .NET/Avalonia 基线及部分复制 | 需要重做多平台剪贴板、历史数据库、图片/文件与 SignalR 协议兼容。当前先使用运行时预算；本次未做等价原型，不能给出重写节省比例。 |
| 前端改成 Rust/WASM | 某些解码/计算路径可能获益 | 不自动减少 Canvas、GPU 或浏览器开销；跨 WASM/JS 拷贝还可能增加占用。本次先显式释放位图。 |

4K（3840×2160）单张 RGBA 像素面约 31.6 MiB，三张约 94.9 MiB，与语言无关。收益通常来自减少副本、限制排队、按需采集、及时释放；压缩 JPEG 质量降低不一定降低解码像素占用，降低分辨率才会减少像素面。

[Go GC 指南](https://go.dev/doc/gc-guide)明确软内存预算与 GC CPU 的取舍；[Rust 所有权说明](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)解释无 GC 的生命周期机制，但[Rust 官方也说明引用环仍可泄漏](https://doc.rust-lang.org/book/ch15-06-reference-cycles.html)。因此本评估是基于当前测量的工程判断，不是跨语言跑分。若决定迁移，应以相同设备、分辨率、帧率、文件大小和连接数做等价原型，比较空闲 PSS、活动峰值、断线回落、CPU、延迟与 24 小时增长斜率，再做选择。

## 复测与回滚

```bash
systemctl show screen-control-meshagent.service -p MemoryCurrent -p MemoryHigh -p MemoryMax -p MemorySwapMax -p NRestarts
systemctl --user show screen-control-suite.service -p MemoryCurrent -p MemoryHigh -p MemoryMax -p MemorySwapMax -p NRestarts
mise exec -- go test ./internal/g0bridge -run '^$' -bench BenchmarkDesktopRelay -benchmem -benchtime=50x
SCREEN_CONTROL_ENV_FILE="$HOME/.config/screen-control/tailscale.env" ./ops/with-env mise exec -- node tests/performance/desktop-memory.mjs nix
```

采样 Swap 和 OOM 次数时，读取对应 cgroup 的 `memory.swap.current`、`memory.events`；服务组路径由 `ControlGroup` 属性获得。探针仅输出数值与登记设备 ID，不输出账号、地址、凭据或屏幕内容；需要本地 Chrome 和可信入口，目标不得是当前设备。

本次使用与当前部署二进制哈希、静态产物一致的源码作为基线，叠加内存改动构建；保留原有第四台设备支持。只更新门户版本链接与内存 drop-in，不重装文件进程、不修改防火墙、监听、凭据或固定代理工件。现有代理重启仍执行原有网络检查。

本次回滚入口：两台已部署 Linux 的 `/var/lib/screen-control/memory-20260922/rollback-agent.sh`（需 sudo）；门户主机的 `$HOME/.local/state/screen-control/memory-20260922/rollback-suite.sh`。回滚脚本只移除本次 `50-memory.conf`，门户恢复原版本链接；原配置和收藏备份一并保存。执行回滚后仍须验证门户健康、身份、设备在线与控屏。内存上限可能主动断开远控会话，这是保护主机的兜底，不代表无损恢复。

未完成：Windows MeshAgent 内存保护（代理恢复结果见下文）、离线 lerrem 的部署与测量、Android 真机、长期空闲及连续控屏的 24 小时观测、1080p/25 FPS 正式门、第三方代理泄漏根因与等价 Rust/C++ 原型。不得将上述短测或内存保护称为这些验收通过。

## 本次检查状态

Go 全包测试、桥接竞态测试、前端 59 项测试及类型检查、MeshAgent 运维 9 项与 SyncClipboard 配置 3 项通过；systemd 单元静态校验通过（系统其他既有服务有无关警告）。桌面/手机 1440、390、320 布局及画质切换测试通过，真实控屏六轮及两台 Linux 剪贴板历史面板短测通过。

`tests/browser/desktop-files.mjs` 的第 46 行旧宽度断言失败；在未加本次修改、与部署一致的基线也可复现同一失败。文件弹窗样式未修改，该测试不计为通过。未运行全量正式 `make verify` 或 G0/G3 验收。

## Windows 在线状态纠正与补充部署

2026-09-22 再次核对：`Jiang_ChenX` 的 Tailscale 在线、SSH 可达。此前“离线”仅来自 MeshCentral 的代理状态，不是整机状态；不能只凭代理快照跳过机器可达性检查。Windows 的 Mesh Agent 服务停止，既有守护任务退出码为 1；只读 `Assert` 检查发现活动非 Tailscale 网卡 18 缺少对应阻断规则。没有绕过守护、启动未受保护的代理或修改防火墙。修复专用规则需要按 AGENTS.md 第 6 节单独授权，因此 Windows 远控代理部署尚未完成。

已独立完成 Windows SyncClipboard 配置：实际主程序加载 CoreCLR / .NET 9.0.14；用 `configure-syncclipboard-memory-windows.ps1` 备份原 runtimeconfig 并设置 Workstation GC、`ConserveMemory=5`、384 MiB 托管堆预算。先在独立文件上验证原始备份及其他字段保留，再使用普通用户交互令牌和程序已有 `--shutdown-previous` 参数重启；临时计划任务已删除，确认新实例位于原图形会话。未更改账号、历史条数或系统全局环境。

启动后短测工作集由 574,517,248 字节（约 548 MiB）降至 306,581,504 字节（约 292 MiB），Private Bytes 由 438,951,936 降至 162,689,024 字节。降幅包含重启释放的旧积累，不代表长期泄漏已修复。已从 Windows 读取其现有配置进行鉴权验证，版本、当前剪贴板和历史查询均 HTTP 200；不输出凭据或剪贴板内容。未完成 Windows 连续使用/图片同步压力测试。

Windows 这里只配置了托管堆预算，**没有**套用 Linux cgroup 的全进程 768 MiB 硬上限，WinUI/原生图像内存不全部受 GC 预算约束。回滚配置与可执行脚本保存在该用户 `%LOCALAPPDATA%\ScreenControl\memory-20260922\`；运行 `rollback-clipboard.ps1` 会恢复备份并在原交互会话重启。软件升级后须重新核对 runtimeconfig。

## Windows 代理恢复复查

2026-09-22 23:26（北京时间），用户明确要求启动后，重新运行已安装的 `Screen-Control-G0-MeshAgent-Watchdog` 启动任务；沿用现有守护脚本和登记白名单，重建代理专用规则，未替换代理工件或扩大允许范围。操作前将任务 XML 和专用规则快照保存在 Windows 用户 `%LOCALAPPDATA%\ScreenControl\agent-recovery-*\`。服务与守护任务均恢复 `Running`，两次 `Assert` 检查通过，门户健康正常，权威设备快照确认 `jiang-chenx` 为 `online`。

自启由启用的 SYSTEM 开机任务负责，因此 Mesh Agent 服务的 `Manual` 模式是预期配置。任务已有每分钟重试、最多 3 次的设置，并非无限恢复；本次恢复前任务退出码为 1，当前规则检查暴露网卡接口 18 缺失对应阻断规则，但没有取得上次退出瞬间日志，不能断言历史退出的唯一原因。未执行整机重启或登录前控屏验收；后续网卡变化后的持续恢复能力仍需单独验证。

## SyncClipboard 客户端原生内存二次优化

2026-09-22 对 echova、nix 的既有 Linux 客户端单独添加 `MALLOC_ARENA_MAX=2`、`MALLOC_TRIM_THRESHOLD_=131072`、`MALLOC_MMAP_THRESHOLD_=131072`。前者限制 glibc 分配区域数量，后两者固定 128 KiB 回收/大块映射阈值，减少原生分配器保留量；含义见 [glibc 官方文档](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html)。仅作用于该客户端服务环境，不更改系统全局变量、托管堆预算、历史保留数量或同步功能。Windows 不适用，保持之前配置。

每组从客户端重启开始，使用相同历史面板打开/关闭探针，且不选择历史条目。十轮后关闭状态 RSS：

| 主机 | 原配置 | 原生分配器调整后 | 限制 |
|---|---|---|---|
| echova | 454.0 MiB | 415.6 MiB；另一组在额外十轮后为 399.0 MiB | 最后十轮的独立重启对照约降低 8.5%；两组新配置并非完全相同轮次 |
| nix | 两组 460.3 / 493.5 MiB | 429.6 MiB | 原配置自身有波动，短测降幅约 6.7%–12.9% |

echova 同轮次对照 PSS 为 428.5 → 390.3 MiB，累计进程 CPU 约 7.99 → 7.80 秒；nix 有 CPU 记录的对照为 444.5 → 380.6 MiB、95.02 → 94.66 秒。nix 的较高 CPU 开销在原配置下同样出现，未在本次定位其根因。两机测试 PID 在各轮内不变、Swap 为零；没有通过定时重启或降低历史数量制造下降。原始逐轮数据见[二次优化记录](syncclipboard-native-20260922.json)。这里只能证明短测关闭后的驻留量改善：nix 第一组原配置与新配置的采样峰值近似，不能宣称使用峰值显著下降，更不能代替大图片、文件同步或 24 小时验收。

已部署到两机既有 XDG 用户服务的 `50-memory.conf`，运行环境核对和原有同步 API 只读健康检查通过；没有新增常驻服务。回滚执行各机 `$HOME/.local/state/screen-control/native-memory-20260922/rollback.sh`，仅恢复二次优化前的服务覆盖并重启客户端。若升级改用非 glibc 原生分配器，应重新验证这三个变量是否适用。当前客户端源码的历史窗口关闭路径为隐藏窗口，窗口对象仍保留；这只是后续源码优化线索，不等同于已证明的泄漏。本次没有修改或编译第三方客户端源码。

部署后补查：echova 的 cgroup 高水位/OOM 计数均为零；nix 有累计高水位回收计数，独立 10 秒空闲复查没有新增高水位或 OOM 事件，自动重启为零。nix 服务组当前约 627 MiB，包含文件缓存等，不能与进程 RSS 混用或据此宣称整个服务组已降到约 430 MiB。

后续用户另行要求已启用非收藏历史 48 小时清理，覆盖三台客户端及服务端；这改变了此前“历史保留期限不变”的任务范围，早期内存对照仍适用当时未清理的数据。具体规则、验证与数据备份见[历史保留记录](SYNCCLIPBOARD_RETENTION.md)。不能将清理后内存变化直接归因于前面的原生分配器调整。


## 2026-09-23 代理卡死现场

控屏黑屏与 CPU/内存采样缺失、memory.high 节流及符号解析子进程等待的现场证据，见[MeshAgent 卡死记录](MESHAGENT_STALL_20260923.md)。已修复高水位导致的节流等待链并热部署到两台 Linux；第三方内存增长根因和长期验收仍未完成。

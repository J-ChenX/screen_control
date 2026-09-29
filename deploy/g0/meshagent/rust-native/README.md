# Rust 原生代理构建与运行

## 当前运行范围

2026-09-29，本轮选择默认构建及 Rust 最后分片扩容优化，Windows 工件为 `27a434c9…44cf`，用于已登记设备 `jiang-chenx` 的可回滚运行观察。Ubuntu `nix`、`echova`、`lerrem` 已同步共享 Rust 核心及 Linux 图像处理，并补上 Linux 采集暂停，见[Ubuntu 记录](../../../../docs/performance/UBUNTU_RUST_RUNTIME_20260929.md)与[Linux 工件清单](linux-runtime-manifest.json)。五个可选 C 生命周期补丁未进入此工件：此前包含它们的 `4213e8dd…f7039` 曾通过短测，却在保留后的新会话超时，已撤回。Rust 在两个组合中都实际参与帧、分片和图块处理；不能把排除实验补丁理解为移除了 Rust。[实机记录](../../../../docs/performance/RUST_RUNTIME_20260929.md)与[工件清单](windows-runtime-manifest.json)是当前状态和限制的入口，下方原始候选记录保留各自时间点的事实。

最后分片需要扩容时，Rust 现在只申请完整消息所需容量；中间分片仍按预算内倍增。独立正常输入对照中，10,000 + 3 字节消息的输出容量由 20,000 降至 10,003，完成后连接不保留该容量。该局部分配改善不等于进程常驻、系统峰值或长期泄漏已改善。

`build-windows.ps1` 接受 `prepare_windows_msvc.py` 生成的目录，复核静态库及 MSVC 准备文件，调用已安装的 MSBuild 完整重建，只有成功后才将两个 EXE 和构建日志摘要写入 `candidate.json`。传输目录前后应另外核对打包归档的 SHA-256，不能只凭目录名或历史文档选择二进制。

```powershell
.\build-windows.ps1 -WorkDir <准备目录>
.\windows-canary.ps1 -Mode Arm -CandidatePath <最终服务EXE> -CandidateSha256 <清单中的摘要>
# Arm 输出的备份目录含旧 EXE、guard、身份快照和本次恢复脚本。
# 六分钟自动回滚内完成正常会话；失败时恢复，未完成时不要保留。
.\windows-canary.ps1 -Mode Retain -BackupDir <Arm输出目录> -CandidateSha256 <同一摘要> -BuildManifest <candidate.json>
.\windows-canary.ps1 -Mode Restore -BackupDir <同一备份目录>
```

保留操作原子写入 `rust-runtime.json` 后撤销自动回滚，固定哈希守护继续运行；此后仍能显式 `Restore`。自动任务和操作者共用互斥锁，已经排队的自动任务会在锁内复查保留凭据。保留凭据提交前不禁用自动回滚，提交后清理任务失败只报告警告。恢复只切回 EXE/guard，保留当前身份数据库；本轮同一上游版本没有模式迁移，且恢复旧版后的真实会话已通过。身份备份不能被表述为已自动恢复。

Windows 管理员环境可运行无真实服务操作的控制流回归：

```powershell
.\tests\operations\windows-canary.test.ps1 -CanaryScript .\deploy\g0\meshagent\rust-native\windows-canary.ps1
```

内存检查使用 `python3 tests/performance/windows-agent-memory.py --expected-sha256 <实际运行摘要>`，显式配置当前 SSH 目标；它拒绝样本内工件或主 PID 切换。`desktop-memory.mjs` 被动验证每轮新画面及释放；`desktop-session-live.mjs` 另检查暂停/恢复并发送一次 Ctrl 按下/释放，要求显式可信门户，只用于已登记 Ubuntu 或 Windows 目标。工作集求和不是 PSS，报告应优先比较私有提交量，并说明采样间隔、空闲窗口和负载差异。

## Ubuntu 既有代理更新

枚举更新目标时核对正在运行的套件配置中的 `SCREEN_CONTROL_DEVICE_NODES` 和 `SCREEN_CONTROL_FILE_SSH_TARGETS`，包括独立的 `tailscale.env`、`files.env`；根目录 `.env` 可能仍是早期设备映射，不能据此遗漏已登记目标。连接前逐机确认系统、当前工件、SSH 救援和现有服务限制。

`linux-canary.py` 只更新已安装的代理，保留现有 service、身份数据库、出站限制与内存预算。它核对当前进程和工件摘要，备份旧二进制及校验清单，在独立 root 定时器建立后切换候选；十分钟内未显式保留就恢复原工件。保留与回滚共用文件锁，保留凭据写入前不会取消定时器。`restore` 只恢复二进制及校验清单，身份快照只供人工救援。

```bash
sudo python3 deploy/g0/meshagent/rust-native/linux-canary.py arm \
  --candidate <Linux候选二进制> --manifest <candidate.json> \
  --expected-current <现场核对的当前SHA256>
# 在十分钟内完成实机会话、资源回收和健康核对；失败立即 restore。
sudo python3 deploy/g0/meshagent/rust-native/linux-canary.py retain --backup-dir <arm输出目录>
sudo python3 <arm输出目录>/linux-canary.py restore --backup-dir <arm输出目录>
```

`arm` 拒绝消毒器工件、五个可选生命周期补丁和未完成的前次更新；`retain` 拒绝工件不匹配、备份损坏及观察期间发生重启的代理。真实部署前运行 `python3 -m unittest discover -s tests/operations -p test_linux_canary.py`，该回归完全使用临时文件和模拟服务。

Linux X11 主循环现在在处理控制管道后检查暂停标志：暂停时关闭本轮显示连接并短暂等待，不采集和编码画面；后续循环仍能接收恢复、刷新和退出。`desktop-session-live.mjs` 先等待在途图块排空，再在暂停中发送刷新请求，确认没有新画面，恢复后必须出现新帧；它还发送一组 Ctrl 按下/释放并核对普通结束。此探针不证明目标应用实际处理了按键，不能代替完整输入验收。

若构建主机没有系统 X11 开发头文件，可显式设置 `CPATH=<已校验隔离sysroot>/usr/include` 使用已有开发头文件；不更换候选自带 JPEG 头文件和静态库。`make test-native`、默认及 ASan/UBSan 构建仍须通过，不得把消毒器工件安装到服务。

## 原始候选记录

早期强引用实验 `event-emitter-forward-ownership.patch` 未进入构建，且缺少完整释放证明，现已从候选目录删除。需要核对历史实现时，可从 Git 提交 `e61fa53` 的同名路径读取；原始测量仍见[内存回收记录](../../../../docs/performance/MEMORY_RECLAIM_20260928.md)。当前生命周期实验采用下述弱状态方案，只有显式指定 `--lifetime-candidate` 才叠加，仍未部署。

`event-emitter-forward-weak-cell.patch` 是后续隔离方案：目标钩子持有可失效的状态对象，源对象终结或发出 `close` 后推迟清理目标钩子，避免在事件监听器内部锁尚未释放时同步移除。`tests/native/event_emitter_forward_lifetime.py` 的直接事件转发模式在 ASan/UBSan 下验证了 1,000 次源对象关闭、目标钩子回到基线，以及未显式关闭时经 GC 触发的终结器兜底；约 48–49 MiB 的批次 PSS 未持续上升。但完整 WebSocket 的 100 次关闭在第 8 次附近仍可触发 `ILibDuktape_net_socket_ResumeHandler` 读越界；隔离尝试取消待执行恢复回调并在断线时撤销回调后，连接仍在同一位置停滞。该方案及两项未通过的恢复回调尝试均未接入默认构建，也未部署。HTTP 服务探针还单独复现 `ILibDuktape_HttpStream_OnReceive` 在回调后读取失效请求头；这些 C 生命周期边界须继续修复和验证。

对上述弱状态补丁的后续检查发现，`close` 原先只安排延迟清理：目标在回调返回前新增监听器，仍可挂到已关闭的源；关闭前已挂的代理在延迟清理后也留在源上。`tests/native/event_emitter_forward_close.py` 对照复现两类残留及关闭后的误转发。修订补丁在 `close` 时立即使源指针失效，暂时保留源对象到下一轮清理，并按每条转发关系分别登记原监听器和代理函数，下一轮只移除本关系的代理；不删除源和目标的用户监听器。该登记也避免同一目标由多个源转发时，单个 `proxyFunc` 字段被后续源覆盖。隔离 ASan/UBSan 候选对关闭前已有和关闭瞬间新增监听器各 100 次、双源转发及同一函数重复注册均无错误残留；直接转发 1,000 次显式关闭、100 次 GC 兜底、1,000 次长驻 HTTP 请求、300 次取消、300 次正常关闭及 100 次超时断线通过。初次修改曾因复用相对 Duktape 栈索引使 HTTP 首个请求在 `ILibDuktape_readableStream_WriteEnd` 触发 ASan 越界；入口将源与目标索引固定为绝对索引后重验通过。此修订仍未接入默认构建或部署，尚需跨平台、实机会话、长稳负载及独立审查。

进一步的隔离故障注入发现：脚本覆盖全局 `setImmediate` 并使其抛错后，旧清理路径会吞下调度错误，`close` 后的源代理、源关闭钩子和目标转发钩子一直保留。当前补丁直接调用固定源码已有的原生立即计时器入口，由其持有回调至执行并解除堆根，不再读取可被脚本覆盖的全局函数。`tests/native/event_emitter_forward_close.py --expect-schedule-stale` 可对照旧候选；修补候选在覆盖发生于转发建立前或关闭前时，均须回到监听器基线。此检查仍只覆盖隔离事件对象，不代替独立审查和实机会话验证。

`net-socket-active-root.patch` 与 `http-callback-lifetime.patch` 是叠加在上述弱状态补丁后的隔离实验，均未接入默认构建；只有显式指定 `--lifetime-candidate` 才会叠加。前者让活动的客户端及服务端 socket 在原生连接存活期间保留 Duktape 根引用，连接失败或断开时解除；后者在同步 `end` 回调前保存请求头判断值，并让延迟清理回调显式持有消息对象，避免检查已释放的临时缓冲。仅注入临时源码副本的计数钩子显示：Linux ASan/UBSan 候选的 1,000 次快速 WebSocket 重连完成，每 100 次后的活动根数为 0，PSS 从约 52.9 MiB 到 55.7 MiB；1,000 次 HTTP 服务端请求完成，长驻服务对象的转发钩子从 5/6 到 10/11，采样请求期间仅有当前服务端 socket 的一个根引用。取消请求 100 次仍从约 40.8 MiB 增至 59.6 MiB；后续分别观察到请求和 socket 终结，活动根及链模块计数也未解释该增长。补丁仍需独立审查、取消路径定位、Windows 与真实会话验证，不能作为默认构建或部署依据。

`event-emitter-finalizer-once.patch` 针对取消路径的重复终结：5 个请求对象曾触发 22 次 `~` 回调，单个对象最多 8 次。初版在终结时清除 JS 对象的 finalizer，虽减少重复回调，却让冻结对象的清理失效；随后“原生标记 + 受保护清除”的版本通过 Linux 隔离回归，但 Windows 受守护实机会话停在中继连接。逐项对照中，前三个生命周期补丁仍可连接，加入该版终结器补丁就失败。仅保留原生一次性标记的中间候选在 Windows 12 秒短会话进入“实机桌面已连接”，但 Linux ASan/UBSan 的 300 次取消使匿名内存从第 30 次的约 32.9 MiB 增至第 300 次的约 82.9 MiB，不能发布。当前补丁改为先执行 `~` 清理，再受保护地移除仍未被回调替换的 finalizer；冻结对象由原生标记避免重复执行。隔离候选中，普通、密封、冻结对象各 100 个均恰好终结一次，300 次取消的匿名内存从第 30 次约 32.9 MiB 到第 300 次约 37.8 MiB，后段趋稳；加入终结器身份复查后，100 次取消从第 20 次约 29.6 MiB 到第 100 次约 29.7 MiB。当前版本仍需 Windows 真实连接验证，短测不证明长期回收。以上补丁未接入默认构建或正式部署，仍需独立审查、完整会话与长期验收。

`async-socket-preselect-disconnect.patch` 修复事件循环在超时回调后继续使用已关闭 fd 的问题。`ILibAsyncSocket_PreSelect` 先检查 socket、暂时释放锁执行回调，再直接 `FD_SET`；回调若同步调用 `socket.end()`，旧候选稳定触发 `FD_SET(-1)` 的 UBSan 负移位。补丁在重新加锁后复查 fd，若已关闭即解锁返回。`tests/native/async_socket_timeout_disconnect.py` 用无代理身份的回环连接复现旧错误，修补候选连续 300 次超时断线均收到 EOF，另完成 20 次取消、100 次正常关闭和 1,000 次 HTTP 请求，未见 ASan/UBSan 报告。此补丁也未接入默认构建或部署，仍需独立审查和 Windows 验证。

`readable-stream-pipe.patch` 修正 Duktape 可读流按目标执行 `unpipe` 时遗漏后继节点反向指针更新的问题。构建会自动运行 `tests/native/readable_pipe_network.py`，在无代理身份的完整进程回环中检查两种连续移除顺序与数据投递。该补丁位于仍由 C 管理的流生命周期边界，不能由 Rust 帧核心单独保证安全。

`readable-stream-stash.patch` 清理同一 C 边界的长期引用：每次 `pipe()` 产生的原生节点存入目标 Writable 的隐藏对象缓存，旧实现的指定 `unpipe`、全部 `unpipe` 和可读流终结器均未删除对应缓存键。新补丁保存 Duktape 缓冲对象指针以匹配原缓存键，并在三个释放点解除引用。隔离测试钩子直接枚举隐藏缓存：同一目标连续十次连接并移除后，旧候选计数从 1 增至 10，新候选每轮均回到 0；三个目标的指定/全部移除与终结器路径也分别对照。测试钩子只注入临时复制的源码，不进入候选二进制。

完整进程的较长对照可运行 `tests/native/readable_pipe_memory_churn.py`。它要求旧候选与修复候选的构建元数据只相差缓存清理补丁，并确认当前候选额外只有固定的计时器补丁；三个候选的二进制与源码归档摘要均须匹配。脚本在无代理身份的进程中对同一个 Writable 连续执行 10,000 次 `pipe`/`unpipe`，每 1,000 次 GC 后只读取该进程的 PSS 和匿名内存；临时脚本与日志在退出时删除，不访问用户画面或文件。

```bash
python3 tests/native/readable_pipe_memory_churn.py \
  --legacy-candidate /tmp/pipe-fix-asan \
  --fixed-candidate /tmp/pipe-stash-v2-asan \
  --current-candidate /tmp/timer-v2-asan
```

此探针用相同负载比较修复前后的驻留趋势，并设置超时与 256 MiB 的测试进程 PSS 上限。ASan 隔离区设为 0 以减少已释放块对驻留量的干扰；ASan/UBSan 检查仍启用，已知的完整进程泄漏检查在该探针中关闭。结果不能外推到不同对象图、真实远端会话或多日运行。

`timer-lifetime.patch` 修复未保存 JS 句柄的计时器提前被 GC 取消：旧版只把 `setImmediate` 对象放入堆缓存；`setTimeout` 在回调内再次创建 `setTimeout` 时可只触发第一层。补丁在参数校验和注册成功后，让 timeout、interval 和 immediate 在活动期都有根引用，触发或明确取消后移除。完整候选构建自动检查未保存句柄的两层计时器；独立对照还枚举临时测试副本的隐藏根，验证超时触发、取消、无效参数不留下根引用与 interval 停止后的回落。

`tests/native/timer_lifetime.py` 还在临时复制的完整候选中加入只用于测试的活动根计数与进程 PSS 读取钩子，连续取消 10,000 个 timeout，再让 10,000 个 timeout 触发。每 1,000 次在回调结束后检查根引用归零并采样；主动 GC 后允许出现至多一个瞬时根，但下一批检查前必须归零。两种负载各自从第 1,000 到第 10,000 次的 PSS 趋势用于发现持续增长，计时器回调、取消和 interval 的原有对照仍运行。测试钩子不进入候选二进制；PSS 不包含其他代理进程或远端会话。

此目录将固定 MeshAgent 的 WebClient 与 Duktape 脚本 WebSocket 接收帧头、发送/接收掩码和分片所有权替换为 Rust 核心，叠加已保存的原生回收候选。`metadata-ownership.patch` 另修正链模块元数据所有权、`setImmediate` 参数边界、Base64 尾块读取、Duktape 缓冲区内存头探测和脚本堆销毁时的事件转发。`linux-tile-rust.patch` 把 Linux RGB24 tile 逐行复制改为先完整校验范围的 Rust 调用；`linux-ximage-rust.patch` 将 XImage 行距和像素格式转换及 XFixes 光标叠加移入 Rust，并在 C 侧校验共享内存长度和分配结果。`linux-jpeg-buffer.patch` 收紧 Linux JPEG 长度与分配检查，复用编码输出容量，并在单次容量超过 1 MiB 或主循环退出时释放。`linux-checksum-rust.patch` 将 Linux tile 变化校验移入有界 Rust 核心，去掉旧版 RGB24 转 `int*` 后的未对齐读取和末行越界。它尚未部署，连接、JPEG 编码及平台资源仍有 C 实现，不能称为完整内存安全代理。

构建使用根目录固定 Rust 工具链，无第三方 Rust 依赖。纯协议核心禁止 `unsafe`；C ABI 的帧头按值传递，数据区域、分片输出和独立存活租约有明确所有权契约。WebClient 的完整单帧直接交付；Duktape 脚本路径在回交后续帧前保留当前正文副本，防止同步回调释放原接收缓冲。分片缓冲在消息结束或请求销毁后释放。构建脚本只写入指定的新目录，不启动真实代理身份，不更改服务、防火墙或固定工件清单。

```bash
mise exec -- cargo test --workspace --locked
mise exec -- cargo clippy --workspace --all-targets -- -D warnings
python3 deploy/g0/meshagent/rust-native/build.py --work-dir /tmp/screen-control-rust-candidate
python3 deploy/g0/meshagent/rust-native/build.py --work-dir /tmp/screen-control-rust-asan --sanitizers
```

五个原生生命周期修复补丁可通过显式 `--lifetime-candidate` 叠加到同一固定源码；默认命令不叠加它们。先在独立目录运行 `--prepare-only` 核对补丁可无模糊应用，再用 `--sanitizers` 构建并运行回环检查。`candidate.json` 的 `lifetimePatchSha256` 记录实际叠加补丁的名称与摘要，便于把测试结果绑定到候选源码。该标志只生成本地候选，不修改已登记服务；Windows 实际控屏会话与长期内存验证仍是发布前置条件。

Windows 图块复制与变化校验现有独立的 Rust 候选：将实际捕获缓冲长度传到固定源码的 `get_tile_at`，Rust 同时检查 24/32 位像素、底向上坐标、源和目标容量；失败时不修改输出。纯 Rust 测试和 ASan/UBSan C ABI 对照已通过，Windows 原生构建与真实画面仍需核对。

Windows x64 候选使用相同的固定源码；可选择是否显式叠加五个生命周期补丁。在 Linux 上以锁定工具链构建 MSVC 静态库，再运行 `prepare_windows_msvc.py` 修改隔离源码中的两项 Release|x64 工程链接设置、资源头，以及叠加补丁时一处 MSVC 无 UTF-8 编译选项无法解析的注释。该脚本拒绝重复处理或已部署的候选，并把静态库和改动文件摘要写入 `candidate.json`；它不会安装或启动代理。将整个准备目录复制到 Windows 后，以 Visual Studio 2022 的 MSBuild 对 `MeshAgent-2022.sln` 执行 `Release|x64` 的 `Rebuild`，产物位于源码目录的 `Release` 子目录。

```bash
mise exec -- cargo build --locked --release --target x86_64-pc-windows-msvc -p screen-control-protocol-ffi
python3 deploy/g0/meshagent/rust-native/build.py \
  --work-dir /tmp/screen-control-windows-prepare --prepare-only --lifetime-candidate
python3 deploy/g0/meshagent/rust-native/prepare_windows_msvc.py \
  --work-dir /tmp/screen-control-windows-prepare \
  --library target/x86_64-pc-windows-msvc/release/screen_control_protocol_ffi.lib
```

2026-09-29，在在线 Windows 主机的临时目录中，Visual Studio 2022 对叠加五补丁的候选 `MeshService64.exe`、`MeshConsole64.exe` 完整 `Rebuild` 均为零错误；另以同一 MSVC 工具链编译并运行 `tests/native/websocket_abi.c`，C→Rust ABI 检查返回零。静态库 SHA-256 为 `00d2da401dc43ce9993229b94f35da0b4c0fca5c004432cc98303d7ba5e9b3d0`。`-info` 在短时等待中没有退出，不能算代理启动冒烟通过。

对已登记 Windows 服务的短时受守护切换采用 `windows-canary.ps1`：核对旧/新二进制摘要、备份旧工件和身份文件、设置独立 SYSTEM 定时回滚，再更换工件和守护哈希；退出后恢复旧工件、守护脚本和服务。首次试验暴露服务停止后仍有同路径子进程锁住 EXE，脚本已补充明确终止并等待该残留进程。旧的“原生标记 + 回调前受保护清除”五补丁候选（SHA-256 `5def21048d0629e3cff1ddbea4e6744392edb88452b434fb5145a109afbe37fd`）服务运行且控制面在线，但桌面会话卡在中继连接；默认 Rust 核心、弱状态单补丁及前三补丁候选可连接。去掉 finalizer 改写的中间候选（SHA-256 `6416f0d4550097f08b190e57c46da280f119ed72b15610f6facbd1835a1b9ef3`）在 Windows 12 秒短会话重新进入“实机桌面已连接”，但 Linux 取消压力中内存持续增长，不能作为发布候选。当前改为回调后清除原有 finalizer，同时加入 Windows 图块 Rust 边界；最终源码的两项 Windows `Release|x64` 工程零错误重建，`MeshService64.exe` SHA-256 为 `a716094461d16edc58741e59fcd1d9b9c6422bf68fd4dfc666c8b760672598d3`，Rust 静态库 SHA-256 为 `db297a969de870e87abe8207763507483cef9d82fa274e7b6996483f468e7e7a`。此前同逻辑构建的候选服务可在守护下启动；随后 Rust 分组写法调整并重建的最终摘要尚未启动。短时切换时控制门户入口返回 503/502，未取得新组合的真实桌面连接结果；该候选随即撤下，原二进制 SHA-256 `07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7` 已恢复运行，回滚任务撤销。短时启动不构成画面质量、输入、回收和长期稳定性验收。

```bash
python3 deploy/g0/meshagent/rust-native/build.py \
  --work-dir /tmp/screen-control-lifetime-prepare --prepare-only --lifetime-candidate
python3 deploy/g0/meshagent/rust-native/build.py \
  --work-dir /tmp/screen-control-lifetime-asan --sanitizers --lifetime-candidate
```

完整构建通过后，事件转发专项检查使用 `--candidate` 在临时源码副本中注入测试钩子；正式候选二进制不含这些钩子。终结与超时断线检查直接使用候选二进制。若 X11 开发头文件只在隔离 sysroot 中，运行专项检查时沿用构建时的 `CPATH` 和 `LIBRARY_PATH`。

```bash
python3 tests/native/event_emitter_forward_close.py \
  --candidate /tmp/screen-control-lifetime-asan --count 100
python3 tests/native/event_emitter_finalizer_freeze.py \
  --binary /tmp/screen-control-lifetime-asan/MeshAgent-62b206e0b485b296e8a73a6547cef02bbf5a2d62/DEBUG_meshagent_x86-64 --count 100
python3 tests/native/async_socket_timeout_disconnect.py \
  --binary /tmp/screen-control-lifetime-asan/MeshAgent-62b206e0b485b296e8a73a6547cef02bbf5a2d62/DEBUG_meshagent_x86-64 --iterations 100
```

Linux x64 候选需要既有 C 构建依赖（X11/XTest/XRandR/XFixes 等开发头文件）。可用 `--archive` 复用已下载的固定压缩包，仍核对摘要；`--prepare-only` 只校验源码并应用补丁。目录已存在时拒绝覆盖。

缓存引用对照需要上一阶段未含 `readable-stream-stash.patch` 的 ASan 候选，以及当前候选；脚本在临时副本中分别注入只用于计数和调用终结器的测试方法，再构建并运行，不改变原候选：

```bash
python3 tests/native/readable_pipe_retention.py --legacy-candidate /tmp/pipe-fix-asan --fixed-candidate /tmp/pipe-stash-asan
python3 tests/native/timer_lifetime.py --legacy-candidate /tmp/pipe-stash-asan --fixed-candidate /tmp/timer-asan
```

构建完成后，用实际打补丁源码验证 C 接收函数（路径替换为上面的构建目录）：

```bash
python3 tests/native/check_integration.py --source /tmp/screen-control-rust-candidate/MeshAgent-62b206e0b485b296e8a73a6547cef02bbf5a2d62
```

该测试保留真实 WebClient 接收及请求析构函数，替换网络与回调环境，覆盖非零偏移、逐字截断、部分正文不重复解掩码、连续帧、超长拒绝、重组扩容、超预算流式交付、回调同步取消和重复回收。完整构建还自动编译实际 `linux_tile.c` 的 C 调用点并以独立 harness 检查像素行、短缓冲和越界拒绝；运行 `tests/native/script_ws_network.py`，用回环连接驱动完整 Duktape 事件循环，逐字节验证分片、控制帧、独立及共享压缩窗口和大单帧，并确认关闭帧、非法帧及解压超预算后服务端收到 EOF 且没有部分数据交付；不加载真实代理身份。解压仍由既有 C/zlib 模块执行，输出分块累计到完整消息后一次拼接。`tests/native/ximage_live.c` 另提供可选的实际 X11 画面内存对照，不保存图像；它需要可访问的 X11 显示与 MIT-SHM，并与候选 `linux_tile.c` 一起编译。`make test-native` 提供不依赖下载的 Rust 与 C ABI 本地检查。开发头文件也可解压到隔离目录并通过 `CPATH`/`LIBRARY_PATH` 指定，无需修改系统安装。

真实 JPEG 检查从实际 `linux_compression.c` 编码 32、512、2048 像素方形图像，再用绑定的 JPEG 静态库解码，核对尺寸、字节摘要和大帧容量回收。构建强制优先使用源码附带的 JPEG 头文件：静态库 API 版本为 62，当前开发机系统头文件为 80；仅运行代理 `-info` 无法发现这个冲突。

32×32 JPEG 检查还驱动真实 `getTileAt`：首帧发送、相同帧跳过、tile 最后一个像素变化后重新发送，短帧明确失败。新校验只读取 tile 自身字节，因此初始校验值与旧版不同；运行时 tile 状态从当前画面重新计算，不需要迁移持久数据。独立 1920 像素行距、32×32 内部 tile 微基准八次交替运行：Rust FFI 中位数 0.543 微秒/tile，旧版运算的安全 C 对照为 0.564 微秒/tile；这不是完整采集或编码耗时。

有可访问的 X11 显示与 MIT-SHM 时，可对已构建的 ASan/UBSan 候选额外运行真实画面内存管道检查；如系统没有 X11 开发头文件，可沿用构建时的 `CPATH`：

```bash
python3 tests/native/run_x11_jpeg_browser.py --candidate /tmp/screen-control-rust-asan
```

该检查只读取当前屏幕左上、中心、右下各一个 32×32 tile。固定候选的 XShm、Rust RGB24 转换与校验、C JPEG 编码及协议封包生成数据，经子进程内存管道交给 Chromium；浏览器使用门户实际的 `manageDesktopMemory` 连续绘制各 32 次，并逐通道对照同一 JPEG 的 C 解码，确认位图和画布释放。图像与像素值不保存、不记录、不发送到服务；仅输出尺寸、字节数和差异计数。该隔离路径没有登录、远端传输、输入或暂停恢复，因此不能替代真实会话验收。

隔离的 640×480 动态画面检查可增加连续帧数，并每 60 帧打印进程 PSS 与匿名内存（KiB）：

```bash
ASAN_OPTIONS=quarantine_size_mb=0:allocator_release_to_os_interval_ms=1000:detect_leaks=1 \
  python3 tests/native/run_dynamic_tile_live.py --candidate /tmp/screen-control-rust-asan --mode complex-frame --frames 600
```

关闭 ASan 隔离区只为测量分配释放后的驻留趋势，ASan/UBSan 插桩仍在；该测试不使用代理身份或远端连接。其 640×480 全帧编码与真实高分辨率远端会话的内存工作集不同，不能据此宣称生产 OOM 已解决。

同一脚本还支持隐藏的 3840×2160 Xephyr 显示。纯色动态全帧可连续运行 600 帧以观察稳定工作集；`noise-frame` 会在采集后的共享内存副本中生成逐帧变化的高细节数据，不修改外层屏幕，并将首个 jumbo JPEG 通过内存管道交给 Chromium 解码。高度按协议图块补齐到 2176 像素。

```bash
ASAN_OPTIONS=quarantine_size_mb=0:allocator_release_to_os_interval_ms=1000:detect_leaks=1 \
  python3 tests/native/run_dynamic_tile_live.py --candidate /tmp/screen-control-rust-asan \
  --mode full-frame --size 3840x2160 --frames 600
ASAN_OPTIONS=quarantine_size_mb=0:allocator_release_to_os_interval_ms=1000:detect_leaks=1 \
  python3 tests/native/run_dynamic_tile_live.py --candidate /tmp/screen-control-rust-asan \
  --mode noise-frame --size 3840x2160 --frames 60
```

进程 PSS 不包含隔离 X 服务器或浏览器；采集、RGB24 转换和 JPEG 编码均使用未部署的固定候选。纯色与合成噪声分别衡量尺寸和编码复杂度，不代表真实远端画面的变化比例或网络背压。

单独 C ABI 检查与掩码性能对照：

```bash
mise exec -- cargo build --release -p screen-control-protocol-ffi
cc -std=c11 -g -fsanitize=address,undefined -I native/protocol-ffi/include tests/native/websocket_abi.c target/release/libscreen_control_protocol_ffi.a -ldl -lpthread -lm -o /tmp/screen-control-ws-abi
/tmp/screen-control-ws-abi
cc -std=c11 -O3 -I native/protocol-ffi/include tests/native/mask_benchmark.c target/release/libscreen_control_protocol_ffi.a -ldl -lpthread -lm -o /tmp/screen-control-ws-bench
/tmp/screen-control-ws-bench
cc -std=c11 -O3 -I native/protocol-ffi/include tests/native/tile_benchmark.c target/release/libscreen_control_protocol_ffi.a -ldl -lpthread -lm -o /tmp/screen-control-tile-bench
/tmp/screen-control-tile-bench
/tmp/screen-control-tile-bench rust-first
cc -std=c11 -O3 -I native/protocol-ffi/include tests/native/ximage_benchmark.c target/release/libscreen_control_protocol_ffi.a -ldl -lpthread -lm -o /tmp/screen-control-ximage-bench
/tmp/screen-control-ximage-bench
/tmp/screen-control-ximage-bench rust-first
cc -std=c11 -O3 -I native/protocol-ffi/include tests/native/checksum_benchmark.c target/release/libscreen_control_protocol_ffi.a -ldl -lpthread -lm -o /tmp/screen-control-checksum-bench
/tmp/screen-control-checksum-bench
/tmp/screen-control-checksum-bench rust-first
```

独立 ABI 命令只检查 C 调用端；`--sanitizers` 另对完整 Linux 代理的 C 代码插入 ASan/UBSan，并运行同一回环脚本。稳定工具链构建的 Rust 静态库没有 sanitizer 插桩；短时回环也不覆盖真实设备、所有脚本和平台采集。Rust 字节变换、tile 提取、XImage 转换和光标叠加由安全切片约束并有边界测试。tile 微基准在本机 256×256 RGB24、无编码/采集时六次交替顺序运行，Rust FFI 约 3.09–3.34 微秒、C `memcpy` 行循环约 3.66–3.89 微秒；1920×1080 BGRA 转 RGB24 的快速路径约 0.88–1.08 毫秒/帧，C 对照约 0.93–1.14 毫秒/帧。两者均不代表真实桌面帧率、网络延迟和长期资源测量。完整验证与发布条件见[核心合同](../../../../docs/modules/remote-desktop/native-safety.md)。

JPEG 编码在本机八次交替对照中，512×512 图像的候选中位数为 1548 微秒/帧、基线为 1594 微秒/帧；32×32 图像为 5.8 与 5.7 微秒/帧。JPEG 字节摘要一致，小 tile 没有可测的加速，较大 tile 的约 3% 改善仍需实机验证。2048×2048 图像产生 2,367,166 字节 JPEG，完成后释放了超过 1 MiB 的暂存容量。这些短测不代表真实桌面帧率或长期驻留内存。

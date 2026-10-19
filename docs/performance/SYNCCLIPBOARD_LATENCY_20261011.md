# 2026-10-11 echova 到 Windows 文本同步延迟修复

## 实际问题与测量

用户通过门户远控 echova，按 Ctrl+C 复制后，Windows 需要等待超过五秒才可粘贴。只读 `/SyncClipboard.json` 的毫秒级响应不能代表这条端到端链路。

对独立测试文本分别观察源机器系统剪贴板、中央服务当前文本和 Windows 系统剪贴板。跨机器时钟使用三次 SSH 往返中最短的一次估算偏差；该校准往返约 0.42～0.48 秒，另有源端约 100ms、服务端约 100ms、本机约 20ms 的采样误差。因此结果只按约数报告，不能将服务端与 Windows 的约 30ms 观测倒序解释为实际负延迟。

| 场景 | echova 系统剪贴板到 Windows |
|---|---:|
| 门户远控人工复制 D，修复前 | 约 8.9 秒 |
| 同一源端用 xclip 写入独立测试 E，修复前 | 约 6.7 秒 |
| 同样测试写入，调整读取来源后，三次 | 约 0.9、0.4、0.7 秒 |

人工复制 D 在源系统剪贴板出现后，客户端日志至 13:02:32 才记录变化，13:02:35 才进入上传。日志精度为一秒，时间与跨机探针应结合校准误差理解。主要等待在源端发现和读取、上传前处理，服务端发布至 Windows 不是本次数秒延迟的主要来源。后续三次自动测试验证相同文本传播路径，不冒充三次门户按键端到端测试。

## 已部署的局部修复

只调整 echova 既有 SyncClipboard 客户端的 `ClipboardFactory.ProhibitSources`，从空数组改为 `["Avalonia"]`，使用已安装的 xclip 读取 X11 剪贴板。保留当前二进制、同步账号、历史、保留规则、重试设置、服务器和控屏配置，仅重启该机器既有客户端。

固定 v3.1.5 的 `AppServices` 先注册 Avalonia，再注册 xclip；`MultiSourceClipboardReader` 顺序尝试来源，先前空排除数组会优先选择 Avalonia。同机 xclip 的 TARGETS、TIMESTAMP、UTF8_STRING 读取中位耗时约 1.6～1.7ms，而实测同步路径在调整前等待数秒，调整后三次降至约一秒以内。对照证明绕过 Avalonia 对本机有效；未继续定位 Avalonia 内部具体超时或调度缺陷。

此次没有减少一秒检测周期，没有更新 Windows DLL，没有修改系统代理，也没有开启 MeshCentral 剪贴板通道。当前改善不能归因于这些未执行的改动。

## 健康、测试与边界

- echova 既有客户端服务为 active，自动重启次数为零。
- 修改配置前保存原文件与可执行回滚脚本，备份目录为该用户 `$HOME/.local/state/screen-control/clipboard-reader-optimization-20261011-130407/`。
- 自动写入测试只有在源剪贴板仍为已知测试 D 时才执行；结束后只在内容仍为本次测试 E/F/G 时恢复 D，用户的新复制内容不会被强制覆盖。
- 在 nix 已安装的独立 Xvfb 中验证 xclip 的 UTF-8 文本、PNG 与 URI-list 字节往返，全部一致，没有向生产剪贴板写入图片或文件。
- 该隔离测试验证读取工具的格式传输，未运行完整图片解码、历史入库或跨设备图片/文件同步验收，也不等同 echova 当前桌面上的图片实际传播测试。
- 适用范围为已安装 xclip 的 echova X11 会话；其他设备、Wayland、xclip 失效后的退化行为未部署或验收。不要直接推广该排除数组到没有可用读取工具的机器。
- 远端项目已有 MeshCentral、metrics 和其他文档未提交改动，本次未部署或覆盖它们。

## 回滚

运行上述备份目录中的 `rollback.sh` 恢复原读取来源并重启 echova 既有客户端。脚本不覆盖历史数据库；回滚可能重新出现本次较慢的读取路径。

源码依据为保留规则锁文件中的 SyncClipboard v3.1.5 提交，参见 `src/SyncClipboard.Desktop/AppServices.cs`、`ClipboardAva/ClipboardReader/MultiSourceClipboardReader.cs`、`ClipboardAva/ClipboardListener.cs` 和 `src/SyncClipboard.Core/UserServices/SyncService/UploadService.cs`。既有通知与历史修复仍适用，见 [通知恢复说明](../../deploy/g0/suite/syncclipboard-latency/README.md)。

## 同日扩展：四台设备全部方向

用户进一步要求四台设备之间的所有同步提速。实际部署范围现扩展为 lerrem、echova、nix 和 Windows；以上 echova 单机记录是此前阶段的结果。

- 三台 Linux 当前均为 X11 `:1` 会话。echova 和 nix 已有 xclip，lerrem 补齐系统包 xclip 0.13-2，均设置 `ClipboardFactory.ProhibitSources=["Avalonia"]`。lerrem 重启既有用户服务，nix 重新启动既有桌面客户端，并保留现有自启动配置；未新增同步服务。
- Windows 既有客户端通过进程级 `NO_PROXY` 绕过当前同步服务器的系统 HTTP 代理，持久化到原有 HKCU Run 自启动入口的启动脚本。重启后实际 TCP 连接直达同步服务器。其他网络仍沿用原代理；未修改系统代理或整段私网的规则。失败后重试间隔从 3 秒调整为 1 秒。
- 本次未更新任何客户端 DLL，未改动中央服务器、历史数据库或 MeshCentral；Linux 本地检测周期仍为一秒。因此不能承诺每次同步都是毫秒级，也未将 Windows 的断线恢复行为宣称为与 Linux 已有补丁完全相同。

使用四台设备的实际系统剪贴板，分别由每台设备写入唯一短文本，另三台持续观察到达。两个完整轮次共 24 次目的端到达，12 个有向组合全部成功：

| 方向 | 第一次（秒） | 第二次（秒） |
|---|---:|---:|
| lerrem → echova | 0.682 | 0.912 |
| lerrem → nix | 0.691 | 0.969 |
| lerrem → Windows | 0.712 | 0.945 |
| echova → lerrem | 0.112 | 1.035 |
| echova → nix | 0.088 | 1.090 |
| echova → Windows | 0.118 | 1.081 |
| nix → lerrem | 0.697 | 0.524 |
| nix → echova | 0.707 | 0.525 |
| nix → Windows | 0.722 | 0.558 |
| Windows → lerrem | 0.186 | 0.178 |
| Windows → echova | 0.205 | 0.192 |
| Windows → nix | 0.213 | 0.206 |

Linux 观察周期 50ms，Windows 20ms。使用已经建立的 SSH 长连接进行五次时钟往返校准，最短往返分别约 23ms、25ms、44ms，较前一阶段每次新建 SSH 连接的时钟误差更小；数字仍包含采样与时钟估算误差，不代表严格上界。已完成的 24 次传播范围为约 0.088～1.090 秒。

第三轮额外完成 lerrem 到其余三台的同步，随后 echova 已出现非测试文本，探针按保护规则停止写入。随后只读哈希检查确认三台 Linux 当前剪贴板均与服务器的新文本一致，未将新内容改回测试 D。这是保护性停止，不记为同步失败或完整第三轮。

该矩阵验证短文本系统剪贴板传播，不包含网页 Ctrl+C 之前的远控键盘输入时间。图片与文件仍仅有此前隔离 Xvfb 的格式往返验证；大图片、文件传输速度取决于大小，尚未进行四设备全部方向验收。

### 配置持久化与回滚

Linux 配置保存在既有用户配置目录，备份位于 `$HOME/.local/state/screen-control/clipboard-reader-optimization-*`。echova、lerrem 的 `rollback.sh` 恢复配置并重启已有服务；nix 同目录提供 `rollback.sh` 与受保护的启动快照，恢复配置并重新启动原客户端。Windows 备份位于 `%APPDATA%/SyncClipboard/speed-backup-*`，`rollback.ps1` 恢复原配置及原有 Run 项并启动原客户端。Windows 启动脚本位于同一配置目录，服务器绕过规则只传给此客户端子进程。

# SyncClipboard 通知连接恢复与释放

固定使用 [保留规则锁文件](../syncclipboard-retention/toolchain.lock.json) 的 SyncClipboard 3.1.5 源码、SDK 和依赖。先应用 `retention.patch`，再应用本目录 `latency.patch`；禁止直接替换为未经验证的新版。

## 行为

- 通知连接在网络断开后按 0、1、2、5 秒间隔尝试自动重连。服务端主动关闭或自动重试耗尽后，由 2 秒健康检查继续恢复；每次检查设置 5 秒取消期限，异常不终止循环。
- 重连成功只补拉当前剪贴板，不重放断线期间的旧内容。旧连接异步完整释放；过期连接回调不能修改当前连接状态。健康检查不打断正在连接或重连的实例。
- `SyncService.IntervalTime=1` 缩短失败后的同步重试等待；正常官方服务仍使用事件通知，不靠一秒轮询同步。
- 保留现有 48 小时非收藏历史清理、GC 配置和内存保护。本改动不证明此前所有延迟都由内存配置导致，也不代替 MeshAgent 原生内存泄漏修复。

## 构建与验证

在项目根目录执行，路径参数由当前运维环境提供，不写入真实账号或私有配置：

```bash
git -C "$SCREEN_CONTROL_SYNC_SOURCE" apply --check "$PWD/deploy/g0/suite/syncclipboard-latency/latency.patch"
git -C "$SCREEN_CONTROL_SYNC_SOURCE" apply "$PWD/deploy/g0/suite/syncclipboard-latency/latency.patch"
"$SCREEN_CONTROL_DOTNET" build "$SCREEN_CONTROL_SYNC_SOURCE/src/SyncClipboard.Core/SyncClipboard.Core.csproj" -c Release -p:Platform=AnyCPU
"$SCREEN_CONTROL_DOTNET" build tests/operations/syncclipboard-latency/Latency.csproj -c Release -p:Platform=AnyCPU -p:SyncClipboardSourceRoot="$SCREEN_CONTROL_SYNC_SOURCE"
"$SCREEN_CONTROL_DOTNET" tests/operations/syncclipboard-latency/bin/Release/net8.0/Latency.dll
```

测试在回环地址的随机端口创建隔离 SignalR 服务，覆盖健康检查异常后恢复、串行执行、停止回调、服务端主动断开后的健康检查重连、通知恢复、重复监听、连续替换配置后只保留一个连接、停止和释放。不使用生产凭据，不写真实剪贴板。自动重连策略已配置，当前测试的服务端主动关闭场景验证的是健康检查兜底路径。

## Linux 部署和回滚

`deploy-linux.py --unit "$SCREEN_CONTROL_SYNC_UNIT" --install-dir "$SCREEN_CONTROL_SYNC_INSTALL" --dll "$SCREEN_CONTROL_SYNC_DLL" --probe tests/operations/syncclipboard-runtime/bin/Release/net8.0/Runtime.dll` 先验证候选程序集与实际安装依赖，再更新现有核心程序集及重试间隔。停止客户端后备份原 DLL、配置与历史数据，启动失败自动恢复代码和配置。显式添加 `--recent-first` 可将既有历史面板改为按最近复制／使用时间排序；其他设置保持不变。备份在当前用户 `.local/state/screen-control/clipboard-latency-*`，内有可执行 `rollback.sh`。不改历史数据库，不停止控屏服务。平台条件不同，禁止将 Linux DLL 用于 Windows。

首次添加 Linux 客户端：将现有已验证客户端发行包复制至用户 `.local/lib/syncclipboard/releases/` 下独立目录；通过受保护通道配置同一账号，仅复制账号、同步、历史及程序选项，不复制历史数据库和运行时状态。配置目录权限 700、配置文件 600。在当前图形登录用户下运行 `setup-user-client.py --release "$SCREEN_CONTROL_SYNC_RELEASE"`，然后 `systemctl --user daemon-reload`、`systemd-analyze --user verify ~/.config/systemd/user/syncclipboard-client.service`、`systemctl --user start syncclipboard-client.service`。客户端依赖当前图形会话，未登录桌面时不宣称能同步系统剪贴板。首次安装撤销时停止该用户服务并移除本次新增的 unit、自启动项和应用启动器，保留配置及历史以备恢复。

健康检查必须包括客户端单实例、鉴权 API、当前图形会话的系统剪贴板与服务端一致性，不能仅以进程存活作为同步成功。检查内容仅在进程内比较，不输出用户剪贴板或凭据。当前状态见 [部署记录](../../../../docs/performance/SYNCCLIPBOARD_LATENCY_20260928.md)。

## 部署前的图像验证

本次 Linux 发行包的托管图像依赖为 `Magick.NET-Q16-AnyCPU`，所以核心补丁使用 `Platform=AnyCPU`。依赖选择与主机 CPU 架构是两回事；仅替换核心 DLL 不能同时改变依赖名称。以下探针使用目标已安装应用宿主、依赖清单和原生库，在临时目录中验证合成 PNG 解码与重新编码，不读取真实剪贴板、账号或历史：

```bash
"$SCREEN_CONTROL_DOTNET" build tests/operations/syncclipboard-runtime/Runtime.csproj -c Release
python3 deploy/g0/suite/syncclipboard-latency/verify-runtime.py \
  --install-dir "$SCREEN_CONTROL_SYNC_INSTALL" --core "$SCREEN_CONTROL_SYNC_DLL" \
  --probe tests/operations/syncclipboard-runtime/bin/Release/net8.0/Runtime.dll
```

依赖解析或图像往返失败必须阻止部署。历史保留补丁还需通过重复复制旧记录的回归测试，见[保留规则](../syncclipboard-retention/README.md)。实际修复范围见[图片与历史修复记录](../../../../docs/performance/SYNCCLIPBOARD_IMAGE_HISTORY_REPAIR_20260928.md)。

还可在独立 Xvfb 中检查完整图片读取、缓存与历史入库链路。`SCREEN_CONTROL_XVFB` 指向已有测试用 Xvfb，不连接用户显示会话；探针用实际安装 DLL 编译，不启动 SyncClipboard 单实例、热键或同步服务。

```bash
"$SCREEN_CONTROL_DOTNET" build tests/operations/syncclipboard-runtime/Clipboard.csproj -c Release \
  -p:SyncClipboardInstallDir="$SCREEN_CONTROL_SYNC_INSTALL"
python3 tests/operations/syncclipboard-runtime/x11-history.py --xvfb "$SCREEN_CONTROL_XVFB" \
  --install-dir "$SCREEN_CONTROL_SYNC_INSTALL" --core "$SCREEN_CONTROL_SYNC_DLL" \
  --probe tests/operations/syncclipboard-runtime/bin/Release/net8.0/Clipboard.dll
```

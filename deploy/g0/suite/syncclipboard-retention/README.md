# SyncClipboard 48 小时保留规则

适用于已安装的 SyncClipboard 3.1.5。固定上游提交和 .NET SDK 见 `toolchain.lock.json`；不升级依赖、不新增服务。改动以补丁维护，不复制整套第三方源码。升级 SyncClipboard 前必须重新移植和验证补丁，直接覆盖安装会丢失该规则。

## 行为

- 服务端按 `CreateTime` 与 `LastAccessed`（UTC）中的较晚时间计算；严格超过 48 小时且未收藏的记录清除。重新复制或使用旧内容会刷新保留期，收藏等元数据更新本身不会延长保留期。置顶不等于收藏，不能豁免。现有数量上限仍生效，可能更早清理非收藏记录。
- 在现有 `HistoryCleaner` 内每分钟执行，单批最多 100 条、一次最多 10 批、批间等待 250 毫秒。正常负载下过期后约一分钟内清理，积压分批收敛；进程停止时不执行。
- 与 SQLite 收藏更新共用原有锁，在锁内筛选与写入删除标记，递增版本并更新修改时间。复用 SignalR 删除通知、附件清理与离线增量同步，不另建同步协议。收藏在服务端清理前已生效时受保护；离线设备尚未同步的收藏不能被服务端提前感知。
- 保留原有 30 天删除标记，以便离线客户端收敛；清除的是有效历史和附件，不宣称数据库文件立即缩小。仍作为“当前剪贴板”的内容由原有机制管理，不主动改写用户剪贴板。
- 客户端原有每分钟清理任务在启用历史同步时也处理 `LocalOnly` 记录，按 `Timestamp` 与 `LastAccessed` 的较晚时间和 `History.HistoryRetentionMinutes=2880` 判断，保护收藏但不豁免置顶，单批最多 100 条。已同步记录由服务端决定，客户端原有五分钟任务释放已删除历史附件。

## 构建和测试

从锁文件中的仓库取得精确提交，在干净的独立目录应用补丁。`SCREEN_CONTROL_SYNC_SOURCE`、`SCREEN_CONTROL_DOTNET` 是本次构建的路径参数；路径不得写成真实账号或生产凭据。

```bash
# 先核对 git rev-parse HEAD 与 dotnet --version，必须匹配 toolchain.lock.json。
git -C "$SCREEN_CONTROL_SYNC_SOURCE" apply --check "$PWD/deploy/g0/suite/syncclipboard-retention/retention.patch"
git -C "$SCREEN_CONTROL_SYNC_SOURCE" apply "$PWD/deploy/g0/suite/syncclipboard-retention/retention.patch"
"$SCREEN_CONTROL_DOTNET" build "$SCREEN_CONTROL_SYNC_SOURCE/src/SyncClipboard.Server.Core/SyncClipboard.Server.Core.csproj" -c Release
"$SCREEN_CONTROL_DOTNET" build "$SCREEN_CONTROL_SYNC_SOURCE/src/SyncClipboard.Core/SyncClipboard.Core.csproj" -c Release -p:Platform=AnyCPU
"$SCREEN_CONTROL_DOTNET" build "$SCREEN_CONTROL_SYNC_SOURCE/src/SyncClipboard.Core/SyncClipboard.Core.csproj" -c Release -p:Platform=x64 -r win-x64
"$SCREEN_CONTROL_DOTNET" run --project tests/operations/syncclipboard-retention/Retention.csproj -c Release -p:SyncClipboardSourceRoot="$SCREEN_CONTROL_SYNC_SOURCE"
"$SCREEN_CONTROL_DOTNET" build tests/operations/syncclipboard-retention/ClientRetention.csproj -c Release -p:Platform=AnyCPU -p:SyncClipboardSourceRoot="$SCREEN_CONTROL_SYNC_SOURCE"
# 必须使用新建隔离配置目录；测试只写合成数据。
retention_fixture=$(mktemp -d /tmp/screen-control-retention-XXXXXX)
XDG_CONFIG_HOME="$retention_fixture" "$SCREEN_CONTROL_DOTNET" tests/operations/syncclipboard-retention/bin/Release/net8.0/ClientRetention.dll
```

Linux 已安装发行包使用 `Magick.NET-Q16-AnyCPU`；只替换核心 DLL 时必须与目标依赖清单一致，不能因机器为 x64 就选择 `Platform=x64`。Windows 命令保持原平台条件，不能用于 Linux。客户端部署前必须执行[实际安装依赖验证](../syncclipboard-latency/README.md#部署前的图像验证)。

测试覆盖旧内容重新复制后的恢复及保留、严格 48 小时边界、收藏及其附件、置顶清除、其他用户隔离、删除版本与离线查询、收藏更新、幂等、100 条批次，以及开启同步时的本地独有记录清理。除测试外，还需用隔离配置启动已安装服务及新程序集，确认定时任务和原有依赖兼容。

## 部署与回滚

先停止对应进程，备份原 DLL、配置、数据库及历史附件。备份目录限制为当前用户访问。服务端仅替换 `SyncClipboard.Server.Core.dll`，在既有 `syncclipboard.service.d/60-retention.conf` 中安装 `48-hours.conf`，重新加载并启动。客户端仅替换对应平台的 `SyncClipboard.Core.dll`，将现有 JSON 的 `History.HistoryRetentionMinutes` 设置为 2880；保留账号、收藏、历史同步开关及其他所有字段。不要用 Linux 编译条件生成的程序集替换 Windows 版本。Windows 必须在原用户交互会话恢复单实例，不新增永久任务。

部署后检查三端进程、鉴权 API、客户端本地数据库中的有效过期记录数、服务端收藏数、清理收敛和进程内存。配置为 0 只关闭服务端时间清理，不关闭既有数量清理；客户端 0 表示关闭本地时间清理。

代码回滚恢复原程序集与配置，并移除服务端此次覆盖。**代码回滚不会自动恢复已同步删除的历史。** 数据备份用于人工协调恢复；不能直接把旧数据库覆盖回在线同步系统，否则旧版本可能再次被删除标记覆盖。恢复数据须协调客户端暂停、版本冲突与附件恢复，不能把“有备份”解释为自动跨端撤销。

本次部署记录见 [保留规则验收](../../../../docs/performance/SYNCCLIPBOARD_RETENTION.md)。

2026-09-28 图片依赖与重复复制误清理修复见[本次部署验证](../../../../docs/performance/SYNCCLIPBOARD_IMAGE_HISTORY_REPAIR_20260928.md)。此前按首次创建时间清理的结果仅适用于原补丁。

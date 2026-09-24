# Screen Control 统一套件

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

该套件将生产门户静态文件和 Go G0 桥接放在同一个 `screen-control` 进程中，并继续把 SyncClipboard 作为受管理的独立侧车进程。门户在 `:8444` 直接接受 Tailscale HTTPS 连接，以便从真实套接字对端自动识别当前设备；Tailscale Serve 继续提供兼容跳转和剪贴板入口：

- `${SCREEN_CONTROL_CANONICAL_ORIGIN}/`：当前直接 Tailscale 门户、API 和 WebSocket，按稳定节点身份自动识别设备；Tailscale 私有网络启用证书后自动改为 HTTPS；
- `https://${SCREEN_CONTROL_ECHOVA_HOSTNAME}/`：兼容入口，只把浏览器导航重定向到 `:8444`；
- `${SCREEN_CONTROL_CLIPBOARD_URL}/`：SyncClipboard。

在 echova 上依次运行：

```bash
./deploy/g0/suite/install.sh
./deploy/g0/suite/configure-tailscale.sh
```

安装使用版本化目录和原子 `current` 软链接，不覆盖旧版本；用户服务在 `127.0.0.1:8790` 保留健康检查与兼容入口，并在 echova 的 Tailscale IPv4 `:8444` 直接终止 TLS。配置脚本从本机 Tailscale 状态生成原三台电脑及 xiaomi-15 手机的稳定节点映射；设置 `SCREEN_CONTROL_LERREM_DNS_NAME` 后同时登记第四台电脑 `lerrem`，写入权限为 `0600` 的 `%h/.config/screen-control/tailscale.env`。Tailscale 配置前会备份，任一步失败会自动恢复。

若 Tailscale 私有网络尚未启用 HTTPS 证书，直接入口的证书获取会失败；配置脚本会恢复原 Tailscale Serve 配置并保留 HTTP 回退入口。管理员启用 HTTPS 后重新运行脚本，它会同时验证门户健康检查、自动识别结果和剪贴板入口，再关闭 HTTP 回退。

另外两台设备只需迁移一次 SyncClipboard 地址。Linux 运行 `migrate-syncclipboard-linux.sh`，Windows 运行 `migrate-syncclipboard-windows.ps1`，然后重启 SyncClipboard。迁移脚本会先备份原配置；确认三台设备都已使用 Tailscale 地址前，不要关闭现有 cpolar。

远程桌面协议自身的剪贴板读写继续关闭，以免与 SyncClipboard 形成复制回环。门户中的“剪贴板 · 独立同步”表示 SyncClipboard 通道，而不是浏览器远控通道。

### 门户实时运行状态

设备工作台保留连接状态和实时指标，不再显示每台设备下方的“连接详情”折叠区域。当前设备隐藏“打开桌面”和“文件”快捷按钮，其他设备保留这两个入口。

设备工作台仅在页面可见时轮询状态。桥接将新鲜设备状态与展示指标分离：会话创建不采集指标，页面快照触发最多每 5 秒一次的共享后台采样，通过 MeshCentral `msg/cpuinfo` 请求 CPU 使用率与可用内存，Linux 内存单位为 KiB、Windows 为字节。显示已用量为总量减去系统可用量。GPU 通过固定的只读采集命令读取：NVIDIA 使用 `nvidia-smi`；Linux AMD 使用 DRM sysfs 的 `gpu_busy_percent` 与专用显存字段。当前不支持的驱动或不可达设备显示缺失状态，不以零值代替。

套件读取 `~/.config/screen-control/metrics.env`：

```ini
SCREEN_CONTROL_METRICS_LOCAL_DEVICE=echova
SCREEN_CONTROL_METRICS_SSH_TARGETS=jiang-chenx=${SCREEN_CONTROL_WINDOWS_SSH_TARGET},nix=nix@nix.your-tailnet.ts.net
```

SSH 使用已有服务用户密钥、严格主机密钥校验与非交互模式；目标仅由服务端配置决定，HTTP 不接受命令或目标地址。页面隐藏时停止轮询并取消未完成页面请求，恢复可见时立即刷新。已启动的共享采样使用独立 3 秒截止时间，子进程退出管道额外等待最多 250 ms，不因单页退出影响其他页面；不会启动永久采样循环。首次快照可暂缺指标，下次刷新取得采样结果。桥接缓存最多保留 15 秒，且按节点标识匹配；页面在断连或样本超过 15 秒后停止显示旧数值。此功能不再读取硬件型号清单，也不需要额外的 DeviceDetails 权限。

### 普通用户文件通道

安装器同时安装本机文件进程；另外两台电脑按 [文件进程部署说明](../files/README.md) 安装。提供 `SCREEN_CONTROL_FILE_SSH_TARGETS` 时，安装器将其写入独立的 `files.env`（0600）；未提供时保留现有文件。缺少普通用户配置会拒绝文件连接，不回退到 root/SYSTEM 代理。

### 收藏存储与升级

共享收藏由门户桥接进程持久化到 `~/.local/state/screen-control/favorites/folders.json`（可配置，见[配置指南](../../../docs/CONFIGURATION.md)）。该目录必须在服务启动前创建为 `0700`；服务通过精确的 `ReadWritePaths` 放行此目录，其他用户目录继续只读。私网与网关共用存储，升级时不得复制空文件覆盖已有收藏。

本次能力涉及桥接二进制和门户静态资源，需一起发布并重启既有 `screen-control-suite` 服务；重启会结束正在使用的桌面和文件会话。发布前备份当前版本链接、服务文件和已有收藏目录。健康检查除 `/api/v1/health` 与静态资源外，还须从可信入口读取收藏 API；用隔离测试数据验证跨入口更新并清理本次测试项。失败时恢复旧版本链接和服务文件、执行 `daemon-reload` 和服务重启，保留收藏数据用于再次升级。

### 内存预算

门户使用 Go 128 MiB 软预算，服务组高水位 192 MiB、硬上限 256 MiB、Swap 上限 64 MiB；同时最多 16 个桌面/文件会话（包含建连中）。内存超限可能导致服务组重启，桌面与文件操作的未确认结果仍视为未知。预算不包含独立 MeshCentral、SyncClipboard 或远端文件进程。浏览器图块采用有界解码与显式释放，部署、测量和回滚见[内存评估](../../../docs/performance/MEMORY.md)。

### SyncClipboard 内存配置

先确认已安装主程序路径、现有服务和运行版本，禁止把桌面程序误加入门户服务组。以下配置针对当前 .NET 8 / SyncClipboard 3.1.5，升级后需要复核并重新应用，不能自动覆盖未知版本。

```bash
# 路径从本机实际安装位置取得，不把私有账号和路径写入仓库。
python3 deploy/g0/suite/configure-syncclipboard-memory.py server "${SCREEN_CONTROL_SYNC_SERVER_RUNTIMECONFIG}"
sudo python3 deploy/g0/suite/configure-syncclipboard-memory.py desktop "${SCREEN_CONTROL_SYNC_DESKTOP_RUNTIMECONFIG}"
```

上述两个 `SCREEN_CONTROL_*` 变量仅是运维命令的显式文件路径参数，不由应用读取；可通过既有 `ops/with-env` 加载。工具会保存同目录原始备份。把 `syncclipboard-server-memory.conf` 安装为既有 `syncclipboard.service.d/50-memory.conf`，把 `syncclipboard-desktop-memory.conf` 安装为既有 `app-xyz.jericx.desktop.syncclipboard@autostart.service.d/50-memory.conf`；目录位于用户 systemd 配置目录。已有同名覆盖时先比较、备份，不直接覆盖。不得对包含浏览器或其他程序的混合 cgroup 限内存。

停止旧桌面实例后，`systemctl --user daemon-reload` 并重启对应的已有单元，确认单实例、GC 配置、cgroup 和内存属性。此流程不安装新的服务。未由 XDG 生成该客户端单元、没有图形会话或不是该版本时，先完成环境核对，不直接执行。服务端/客户端分别保留 256/384 MiB 托管堆；进程组分别最多 512/768 MiB，为本机图像库等保留余量。内存不足可能中断同步，不能视为成功。

健康检查应包含已有鉴权的 `/api/version`、`/SyncClipboard.json`、`POST /api/history/query` 和 SignalR 协商，凭据仅在内存读取，禁止输出到命令、日志或 URL。只读查询不能代替跨设备图片/文件写入同步验收。不要为了测试清空或降低既有历史数量。回滚恢复工具保存的原 runtimeconfig，移除本次内存覆盖、重新加载并重启；账号、历史库和同步内容不参与本次修改。实测与限制见[内存评估](../../../docs/performance/MEMORY.md#syncclipboard-附加优化)。

Windows 已安装客户端可使用 `configure-syncclipboard-memory-windows.ps1 -RuntimeConfig <主程序.runtimeconfig.json>` 设置同样的 384 MiB 托管堆预算；`-WhatIf` 可只检查拟执行操作。工具保留原文件备份与 ACL，必须重启实际图形会话中的客户端才能生效。Windows 实测为 .NET 9，尚未提供等同 Linux cgroup 的全进程硬上限；不要把托管堆限额写成整进程限额。当前 Windows 状态和回滚见[内存报告](../../../docs/performance/MEMORY.md#windows-在线状态纠正与补充部署)。

Linux 客户端覆盖还设置 glibc 原生分配参数：`MALLOC_ARENA_MAX=2`，`MALLOC_TRIM_THRESHOLD_` 与 `MALLOC_MMAP_THRESHOLD_` 均为 131072 字节。它们仅影响客户端进程，不适用于 Windows；不通过清理历史或缩小托管堆实现下降。两机对照结果、CPU 检查和二次优化独立回滚见[二次优化记录](../../../docs/performance/MEMORY.md#syncclipboard-客户端原生内存二次优化)。

### SyncClipboard 历史保留

用户要求的“非收藏超过 48 小时清除”由现有服务端和客户端清理任务执行，收藏保留，置顶未收藏不豁免。原有数量限制继续生效，离线设备重新同步后收敛。此能力依赖 SyncClipboard 3.1.5 的小范围源码补丁，不能仅改原版客户端的保留时间；固定工具链、测试、部署与回滚见[保留规则部署](syncclipboard-retention/README.md)，实机结果见[验收记录](../../../docs/performance/SYNCCLIPBOARD_RETENTION.md)。

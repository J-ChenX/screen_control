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

安装使用版本化目录和原子 `current` 软链接，不覆盖旧版本；用户服务在 `127.0.0.1:8790` 保留健康检查与兼容入口，并在 echova 的 Tailscale IPv4 `:8444` 直接终止 TLS。配置脚本从本机 Tailscale 状态生成三台电脑及 xiaomi-15 手机的稳定节点映射，写入权限为 `0600` 的 `%h/.config/screen-control/tailscale.env`。Tailscale 配置前会备份，任一步失败会自动恢复。

若 Tailscale 私有网络尚未启用 HTTPS 证书，直接入口的证书获取会失败；配置脚本会恢复原 Tailscale Serve 配置并保留 HTTP 回退入口。管理员启用 HTTPS 后重新运行脚本，它会同时验证门户健康检查、自动识别结果和剪贴板入口，再关闭 HTTP 回退。

另外两台设备只需迁移一次 SyncClipboard 地址。Linux 运行 `migrate-syncclipboard-linux.sh`，Windows 运行 `migrate-syncclipboard-windows.ps1`，然后重启 SyncClipboard。迁移脚本会先备份原配置；确认三台设备都已使用 Tailscale 地址前，不要关闭现有 cpolar。

远程桌面协议自身的剪贴板读写继续关闭，以免与 SyncClipboard 形成复制回环。门户中的“剪贴板 · 独立同步”表示 SyncClipboard 通道，而不是浏览器远控通道。

### 门户实时运行状态

设备工作台仅在页面可见时每 5 秒通过 MeshCentral `msg/cpuinfo` 请求 CPU 使用率与可用内存，Linux 内存单位为 KiB、Windows 为字节。显示已用量为总量减去系统可用量。GPU 通过固定的只读采集命令读取：NVIDIA 使用 `nvidia-smi`；Linux AMD 使用 DRM sysfs 的 `gpu_busy_percent` 与专用显存字段。当前不支持的驱动或不可达设备显示缺失状态，不以零值代替。

套件读取 `~/.config/screen-control/metrics.env`：

```ini
SCREEN_CONTROL_METRICS_LOCAL_DEVICE=echova
SCREEN_CONTROL_METRICS_SSH_TARGETS=jiang-chenx=${SCREEN_CONTROL_WINDOWS_SSH_TARGET},nix=nix@nix.your-tailnet.ts.net
```

SSH 使用已有服务用户密钥、严格主机密钥校验与非交互模式；目标仅由服务端配置决定，HTTP 不接受命令或目标地址。页面隐藏时停止轮询并取消未完成请求，恢复可见时立即刷新；单轮采集最多 3 秒；页面在断连或样本超过 15 秒后停止显示旧数值。此功能不再读取硬件型号清单，也不需要额外的 DeviceDetails 权限。

### 普通用户文件通道

安装器同时安装本机文件进程；另外两台电脑按 [文件进程部署说明](../files/README.md) 安装。提供 `SCREEN_CONTROL_FILE_SSH_TARGETS` 时，安装器将其写入独立的 `files.env`（0600）；未提供时保留现有文件。缺少普通用户配置会拒绝文件连接，不回退到 root/SYSTEM 代理。

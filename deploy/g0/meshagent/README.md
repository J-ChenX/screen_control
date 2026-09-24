# G0 MeshAgent 部署

这些文件用于安装固定版本的 G0 代理，并通过进程树出站控制限制网络访问。它们是验证资源，并非生产代理安装包。

安装前请配置 `SCREEN_CONTROL_MESH_HOST`、`SCREEN_CONTROL_MESH_BIND_IP` 和 `SCREEN_CONTROL_REGISTERED_IPS`。Linux 读取私有文件 `/etc/screen-control/meshagent.env`；Windows 安装程序会为 SYSTEM 任务持久化这些网络设置。`validate`/`Validate` 模式仅检查配置，不修改网络规则。详见[环境配置](../../../docs/CONFIGURATION.md)。

在 Linux 上，`screen-control-meshagent.service` 仅在二进制哈希、固定的 `/etc/hosts` 映射、Tailscale 接口、cgroup 以及 IPv4/IPv6 规则均通过验证后才启动代理。作用于该 cgroup 的规则链仅允许配置中三个或四个已登记的 Tailscale 私有网络 IPv4 地址，拒绝所有其他目标。对于运行在 `echova` 上的代理，还允许经回环接口访问本机服务器地址。停止服务时仅移除专用规则链及其跳转规则。

每次首次部署前，必须先启用独立的 root 回滚定时器，用于停止并禁用服务、移除其专用规则。只有在 SSH 救援通道、规则状态、进程 cgroup、活动套接字和控制面连接全部验证通过后，才能取消该定时器。

Windows 使用相同的失败即拒绝流程：预先阻断固定安装路径，安装并停止服务，创建精确匹配服务 SID、地址和适配器的规则以及哈希看门狗，再解除预先阻断并启动服务。Mesh 代理服务保持手动启动；SYSTEM 启动任务在每次开机后，先根据当前适配器重建规则，再启动服务。看门狗每两秒复核固定的二进制哈希、主机映射、Tailscale 路由、绑定服务的规则及活动的非 Tailscale 适配器，发现偏离即停止代理。若 Windows hosts 文件为空，在添加或移除本项目映射前，会先补入两条标准 localhost 记录。

Linux 服务对代理及采集子进程统一设置 768 MiB 硬上限和 128 MiB Swap 上限；禁用高水位节流，避免同步符号解析子进程被节流后让主进程无限等待。触及硬上限且无法回收时终止整个服务组并由既有策略重启，可能短暂中断控屏。停止时等待 15 秒后向整个服务组发送 SIGKILL；内核不可中断等待仍可能延迟退出。5 分钟内最多允许 3 次启动（包含首次启动），超过后保持失败，排查后通过 `systemctl reset-failed screen-control-meshagent.service` 和 `systemctl start screen-control-meshagent.service` 恢复。它是防止第三方代理拖垮主机的保护，不是泄漏根因修复。预算、实测范围、现有部署的回滚入口见[内存评估](../../../docs/performance/MEMORY.md)。Windows 未自动套用 Linux 限制。

## 既有 Linux 部署的卡死修复

已使用上述 768 MiB / 128 MiB 硬预算及 `OOMPolicy=kill` 的活动代理，可执行：

```bash
sudo bash deploy/g0/meshagent/linux/configure-stall-recovery.sh
```

工具先核对当前预算，备份同名覆盖并生成 root 专用回滚脚本，再安装 `60-stall-recovery.conf`，执行 `daemon-reload` 并核对内核实际限制。失败自动回滚；成功输出回滚入口。它不重启代理，不修改 `50-memory.conf`、固定工件或网络规则，适用于现有会话期间热更新。预算不匹配或代理不活动时拒绝更新，应先核查实际配置。首次安装直接使用完整 service 文件。

回归命令：

```bash
mise exec -- python3 -m unittest discover -s tests/operations -p 'test_meshagent_g0.py'
sudo env SCREEN_CONTROL_STALL_SYSTEM_TEST=1 python3 tests/operations/test_meshagent_stall.py -v
```

第二条显式创建临时隔离 systemd 单元，使用 64 MiB 硬上限、禁用 Swap，验证管道等待解除、OOM 整组退出后恢复、停止升级和启动限流；不会向真实代理注入故障。完整现场、部署和未验证范围见[卡死记录](../../../docs/performance/MESHAGENT_STALL_20260923.md)。

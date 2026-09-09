# G0 MeshAgent 部署

这些文件用于安装固定版本的 G0 代理，并通过进程树出站控制限制网络访问。它们是验证资源，并非生产代理安装包。

安装前请配置 `SCREEN_CONTROL_MESH_HOST`、`SCREEN_CONTROL_MESH_BIND_IP` 和 `SCREEN_CONTROL_REGISTERED_IPS`。Linux 读取私有文件 `/etc/screen-control/meshagent.env`；Windows 安装程序会为 SYSTEM 任务持久化这些网络设置。`validate`/`Validate` 模式仅检查配置，不修改网络规则。详见[环境配置](../../../docs/CONFIGURATION.md)。

在 Linux 上，`screen-control-meshagent.service` 仅在二进制哈希、固定的 `/etc/hosts` 映射、Tailscale 接口、cgroup 以及 IPv4/IPv6 规则均通过验证后才启动代理。作用于该 cgroup 的规则链仅允许三个已登记的 Tailscale 私有网络 IPv4 地址，拒绝所有其他目标。对于运行在 `echova` 上的代理，还允许经回环接口访问本机服务器地址。停止服务时仅移除专用规则链及其跳转规则。

每次首次部署前，必须先启用独立的 root 回滚定时器，用于停止并禁用服务、移除其专用规则。只有在 SSH 救援通道、规则状态、进程 cgroup、活动套接字和控制面连接全部验证通过后，才能取消该定时器。

Windows 使用相同的失败即拒绝流程：预先阻断固定安装路径，安装并停止服务，创建精确匹配服务 SID、地址和适配器的规则以及哈希看门狗，再解除预先阻断并启动服务。Mesh 代理服务保持手动启动；SYSTEM 启动任务在每次开机后，先根据当前适配器重建规则，再启动服务。看门狗每两秒复核固定的二进制哈希、主机映射、Tailscale 路由、绑定服务的规则及活动的非 Tailscale 适配器，发现偏离即停止代理。若 Windows hosts 文件为空，在添加或移除本项目映射前，会先补入两条标准 localhost 记录。

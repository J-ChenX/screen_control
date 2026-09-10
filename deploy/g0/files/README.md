# G0 普通用户文件通道

文件页保留现有会话 API 和协议 5 消息，但由目标普通用户的 `screen-control-files` 进程处理，不再把文件操作交给 root/SYSTEM MeshAgent。进程只读写 SSH 标准流，不监听端口、不接受任意命令、不调用 sudo/chown；压缩仅调用固定系统 tar。桌面仍使用原 MeshAgent。

## 构建与安装

使用锁定工具链：

```bash
make build
# 从 Linux 为 Windows 构建独立的文件进程，不新增依赖。
mise exec -- env CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o bin/screen-control-files.exe ./cmd/screen-control-files
```

将对应二进制和安装脚本复制到目标用户的隔离目录，以该用户执行：

```bash
bash install.sh /path/to/screen-control-files
```

Windows 使用当前 SSH 登录账号运行 `install.ps1 -Binary C:\path\screen-control-files.exe`。Windows PowerShell 5.1 使用带 BOM 的 UTF-8 脚本；若现有执行策略阻止部署脚本，可仅为该次部署进程使用 `-ExecutionPolicy Bypass`，不修改系统执行策略。

安装目录统一为用户主目录下 `.local/lib/screen-control-files/`，`current` 指向版本目录。Linux 使用原子软链接切换，Windows 使用目录联接；更新不会替换正在运行的旧二进制。每个版本的 `previous` 保存上一目标，回滚只需重新指向该目录；没有旧版本时可以撤销本次 `current`。保留旧目录，勿删除运行中的版本。

## 门户配置

在根 `.env` 设置 `SCREEN_CONTROL_FILE_SSH_TARGETS`；开发入口直接读取它。服务部署使用权限为 `0600` 的 `~/.config/screen-control/files.env`：

```ini
SCREEN_CONTROL_FILE_SSH_TARGETS=echova=operator@100.64.0.20,nix=operator@100.64.0.10,jiang-chenx=operator@100.64.0.30
```

设备 ID 与 SSH 用户名独立。只能配置已登记电脑，拒绝 root、重复设备及命令拼接字符。账号必须是希望拥有接收文件的目标普通用户。SSH 使用现有密钥、`BatchMode=yes`、严格主机密钥检查和固定文件进程路径。文件名、目录及正文仅通过带长度的标准流帧传输，不参与 shell 命令构造。缺少配置、主机密钥不受信任、进程未安装或报告高权限身份时拒绝建立文件通道，绝不回退到 Mesh 文件代理。

门户宿主也经 SSH 以自己的普通用户连接，避免继承门户 systemd 的只读主目录挂载。若尚无本机 SSH 授权，应从本机 `/etc/ssh/ssh_host_ed25519_key.pub` 核验服务器公钥；本机文件专用授权使用 `restrict,from="<本机 Tailscale IP>",command="<固定文件进程路径>"`，不授予终端、代理或端口转发。不要用关闭主机密钥检查的方式接入。

## 文件行为与验证

- Linux 新文件由目标用户创建，权限 `0600`；新目录 `0700`。Windows 文件继承目标目录 ACL，由 SSH 登录用户创建，禁止 SYSTEM/服务账号运行。
- 上传先写入同目录临时文件；检查完整长度、同步文件并再次核对原目标后才替换。覆盖已有文件要求当前用户拥有写权限；Linux 保留权限模式位，Windows 新文件继承目录 ACL（不复制原文件的自定义 ACL）；不允许覆盖链接或特殊文件。失败和正常断线清理临时文件，已有文件保留。进程被强制杀死可能留下仅目标用户可访问的临时文件，不会预先截断原文件。
- 同名覆盖和删除继续使用现有界面确认。目录、符号链接、共享目录和 ACL 仍由目标操作系统按当前用户裁决，没有属主修复或提权接口。已有 root 文件若不可写会明确失败，不自动接管历史文件。
- 单文件仍限 512 MB，无断点续传、网络重放或生产端点直传。本修复不代表生产文件数据面或 G0/G3 全部门通过。

测试入口：`mise exec -- go test ./internal/g0files ./internal/g0bridge`、对应竞态检查、前端测试和 `tests/browser/files.mjs`。实际部署还需在每台设备的隔离目录检查新建、覆盖、多选拉取的内容哈希及目标用户读写权限，并验证只读目标失败时内容不变。文件进程应拒绝以 root/SYSTEM 启动。

文件列表支持名称、修改时间、大小排序及升降序，目录保持优先。Ctrl/⌘ 多选后右键“压缩选中项（当前设备）”，调用设备自带系统 tar 生成 `.tar.gz`，仅保存在当前设备当前目录，不触发跨设备复制。支持普通文件和文件夹，拒绝符号链接、特殊文件、同名输出及目录越界；输入总大小上限 512 MB、执行最长 2 分钟。失败不发布目标包，成功以 `compressed/reqid/name` 确认；断线后结果未确认须检查目录，不自动重试。请求为 `compress/reqid/path/name/names`，后端独立校验且不接受工具路径、命令或跨设备目标。

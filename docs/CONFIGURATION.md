# 私有环境配置

真实域名、IP、SSH 用户和个人路径放在根目录 `.env`，公开仓库只保留 `.env.example`。密码、访问密钥仍保存在仓库外的受保护文件中，环境只配置路径。不要使用 `VITE_*` 保存凭据。

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env 中的示例地址，按当前设备填写
make dev
```

本次迁移已为当前工作目录保存原配置为 `.env`，无需覆盖它。迁移前的源码备份在已忽略的 `evidence/env-migration-backup/`。

## 加载与优先级

`make dev`、`make preview`、`make install-suite`、`make configure-tailscale`、`make mesh-config` 使用 `ops/with-env`。直接执行其他命令时：

```bash
./ops/with-env mise exec -- go run ./cmd/screen-control --serve
./ops/with-env ./ops/bootstrap/preflight collect --nodes all
./ops/with-env ./deploy/g0/suite/migrate-syncclipboard-linux.sh
```

优先级为已导出的环境变量 > 环境文件 > 程序的非敏感默认值。可用 `SCREEN_CONTROL_ENV_FILE=/absolute/path/private.env` 选择另一个文件；显式文件缺失会报错，不会悄悄使用其他配置。

环境格式为 `SCREEN_CONTROL_NAME=value`，空行和独立注释行可用；含空格的值加单引号或双引号。不支持 `export`、行尾注释、变量展开、命令替换和多行值，路径写绝对路径，不写 `$HOME` 或 `~`。Windows 反斜杠按字面保留。不要把此文件当 shell 脚本 source。

Vite 的服务端配置使用相同字面值规则读取根目录 `.env` 或显式文件，不把配置对象注入浏览器记录包。没有配置开发入口时使用本机入口，不启用规范地址重定向；配置后只允许精确的入口主机名。

## 配置分组

| 环境变量 | 用途 |
|---|---|
| `SCREEN_CONTROL_MESH_URL` | 后端 MeshCentral HTTPS 地址；启动服务时必填 |
| `SCREEN_CONTROL_MESH_USER` / `SCREEN_CONTROL_MESH_FILE_USER` | 桌面、文件两个服务账号 |
| `SCREEN_CONTROL_MESH_PASSWORD_FILE` / `SCREEN_CONTROL_MESH_FILE_PASSWORD_FILE` | 密码文件路径；不填时按 `XDG_STATE_HOME` 或当前用户 home 推导 |
| `SCREEN_CONTROL_ALLOWED_ORIGINS` | 后端精确源站白名单，逗号分隔；不要填 `*` |
| `SCREEN_CONTROL_DEV_ORIGIN` / `SCREEN_CONTROL_PREVIEW_ORIGIN` | 开发、预览的浏览器入口 |
| `SCREEN_CONTROL_MESH_HOST` / `SCREEN_CONTROL_MESH_BIND_IP` | MeshCentral DNS 名称、监听 Tailscale IPv4 |
| `SCREEN_CONTROL_REGISTERED_IPS` | 三台电脑的精确 Tailscale IPv4，逗号分隔；必须包含监听地址，不接受 CIDR、重复项或其他网段 |
| `SCREEN_CONTROL_MESH_PORTAL_ORIGIN` | MeshCentral 允许嵌入的精确 HTTPS 源站 |
| `SCREEN_CONTROL_NIX_*` / `SCREEN_CONTROL_ECHOVA_*` / `SCREEN_CONTROL_WINDOWS_*` | 运维节点地址、真实系统主机名、Tailscale DNS_NAME（首段名称）和 SSH 目标，字段见示例 |
| `SCREEN_CONTROL_PHONE_HOSTNAME` / `SCREEN_CONTROL_PHONE_IP` | 手机登记身份的解析与地址核对 |
| `SCREEN_CONTROL_TAILSCALE_IP` | 开发监听地址；未设置时通过本机 `tailscale ip -4` 获取 |
| `SCREEN_CONTROL_CLIPBOARD_URL` | 剪贴板迁移目标；缺失时不修改客户端配置 |
| `SCREEN_CONTROL_PROJECT_ROOT` | 系统级 MeshCentral 服务的项目绝对路径 |

已有 `echova`、`nix`、`jiang-chenx`、`xiaomi-15` 保留为应用协议/登记 ID，本次没有更换这些 ID。系统主机名与 Tailscale DNS_NAME 分别由环境配置（Windows 两者常不相同），MeshCentral 当前仍通过既有设备名称映射这三个电脑 ID；不要仅在环境中修改设备 ID。它们仍可关联个人身份，若希望完全匿名开源，需要单独迁移 ID 和历史记录。

## MeshCentral 与系统服务

```bash
make mesh-config
./ops/with-env python3 deploy/spike/meshcentral/verify.py --private
```

这会根据公开 `config.example.json` 和环境生成已忽略的 `config.json`（0600），不会启动服务。默认 `verify.py` 只校验公开示例；`--private` 校验实际生成配置是否与环境一致。Compose 不会自动为缺失的 `config.json` 创建目录；必须先生成配置。运行容器的 `node` 用户需要有读取该文件的权限，部署时核对 UID/所有者，勿为解决权限问题公开秘密目录。

统一套件安装器将后端配置写入 `~/.config/screen-control/screen-control.env`（0600），user service 从该文件加载；安装器在启动之前要求 `SCREEN_CONTROL_MESH_URL` 已配置。Tailscale 配置脚本单独生成 `tailscale.env`，覆盖对应的直接入口及身份配置。独立记录包安装时需先导出变量；系统服务不会继承交互式 shell 的环境。

系统级 MeshCentral 服务从 `/etc/screen-control/meshcentral.env` 读取：

```ini
SCREEN_CONTROL_PROJECT_ROOT=/srv/screen-control
```

Linux MeshAgent 从 `/etc/screen-control/meshagent.env` 读取下列三项。手动运行防火墙脚本也需传入这些环境变量；`remove` 不依赖配置，保持回滚可用。

```ini
SCREEN_CONTROL_MESH_HOST=desktop.example.ts.net
SCREEN_CONTROL_MESH_BIND_IP=100.64.0.20
SCREEN_CONTROL_REGISTERED_IPS=100.64.0.10,100.64.0.20,100.64.0.30
```

先执行脚本的 `validate` 模式可离线验证配置，不操作防火墙。系统环境文件应由管理员持有，权限 0600。

Windows 安装前在管理员 PowerShell 设置相同三项：

```powershell
$env:SCREEN_CONTROL_MESH_HOST = 'desktop.example.ts.net'
$env:SCREEN_CONTROL_MESH_BIND_IP = '100.64.0.20'
$env:SCREEN_CONTROL_REGISTERED_IPS = '100.64.0.10,100.64.0.20,100.64.0.30'
.\meshagent-guard.ps1 -Mode Validate
```

`deploy.ps1` 校验后将这三项持久化为机器环境变量，供 SYSTEM 开机任务读取；不能只依赖安装终端的临时环境。安装器路径使用固定 ProgramData 目录，不再绑定个人用户目录。IPv4 拒绝区间从白名单计算，仍阻止白名单外全部 IPv4 与全部 IPv6；Rollback 不依赖配置。

## Git 历史与上传检查

`.gitignore` 排除了环境、生成配置、秘密、数据库、备份、抓包及构建输出，并明确保留公开模板和签名验证公钥。忽略规则不影响已跟踪文件或旧提交。

2026-09-09 已重写现有 8 次提交，对私有部署地址、SSH 用户和个人路径进行脱敏，并将作者和提交者统一为 `Nix Jiang <jiang.cxin@gmail.com>`。旧本地检查点引用与 reflog 已清除，原始 Git 数据和工作文件备份保存在仓库外。不要将原始备份复制进公开仓库，也不要从旧副本重新合并未经脱敏的历史。

提交和推送前应检查最终文件清单。指定作者邮箱将随 Git 历史公开；本地仓库已设置相同的后续提交身份。公开项目采用根目录 `LICENSE` 中的 MIT 协议。

历史重写会改变提交 ID。文档中的旧提交号、旧封存证据和旧签名仅对应原始备份中的版本；更新校验和不代表重新完成实机验证，也不能把旧签名证据作为新版本的验收证明。扫描结论仅适用于本次检查的内容，后续新增文件和提交需要重新检查。

## 普通用户文件通道

`SCREEN_CONTROL_FILE_SSH_TARGETS` 是逗号分隔的 `设备ID=普通用户@SSH目标` 映射。开发入口从根 `.env` 加载；安装脚本将其持久化到 `~/.config/screen-control/files.env`（0600），用户服务在基础、Tailscale、网关及指标配置之后加载此文件。文件操作只由该账号执行，配置失败不回退到 root/SYSTEM 代理。三机安装、主机密钥核验、固定命令约束和回滚见 [部署说明](../deploy/g0/files/README.md)。

## 文件夹收藏同步

服务端将已登记电脑及手机的收藏统一按目标电脑分组，私网与已认证 HTTPS 网关共用同一存储。默认路径为 `${XDG_STATE_HOME:-$HOME/.local/state}/screen-control/favorites/folders.json`，可用 `SCREEN_CONTROL_FAVORITES_FILE` 或 `--favorites-file` 指定。目录权限 `0700`、数据文件 `0600`，采用临时文件同步后原子替换；启动时发现损坏数据会拒绝启动，不能删除文件以掩盖故障。

套件安装器创建默认收藏目录，服务仅新增 `%h/.local/state/screen-control/favorites` 的 `ReadWritePaths`。自定义存储路径或 `XDG_STATE_HOME` 时，需先创建私有目录并通过现有服务配置及 systemd drop-in 同步指定可写目录；不要扩大整个用户目录的写权限。浏览器不再作为收藏的权威存储；旧数据成功合并后才清理，迁移标识留在浏览器，服务端保存去重记录。正常增删排序保存失败或结果未知时显示错误，不自动重放；其他页面可见时每 3 秒拉取、重新聚焦时立即拉取。每台目标设备最多 512 项。

备份时复制整个收藏目录；回滚程序和网页时保留该目录，避免丢失更新。旧版门户不支持服务端同步，但不会修改这份数据。

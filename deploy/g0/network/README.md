# 主页直连测试

此能力仅检查登记电脑之间的 Tailscale 底层路径。门户发起一轮检测，每台源电脑通过本机 LocalAPI 查询真实 ping 响应；浏览器不提供地址、命令或节点登记。检测最多运行 15 秒，不创建服务，不改变路由、防火墙、Tailscale 配置或现有会话。初始中继后转直连会保留提示，失败不发布旧成功结果。

页面按设备对合并双向结果，四台电脑显示六组紧凑连接行。双向路径和协议一致时只显示一个标签，往返延迟显示两次测量的范围；路径或协议不同时在同一行按箭头分别展示，不用一个方向替代另一个方向。诊断详情默认全部收起，一次只展开一组，保留各自方向的原始结果。统计只有双向均直连才计入“直连”，双向均中继才计入“中继”；直连与中继混合单独计数，任一方向未确认时整组计为未确认。该展示调整不减少底层双向探测，也不承诺同一设备对在不同测量时刻使用完全相同的端点。

直连显示细分为“局域网 IPv4 直连”“局域网 IPv6 直连”“公网 IPv4 直连”“公网 IPv6 直连”；协议族取自经过真实 ping 验证的物理端点。私网或链路本地端点显示为局域网，公网端点显示为公网，不表示公网 IPv6 一定跨越物理局域网。旧探针没有协议版本时只显示已有路径与“IP 协议版本未确认，请重新测试”，不根据 `100.*` 地址猜成 IPv4。协议扩展升级先更新门户，再逐台替换探针；回滚先恢复探针，再恢复门户，保留旧版本备份。

## 构建与安装

使用项目锁定工具链构建门户、服务端及一次性探针：

```bash
make build
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 mise exec -- go build -trimpath -o bin/screen-control-network-probe.exe ./cmd/screen-control-network-probe
```

Linux 套件安装器会安装本机探针。只作被测端的 Linux 电脑可按以下方式安装，无需安装门户。先通过已有 SSH 核验目标身份，备份原 `current` 链接，使用唯一版本目录，安装并核对 SHA-256：

```bash
probe_root="$HOME/.local/lib/screen-control-network-probe"
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0755 "$probe_root/releases/$release_id"
install -m 0755 bin/screen-control-network-probe "$probe_root/releases/$release_id/screen-control-network-probe"
sha256sum "$probe_root/releases/$release_id/screen-control-network-probe"
ln -sfn "$probe_root/releases/$release_id" "$probe_root/current.next"
mv -Tf "$probe_root/current.next" "$probe_root/current"
```

Windows 使用目标普通用户，将 `screen-control-network-probe.exe` 安装至 `%USERPROFILE%\.local\lib\screen-control-network-probe\current\screen-control-network-probe.exe`；替换前将原文件保存到独立版本目录，安装后用 `Get-FileHash -Algorithm SHA256` 对照构建产物。不创建启动任务、监听端口或管理员授权。

程序只从标准输入接收登记表，向标准输出返回路径类别和延迟，不输出端点地址或私钥。服务端同时核对返回的源稳定节点身份和目标集合。无法访问 LocalAPI、源身份不符、未知版本、输出不完整或超限时失败关闭；不要将任意命令的输出当作探针响应。节点重登记后更新既有稳定节点配置，不按旧 IP 冒充同一设备。

## 门户配置

在 `~/.config/screen-control/network.env`（0600）设置以下私有配置；示例账号和域名均为占位符，需换成当前已核验的普通用户 SSH 入口：

```ini
SCREEN_CONTROL_NETWORK_SSH_TARGETS=echova=operator@host-a.example.ts.net,nix=operator@host-b.example.ts.net,jiang-chenx=operator@host-c.example.ts.net
SCREEN_CONTROL_NETWORK_PROBE_VIA=jiang-chenx=echova
```

门户本机按稳定节点身份自动识别，不需要为本机配置 SSH。`PROBE_VIA` 可省略；它仅表示通过某台登记 Linux 电脑的已有 SSH 运维入口启动另一台电脑的固定探针，实际 ping 仍从被测源电脑发出。入口不支持多跳循环，不转发 agent，不复制密钥。所有 SSH 都使用 `BatchMode=yes`、严格主机密钥验证、禁用转发及有界超时。

不要覆盖现有只允许 GPU 查询或文件进程的受限密钥。若没有适合执行固定探针的既有入口，保留“未验证”，另行准备最小授权。程序安装不需要修改授权文件。私网与可选网关必须共用一个 NetworkTester，防止两个入口各自启动重复任务。

确认既有门户单元加载可选的 `EnvironmentFile=-%h/.config/screen-control/network.env`，再执行 `systemctl --user daemon-reload` 和 `systemctl --user restart screen-control-suite.service`。发布前备份当前二进制、门户资源、服务文件和网络配置；先以隔离检出核对线上基线，再只构建本次变更。重启门户会结束既有桌面和文件会话，不需重启 MeshCentral、Tailscale、SyncClipboard 或整机。

## 验证与回滚

发布前运行 Go 测试及相关竞态检查、前端测试、类型检查和 `network` 隔离浏览器场景，检查桌面与手机布局。实际发布后，从已登记设备通过规范入口验证：

1. `/api/v1/health`、身份和设备状态正常，首页引用的静态资源可用。
2. `POST /api/v1/network/tests` 以可信 Origin 提交 `{}`，返回 202；用 `GET` 查询直到 `complete`，检查完整有向结果和结果时间。
3. 路径与同一源端的 `tailscale ping` 抽查一致。未验证、离线和超时是测试结果，不代表安装健康已通过；安装验收需确认所有预期在线源均能返回经核验的探针响应。
4. 任意地址或命令请求被 400 拒绝，重复启动受到全局限流；手机可以启动电脑间检测。

回滚恢复备份的门户二进制、首页、服务配置及原网络环境文件，再重载和重启既有门户并验证健康。保留原静态资源，避免旧页面引用丢失。Linux 探针恢复原 `current` 链接；若此前未安装，仅移除本次创建的链接。Windows 恢复备份的原探针；此前没有文件时仅删除本次新增的可执行文件。保留安装版本、摘要和回滚备份，不清理历史证据。

检测结果不代表永久直连、业务控屏 RTT、无丢包或正式 N01–N05/G0/G3 验收。网页控屏及文件仍沿用现有应用层转发。

## Windows 旧 IPv6 源地址排查

固定地点不代表公网 IPv6 前缀固定。Windows 同时保留新旧前缀时，即使有公网地址和默认路由，也可能为新连接选中已经无法出网的旧地址，令 Tailscale 回退到 DERP。先对照本机 `Get-NetIPAddress`、`Find-NetRoute`、`tailscale netcheck`，并按源地址分别测试；同网其他电脑的结果和路由器广播只能作为交叉证据，不能仅凭地址较旧就禁用它。

确认旧地址不可达、新地址可达后，可在独立 SSH 救援与本机自动回退已核验的前提下，仅将已确认失效的地址在 `ActiveStore` 中设置 `SkipAsSource`，再核对实际选源、双向 `tailscale ping` 和 `netcheck`。该属性影响源地址选择，见 [Microsoft Set-NetIPAddress](https://learn.microsoft.com/en-us/powershell/module/nettcpip/set-netipaddress)。修改前逐地址保存原属性和接口索引，回滚只恢复本次修改的地址；不要写死当前公网前缀、删除全部 IPv6 地址、关闭防火墙或禁用 DERP。

此修正只处理当前地址集合，不是跨重启或下次前缀变化的长期方案。长期处理需核对路由器实际拨号方式、IPv6 模式及旧前缀撤销行为；未取得管理配置和跨前缀变化验证前，不宣称稳定直连已正式验收。当前实测与恢复位置见[环境审计](../../../docs/tasks/private-web-remote/ENVIRONMENT_AUDIT.md)。

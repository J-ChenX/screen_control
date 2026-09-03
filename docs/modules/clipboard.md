# Clipboard — SyncClipboard 集成健康

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

复用 SyncClipboard 并向门户提供“服务、实时文本、历史/文件”三项独立健康与 Ubuntu 快捷键漂移诊断。

## 业务背景与边界

本模块不实现第二套剪贴板协议或网页历史列表。Windows 保留系统 Win+V；两台 Ubuntu 由 GNOME 持久绑定 `Super+V` 到 SyncClipboard 官方 `--command-OpenHistoryPanel`，固定中文 locale。远控内核剪贴板必须关闭，避免重复或循环。

## 核心流程

| 场景 | 流程 | 计划代码/配置 |
|---|---|---|
| 健康采集 | agent 探测服务端可达、文本往返、历史/文件队列 → 独立状态/诊断 | `internal/agent/clipboard/` |
| 快捷键检查 | 读取桌面绑定、locale、命令入口和应用状态 → 漂移告警 | `internal/agent/clipboard/hotkey_*` |
| 版本迁移 | 备份三端配置/数据库/历史 → 一致升级 3.2.0 → A13 → 保留或回滚 | `deploy/clipboard/` |
| 私网切换 | 验证 Tailscale 私网入口 → 更新三客户端 → 观察 → 关闭 cpolar/多余 5033 | `ops/migrations/clipboard-private/` |

## 业务规则

| 规则 | 结果 |
|---|---|
| 服务通但历史失败 | 服务绿色、历史/文件红色；总体不得显示全健康 |
| SignalR 事件失败但文本轮询可用 | 事件仅作诊断，文本状态按真实探针判断 |
| 快捷键配置漂移 | 单独告警，不把应用进程运行等同于快捷键可用 |
| 迁移未通过 A13 | 保持/恢复 3.1.5 和公网入口；不得提前清理回滚路径 |
| 私网已验证并过观察窗 | 才删除 cpolar 和非服务端多余监听 |

## 私网认证与加密边界

SyncClipboard 服务本体只监听 `echova` loopback，不直接监听 Tailnet、LAN 或公网。`clipboard-gateway` 在 echova 的固定 Tailscale 地址上终止 TLS 1.3，并要求逐设备 mTLS；三台设备各有不同、不可导出的客户端私钥和证书 serial，证书绑定 identity 登记中的稳定设备 ID、用途 `syncclipboard`、登记代次和有效期。网关同时以真实 socket peer 调用 `WhoIsForIP`，只有“mTLS 设备 ID = socket peer 稳定节点 ID = 当前有效登记”时才代理到 loopback，任一身份源未知或不一致即失败关闭。

若 SyncClipboard 客户端不能直接提供客户端证书，则在每台机器以对应普通用户运行 `screen-control-clipboard-connector`：SyncClipboard 只连接本机 loopback connector，connector 再以 OS 凭据存储中的逐设备证书建立 mTLS；禁止退化成三机共享密码、URL token 或明文 5033。服务端证书按精确 MagicDNS/FQDN 校验并固定受控 CA，不接受跳过验证、自签名任意信任或 HTTP 回退。connector 和 gateway 均不得记录正文或凭据。

迁移按设备轮换：签发新 serial → 安装到该设备 OS 凭据存储 → 验证三项健康和 peer 双绑定 → 撤销该设备旧 serial；单设备重叠窗口最长 24 小时且旧证书只保留相同设备/用途，不可扩大权限。三机成功并过观察窗后，轮换/撤销旧公网访问凭据和服务密钥，删除 cpolar 配置，关闭公网入口及所有非 loopback 5033；设备替换或丢失不等待观察窗，立即撤销对应 serial。回滚只能回到已记录、仍在时限内的逐设备凭据，不能重新启用已撤销共享/公网凭据；若候选协议无法满足这些约束，私网迁移失败并阻断 G5，而不是降低认证要求。

## 对外接口

```text
ReadClipboardHealth(device) -> ClipboardHealth{
  service: HealthSignal,
  text: HealthSignal,
  historyFile: HealthSignal,
  diagnostics: Diagnostics,
  observedAt: Time
}
```

`ClipboardProbe`/`ClipboardProjection` 在普通用户 `platform-agent` 内生成三项 `ComponentFact`，再由唯一 agent report 写入 control-plane；`portal` 只读带 `factsVersion` 的同一 snapshot/events，不直连本模块。状态统一为 `ready|degraded|unavailable|unknown`，每项均带事实时间和安全诊断码；30/90/180 s freshness 只作用于对应三项，设备在线状态仍由 agent 心跳决定。

## 架构与预算

| 组件 | 职责 | 计划代码 |
|---|---|---|
| `ClipboardProbe` | 三项独立探测及退避 | `internal/agent/clipboard/probe.go` |
| `HotkeyDriftDetector` | Ubuntu 绑定/locale/命令漂移 | `internal/agent/clipboard/hotkey_linux.go` |
| `ClipboardProjection` | 将代理事实映射到领域状态 | `internal/clipboard/projection/` |

| 项目 | 数值 | 失败行为 |
|---|---|---|
| 服务探测 | 每 10 s，超时 2 s | 3 次失败为 unavailable |
| 文本探测 | 每 30 s，超时 5 s | 独立 degraded，不改服务项 |
| 历史/文件探测 | 每 60 s，超时 10 s | 独立 degraded，记录安全诊断码 |
| 快捷键配置检查 | 启动、锁屏恢复、每 5 min | 漂移告警；不自动覆盖用户其他绑定 |
| 状态陈旧 | 30 s/90 s/180 s（对应三项） | `unknown`，不沿用绿色 |

## 安全

- 健康探针记录长度、摘要、队列状态和错误码，不记录剪贴板正文、文件正文或 SyncClipboard 凭据。
- 配置/数据库/历史备份权限仅属对应普通用户或服务身份；仓库不保存真实 URL 凭据。
- 只允许 `echova` 的受控私网服务入口；`nix`/客户端内置服务验证无用途后关闭。
- 在线 SyncClipboard 数据库、历史和队列为敏感内容：位于对应服务身份的加密卷/用户加密存储，目录最小权限；备份独立加密。探针使用专用合成标记并立即清理，不读取或导出既有真实正文。

## 安全负向门

G5/A13 除正常传播矩阵外，必须从临时未登记 Tailnet 节点、公网探针和非 Tailscale LAN 地址尝试连接，并使用错误设备证书、另一已登记设备的证书、已替换设备证书、已撤销/过期 serial、证书与 socket peer 不匹配、错误服务端名称、无 TLS 和直连 loopback/5033 的路径；全部必须在到达 SyncClipboard 服务前拒绝。还要证明公网域名/cpolar 不可达、非服务端监听不存在、旧公网凭据无效，且日志/证据不含证书私钥、应用 token、文本、图片或文件正文。

## 测试与工作包

| 工作包 | 内容 | 验收 |
|---|---|---|
| `IO-02a`–`IO-02h` | migration、逐设备 mTLS gateway、条件 connector、三项探针、Portal 集成、切换、24h soak 和旧入口退役 | A13、G5 |

A13 使用每系统 5 条合成文本、1 张合成图片、1 个 ≤10 MB 合成文件、短断线恢复及两台 Ubuntu 的登录/重启/锁屏/24h `Super+V` 矩阵，并包含上述逐设备认证、加密、旧凭据撤销与未登记/公网负向门。所属交付流见 [集成与运维任务](../tasks/private-web-remote-integration-ops/_INDEX.md)。集中数据分类和残余风险见[项目威胁模型](../appendix/threat-model.md)。

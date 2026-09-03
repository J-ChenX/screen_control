# Remote Desktop — 无人值守控屏

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；MeshCentral 仍是 G0 有条件候选；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

隔离 desktop-only 远控内核并管理启动、控制、结束、撤销及“锁屏并退出”的可验证生命周期。

## G0 进入条件

全面实现前必须通过[远控任务的唯一 G0 四门清单](../../tasks/private-web-remote-remote/_INDEX.md)：三平台登录前/安全桌面、Tailscale-only fail-closed、desktop-only、独立 Origin + 无 URL 启动交换。任一项需长期 fork、TURN-only 或不能强制，则淘汰 MeshCentral 并回到架构选型；六条完整旅程、输入/画面与 A07 统计属于 G3。

## 核心流程

| 场景 | 流程 |
|---|---|
| 启动 | 会话/目标 → 独占远控租约 → `PathDecision` → 3 s 内返回 operation → 独立 Origin 内存交换 desktop-launch → iframe/WS 双重校验 |
| 控制 | 仅画面/键鼠 → 路径和租约持续校验 → 序列化输入；不含音频/剪贴板 |
| 普通结束 | 停发输入 → 关闭 WS/WebRTC → 释放租约；不改变目标锁态 |
| 异常/撤销 | 立即停发且不重放 → 关闭/重协商 → 到期强制终止；不自动锁屏 |
| 锁屏并退出 | 一次性操作摘要 → 平台固定锁屏 → operation 报告 Confirmed/Failed/Unknown；三种结果都结束控制，后两种明确提示目标锁态未知及本地处理动作 |

## 业务规则

- 三台来源到另外两台共 6 条有向旅程；首版每目标最多一个操作者、单主屏。
- Ubuntu GDM/Xorg、锁屏，Windows 登录/锁屏/UAC 必须画面和键鼠有效。
- 4K 目标最高 `1920×1080`；`nix` 最高 `1728×1080`；保比例、不裁剪、不拉伸、无音轨。
- 常规结束、关页、断网或异常均保持原锁态；只有显式按钮可锁屏。
- `PathPolicy` 给出路径，远控只执行并验证实际 candidate pair，不复制路由规则。
- `desktopSessionId` 只是定位符；每个 HTTP、iframe、WS、输入、结束、锁屏和证据入口都复核父会话、来源、目标、租约代次、scope、撤销代次与到期。
- “锁屏并退出”选择失败仍退出，是为了不在锁态未知时保留高权限控制通道；用户可从门户读取状态后建立新会话重试，系统不得把 Failed/Unknown 显示为已锁。

## 对外契约

字段、route、operation、错误、IDOR 绑定与 deadline **只**由[协议契约 §2–§5、§8](../../appendix/protocol-contracts.md)定义。本表仅索引所有权。

| 接口组 | 权威条目 | 消费者 |
|---|---|---|
| 启动/读取 | Remote Desktop v1 `desktops` | portal |
| 结束 | Remote Desktop v1 `:end` operation | portal、撤销器 |
| 锁屏退出 | Remote Desktop v1 `:lock-exit` operation | portal |
| 诊断 | Remote Desktop v1 `evidence` | operations |

详细组件与状态机见 [架构](architecture.md)，隔离威胁见 [安全](security.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| `RD-01a-L`、`RD-01a-W` | Linux/Windows Tailscale-only WebRTC 强制与对抗证据 | G0-2 |
| `RD-01c`–`RD-01e` | 三个平台登录前/安全桌面尖峰 | G0-1 |
| `RD-01f` | desktop-only 服务端能力负测 | G0-3 |
| `RD-01b`、`RD-01g` | 独立 Origin、无 URL 单次启动交换、Cookie/header 清洗与绕过负测 | G0-4 |
| RD-02（4h） | desktop-only 启动、状态机、结束/撤销/锁屏三态 | A02、A05 |
| `RD-03a`–`RD-03f` | Portal 嵌入、分辨率/输入、六旅程与控屏路径验证 | A03–A07、N01–N03、N05 |

八个 G0 工作包任一无法证实对应硬门，即记录失败证据并触发候选替换，不无限尖峰。所属交付流见 [远程控屏任务](../../tasks/private-web-remote-remote/_INDEX.md)。

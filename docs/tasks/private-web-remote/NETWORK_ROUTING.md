# 网络自动选路契约

状态：第一阶段已批准的网络需求附件（2026-09-03）。

来源标记：**[用户确认]** 表示用户明确提出的体验；**[已批准提案]** 表示由工程分析推导并随第一阶段整体批准的契约。

架构落点：`control-plane` 是唯一策略所有者，通过共享 `PathPolicy` 接收代理采集的真实链路事实并向远控、文件和门户发布决策；模块不得复制优先级、防抖和显示标签。运行时字段与失败语义见 [全局关注点 §2](../../appendix/global-concerns.md)。

## 1. 路由目标与优先级

**[用户确认]** 三台电脑在同一局域网且彼此可直达时，自动使用局域网传输；离开该网络或局域网不可达时，自动切换到外部网络，不提供也不要求手工切换按钮。

**[已批准提案]** 统一使用 Tailscale 设备身份和稳定地址，底层按以下顺序建立可用连接：

1. Tailscale/WireGuard 的局域网端点直连。
2. Tailscale/WireGuard 的公网端点直连。
3. Tailscale Peer Relay 私有中继。
4. Tailscale DERP 中继。

## 2. 自动探测、切换与安全边界

- **[安全/工程基线]** “同一网络”由经过身份校验的实际端点握手和链路事实判断，不比较 Wi-Fi 名称、默认网关或私网地址前缀；局域网直连仍使用 Tailscale 加密身份，不开放未认证的 LAN 端口。
- **[已批准提案]** 局域网路径真实可达并连续稳定 5 秒后优先切入，不受当前公网路径质量影响；质量比较只用于同级候选。当前路径失效时立即回退，网络接口、IP、路由或端点变化时自动重探测。
- **[已批准提案]** 能直连时，控屏媒体和文件内容不得被强制绕行不在当前局域网内的 `echova`；具体使用 MeshCentral WebRTC、目标代理直连或其他方案，由第二阶段实机验证决定。
- **[已批准提案]** 网页按事实显示“局域网直连 / 互联网直连 / 私有中继 / DERP / 离线”，并记录最近切换时间和原因。
- **[已批准提案]** 控屏链路在网络变化后 15 秒内恢复且不重放旧键鼠事件；文件传输在 60 秒内从最后确认块续传，不暴露伪完整文件。
- **[安全/工程基线]** 远控和文件的实际业务端点必须能映射到登记的 Tailscale 节点；裸 LAN/公网、未知 WebRTC ICE 候选或无法验证的路径立即失败关闭，不能仅修改显示标签后继续传输。

## 3. 验收场景

以下 N01–N05 全部为正式验收口径。

| 编号 | 场景 | 通过条件 |
|---|---|---|
| N01 | 三台同一真实局域网 | 三组设备对均在 5 秒稳定窗口后使用 LAN 端点直连并显示“局域网直连”；初始协商可短暂使用 DERP，但稳态不得继续 DERP |
| N02 | 一台移出局域网 | 无需改地址或手工选择；移出的设备自动变为互联网直连或中继，仍在局域网的设备对继续直连 |
| N03 | 控屏中网络变化 | 15 秒内恢复画面与控制；无重复按键、连续点击或坐标跳变；UI 更新路径和切换原因 |
| N04 | 大文件中网络变化 | 60 秒内从最后确认块续传；最终大小及 SHA-256 一致，不出现伪完整文件 |
| N05 | 状态真实性 | UI 状态与 Tailscale 连接类型、LocalAPI 或代理采集的实际端点一致；相同私网前缀但不可直达时不得标记为局域网 |

## 4. 证据与技术依据

- 当前设备地址、RTT 和连接类型只在 [ENVIRONMENT_AUDIT.md](ENVIRONMENT_AUDIT.md) 维护，避免易变事实重复。
- Tailscale 节点地址可在设备切换物理网络后保持稳定：[Tailscale IP addresses](https://tailscale.com/docs/concepts/tailscale-ip-addresses)。
- Tailscale 会在 direct、Peer Relay 与 DERP 之间选择和回退，直连通常具有最低时延和最高吞吐：[Connection types](https://tailscale.com/docs/reference/connection-types)、[Device connectivity](https://tailscale.com/docs/reference/device-connectivity)。
- MeshCentral WebRTC 是否满足上述直连目标必须实机验证，不能作为既成事实：[MeshCentral WebRTC discussion](https://github.com/Ylianst/MeshCentral/issues/1064)、[MeshAgent WebRTC connectivity report](https://github.com/Ylianst/MeshAgent/issues/324)。

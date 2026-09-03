# 子任务：集成与运维

**父任务：** [private-web-remote](../private-web-remote/_INDEX.md)  
**状态：** 第四阶段进行中；`IO-01a`/`IO-01b` bootstrap candidate 已通过，当前执行 `IO-01c`
**范围：** `clipboard`、`operations` 及所有模块的构建、发布、恢复和最终验收

## 工作包规则

下表 ID 在全项目唯一；预计为 2–4 小时主动工程工时，CI 排队、传输、重启、金丝雀观察和 24 小时 soak 另列墙钟。除 `IO-01a`/`IO-01b`/`IO-01c` 严格按[验证工程策略的自举证据协议](../../appendix/verification-strategy.md)执行并在 runner 可用后转为正式证据外，每包必须以唯一入口执行同名场景，保存首次失败、重跑、阈值、敏感工件和清理回执。

执行按四个有界段恢复，段间不回跳：`IO-A = IO-01a..IO-01d + IO-04a`（5 包，bootstrap/G0/备份 checkpoint），`IO-B = IO-02a/02f/02g/02b + IO-03a + IO-04b`（6 包，Clipboard/恢复基础 checkpoint），`IO-C = IO-02c/02d/02e/02h + IO-03b/03c`（6 包，G5/韧性 checkpoint），`IO-D = IO-05a..IO-05g`（7 包，G6 checkpoint）。段内按下表 DAG 执行，每段结束须更新 `_ACTIVE.md` 和签名证据索引。

## 第四阶段执行记录

`IO-01a` recorder、固定三节点/命令白名单、跨平台摘要解析、十类语义 validator、严格 SSH host key、IPv4/IPv6/身份脱敏、有界输出、敏感扫描、固定 schema、只新建不覆盖的 bundle 和 hash seal 已实现；代码入口与测试见 [operations 模块实现指针](../../modules/operations/README.md#第四阶段实现指针)。失败 run 保持只读且不被重跑覆盖，历史 seal 完整性与 recorder trust/current 状态分开报告。

当前通过的 `IO-01a` candidate run 为 `io-01a-20260903T103433.753038Z-f9f2fd7839`，使用 recorder SHA-256 `c927ad785df5f192f2da3599851b59c71b19aea52a0fd1345d856cc709306def`，113 个探针中 92 个成功；三机必填类别、固定节点 inventory、UTC ≤2 s 与同步健康全部通过。bundle SHA-256 为 `041f683e1531796975277c7de3b3d1944e211bfe60da240a0e7e1dfc963f703f`，environment snapshot hash 为 `d12b8cca914eae319016ee31cea7668f7ae3803c5e0f120c3324984162bc3e77`，verifier 报告 integrity/provenance/current/trusted 全部为 true。未安装的编码器探测工具只影响对应 G0 spike readiness，不伪装成 snapshot 缺失。

`IO-01b` 已初始化 Git；根基线 commit 为 `7d813cd68e882e0a6e45198b22b50ff6a7669c58`，完整 IO-01b 源码基线 commit 为 `a2f3d6128094dac7df6a1ad7520189688f5a6f3f`。项目锁定 Go 1.26.8/兼容 1.27.1、Node 24.20.0、React 19.2.8、TypeScript 7.0.2、Vite 8.2.2、Vitest 4.1.11、Playwright 1.62.1、pnpm 11.25.0 和全部 Go/npm 依赖。`toolchain.lock.json` 同时记录三机 snapshot、目标/观测版本差异、官方来源/许可证/升级窗口/替换触发器及明确阻断包；CycloneDX 1.7 SBOM 含 130 个组件，SLSA/in-toto provenance schema 与八领域 QG02 候选/拒绝/替换矩阵已入库。candidate run `io-01b-20260903T103806.570259Z-ead7e91e65` 的六条固定命令全过，toolchain lock SHA-256 为 `b435f4c4c398a4364ab447685d9cc24f2bdac0218af9a0938a0dd05e81a328e7`，bundle SHA-256 为 `abde6bab36a00b618d0cc90f603a1aa16a51979b58b711fcc6da76b92d357057`，四项 verifier 状态全真。所有早期失败 run 均保留；两包仍待 `IO-01c` 导入、重验和正式签发。

## 工作包

| 行号（执行以段/DAG为准） | ID | 模块 | 可交付内容 | 主动工时 | 墙钟约束 | 明确前置 | 主要验证场景 |
|---|---|---|---|---|---|---|---|
| 1 | IO-01a | operations | hash 固定的只读 bootstrap preflight recorder、三机脱敏 snapshot | 3h | 无 | 无 | 仅允许列表查询；OS/内核/显示/GPU/浏览器/Tailscale/防火墙/端口/权限/时钟/磁盘；bundle 可由正式 runner 重验 |
| 2 | IO-01b | operations | 仓库/构建基线、完整 toolchain manifest、SBOM/provenance 骨架及 QG02 候选/拒绝/替换矩阵 | 4h | 下载/构建另计 | `IO-01a` | manifest 无浮动版本/空必填；官方来源、目标环境和替换触发齐全 |
| 3 | IO-01c | operations | `ops/verify/run`、场景 schema、CI 矩阵、虚拟时钟夹具、A01 主体夹具和耐久证据仓 | 4h | CI 排队另计 | `IO-01b` | unit/contract/web/platform/security/e2e/resilience/recovery/soak dry-run 与已知统计集回归 |
| 4 | IO-01d | operations | Linux/Windows 网络改动 watchdog、独立救援与自动回滚演练 | 3h | 回退等待 ≤5 min | `IO-01a`、`IO-01c` | 保存规则/连通 hash；失联自动恢复；另一节点复核后才取消回退 |
| 5 | IO-02a | clipboard | 3.1.5→3.2.0 配置/DB/历史 migration、fresh/upgrade/rollback 夹具 | 4h | 备份/复制另计 | `G0`、`IO-01b`、`IO-01c`、`IO-04a` | 三类安装、兼容、失败回滚和原数据 hash |
| 6 | IO-02f | clipboard + operations | Tailscale mTLS gateway、独立服务身份与 SyncClipboard 精确上游 | 4h | 无 | `G0`、`IO-01b`、`IO-01c` | 双向证书/peer/设备绑定、非 Tailnet/错设备/直连上游拒绝，秘密不进 URL/日志 |
| 7 | IO-02g | clipboard + agent | 普通用户 connector 的必要性探针与最小本地适配器 | 3h | 无 | `IO-02f`、`PA-01` | 原生客户端若可 mTLS 则记录“不部署”；否则 connector 仅收本机用户 IPC、固定 gateway、无监听扩散 |
| 8 | IO-02b | clipboard | 当前文本、事件通道、历史/文件队列三项独立健康探针 | 3h | 无 | `IO-02a`、`IO-02f`、`IO-02g`、`PA-01` | 401 恢复、hash mismatch、队列停止分别呈现，不以文本健康代替整体健康 |
| 9 | IO-02c | clipboard + portal | 三项健康、快捷键/自启状态和私网端点的 Portal 集成 | 4h | 无 | `IO-02b`、`PC-04`、`PC-08` | stale/unknown/partial UI、状态订阅、无凭据/剪贴板内容泄漏 |
| 10 | IO-02d | clipboard + operations | 三端一致升级、私网切换、GNOME 快捷键漂移与回滚切换 | 4h | 三端重启另计 | `IO-02c`、`IO-04b` | 每系统 5 文本+1 合成图片+1 个 ≤10 MB 合成文件到另两端、短断线 60 s 恢复、登录/锁屏恢复；公网入口暂不删除 |
| 11 | IO-02e | clipboard | A13 24 小时稳定性观察与漂移/队列恢复证据 | 2h | 连续 24h；中断重开新 run | `IO-02d` | 三端心跳、三项健康、快捷键、自启、私网 mTLS 链路全窗无阈值违例 |
| 12 | IO-02h | clipboard + operations | soak 后逐设备撤销旧公网/共享凭据，关闭 cpolar 与非 loopback 5033 并执行拒绝矩阵 | 4h | DNS/证书撤销传播另计 | `IO-02e` | 公网、未登记/旧设备、错误/旧证书、明文和多余监听全部拒绝；私网三项健康保持 |
| 13 | IO-03a | operations | 分项 health、指标、结构化脱敏日志和告警契约 | 4h | 无 | `PC-04`、`PA-01`、`IO-02b` | liveness/readiness/component 分离；敏感扫描为零 |
| 14 | IO-03b | operations | 10× 容量模型执行器、资源阈值和背压/拒绝矩阵 | 4h | 压测稳定窗另计 | `IO-03a`、`PC-05`、`FF-03c`、`RD-02` | SQLite/会话/传输/订阅/审计到限且身份撤销不饥饿 |
| 15 | IO-03c | operations | 跨进程失败预算、故障注入、恢复 epoch 与幂等对账 | 4h | 故障恢复窗另计 | `IO-03a`、`PC-03`、`FF-03c`、`RD-02` | kill/断网/磁盘/旧消息；会话不延长、输入不重放、未知结果可对账 |
| 16 | IO-04a | operations | 配置/SQLite/Mesh/SyncClipboard 在线备份、完整性和隔离恢复 | 4h | 备份/恢复另计 | `IO-01b`、`IO-01c` | 加密/权限/完整性、旧凭据全撤销、恢复 epoch 单调 |
| 17 | IO-04b | operations | expand/contract、相邻版本、金丝雀、自动/人工回滚 DAG | 4h | 金丝雀观察另计 | `IO-04a`、`IO-03a` | 前向/后向兼容、健康门、逆序回滚和失败恢复点 |
| 18 | IO-05a | operations | G1/G2 身份、状态、租约和 PathPolicy 证据聚合复核 | 3h | 无 | `PC-01`、`PC-02`、`PC-03`、`PC-04`、`PC-05`、`PC-06`、`PC-10`、`PC-11` | 同一 release/environment、A01/A02 与契约证据无缺口 |
| 19 | IO-05b | operations | G3 远控证据、六旅程统计和 N01–N03/N05 聚合复核 | 3h | 无 | `RD-03b`、`RD-03c`、`RD-03d`、`RD-03e`、`RD-03f` | 逐旅程 600 样本，控屏 15 秒恢复，不汇总掩盖失败，原始统计可复算 |
| 20 | IO-05c | operations | G4 文件 A08–A12、N04、故障矩阵和隔离保护聚合复核 | 3h | 无 | `FF-05b`、`FF-05c`、`FF-05d` | 三目标、六方向、>3 GB 三旅程、文件切网 60 秒续传、审计/清理齐全 |
| 21 | IO-05d | operations | G5/A13 migration、健康、传播矩阵、私网切换、24h soak 和旧入口退役聚合复核 | 2h | 无 | `IO-02h` | 全观察窗、三端传播/恢复、首次失败/重跑、旧凭据与公网/监听拒绝证据完整 |
| 22 | IO-05e | operations | QG01 所有权/入口/依赖扫描与迁移项逐项清理 | 4h | 无 | `IO-05a`、`IO-05b`、`IO-05c`、`IO-05d`、`IO-04b` | 无重复/孤立/废弃入口；仅满足退出条件的明确目标被清理 |
| 23 | IO-05f | operations | QG02/QG03 版本/来源/SBOM 与多调用方契约复核 | 3h | 无 | `IO-05e` | manifest 完整、无 EOL/漂移、稳定 tool 的权限/错误/版本测试齐全 |
| 24 | IO-05g | operations | G6/A14 逐组件重启/恢复与签名证据总索引 | 4h | 重启/恢复另计 | `IO-03b`、`IO-03c`、`IO-04b`、`IO-05f` | readiness SLO、灾难 RTO、目录外摘要、会话/输入安全及索引 hash 全通过 |

`IO-01a` 至 `IO-01d` 是 G0 的全部运维前置：前三机事实只读采集，任何系统级网络改动必须有已演练的 watchdog/独立救援/自动回退。`IO-02e` 的 2 小时是启动、巡视、收尾和复核的主动工时；24 小时是真实连续墙钟，进程或采集断开就用新 run 重新开始，不能拼接。

## 迁移账本初始项

| 项目 | 负责人工作包 | 当前回滚路径 | 删除条件 |
|---|---|---|---|
| cpolar SyncClipboard 入口 | `IO-02h` | `IO-02d` 生成的限时、逐设备回滚材料 | mTLS gateway/必要 connector 与 `IO-02e` 通过后，在 `IO-05d` 前撤销凭据、关闭入口并完成公网负测 |
| `nix`/客户端多余 5033 | `IO-02h` | 原配置备份 | 调用方扫描为零、私网三项健康与回滚通过后关闭并验证无监听 |
| G0 Mesh 尖峰配置/凭据 | `RD-01g` / `IO-05e` | 隔离目录、单独数据卷和规则快照 | 候选 G0 转正后迁入 release manifest，或失败后按 run ID 完整移除 |
| Docker 29.6.1 | `IO-04b` / `IO-05e` | 宿主包/配置备份 | 29.7.2 Compose、网络、金丝雀与恢复回归通过 |
| SyncClipboard 3.1.5 | `IO-02a` / `IO-02h` | 配置、DB、历史与二进制备份 | 3.2.0 三端 A13、24h soak、回滚演练和旧凭据拒绝通过 |

## 完成定义

- G6 仅在 `IO-05a` 至 `IO-05g` 全部通过后成立；总验收是证据复核和安全清理，不把多平台执行重新塞进一个 4 小时包。
- 所有 A01–A14/N01–N05/QG01–QG03 都可从签名总索引追溯到工作包、命令、release/toolchain/environment hash、阈值和清理回执。
- 旧入口和临时配置仅在书面退出条件满足后删除；失败时恢复明确版本且不影响 8080、用户数据或其他项目。

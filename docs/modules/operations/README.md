# 运维模块 — 部署、恢复与验收

**最后更新：** 2026-09-04
**状态：** 🔄 第四阶段实施中；`IO-01a`/`IO-01b`/`IO-01c`/`IO-01d`/`IO-04a` 已形成正式签名通过证据，当前支撑远控 G0

## 一句话职责

提供可重复的版本锁定、部署、秘密、健康、备份恢复、容量、迁移清理和 A/QG 总验收证据。

## 部署单元

| 单元 | 位置 | 生命周期 |
|---|---|---|
| `edge-gateway` | echova 宿主或最小网络单元 | 独立重启；访问宿主 tailscaled LocalAPI 与证书 |
| 组合根 + 门户静态资源 | echova Compose | SQLite 单写；静态资源不可变 |
| MeshCentral | echova 独立容器/卷 | 仅 G0 通过后转生产；Node 24 镜像摘要固定 |
| SyncClipboard 服务 | echova 独立服务 | 3.2.0 门控迁移，可回滚 3.1.5 |
| SyncClipboard mTLS 网关 | echova 独立最小网络单元 | 只接收登记 Tailscale 对端的 mTLS；固定上游 SyncClipboard，不暴露服务端凭据 |
| SyncClipboard 连接器（条件部署） | 三台普通用户服务 | 仅原生客户端不能满足 mTLS 时部署；本机用户 IPC → 固定网关，无通用代理能力 |
| MeshAgent | 三台原生系统服务 | 登录前；二进制哈希固定、禁自动升级 |
| `screen-control-peer-helper` | 三台最小系统服务 | 只为本机普通用户文件代理签发连接/peer 绑定证明；不可代理 LocalAPI 或任意网络查询 |
| 文件/状态代理 | 三台普通用户服务 | 用户权限；独立秘密与端口 |

## 核心流程

| 场景 | 流程 |
|---|---|
| 部署 | 预检 → 备份/校验 → 兼容扩展 → 网关/控制面 → 金丝雀代理 → 门户 → 健康门 |
| 回滚 | 停止新写/租约 → 恢复兼容服务 → 逆序二进制 → 按演练方案恢复数据 → 撤销旧凭据 |
| 备份 | 配置、SQLite、Mesh 卷、SyncClipboard 数据分别备份/校验/权限检查 |
| 清理 | 证据通过 → 关闭 cpolar/多余 5033/尖峰入口 → 扫描端口、依赖、配置和文档 |
| 验收 | 统一 `ops/verify/run` 逐工作包、逐门运行；测试只写隔离目录并校验目录外摘要不变 |

## 运维规则

- 不修改 `echova` 的 8080 或无关项目；项目端口在部署时登记且冲突即失败。
- 版本、镜像摘要、MeshAgent 三平台哈希、迁移号和配置模式定义进入单一发布清单。
- 备份未校验、空间不足、版本不兼容或前一门失败时不得继续部署。
- 秘密按设备/用途分离，轮换和恢复后撤销旧代次；不写仓库、镜像层或日志。
- 系统身份的对端辅助进程与普通用户文件代理分离发布/审计；SyncClipboard gateway/connector 使用独立 mTLS 身份，均固定二进制哈希、IPC ACL 与最小沙箱。
- cpolar、多余 5033 和 G0 配置只有满足书面退出条件后才删除；备份本身有保留期限。
- G0 前先完成三机只读 preflight；防火墙/路由变更必须已有独立救援、定时看门狗和自动回滚演练，验证节点从另一台设备确认通过后才取消回退。
- 测试命令、CI/实机矩阵、虚拟时钟、A01 负测主体、A07 统计和证据保留只在[验证工程策略](../../appendix/verification-strategy.md)维护。

## 对外接口摘要

```text
Deploy(release, targets, gate) -> DeploymentResult
Backup(scope, reason) -> BackupReceipt
Rollback(deployment, backupReceipt) -> RollbackResult
Verify(acceptanceIds[], environment) -> EvidenceIndex
```

细节见 [架构](architecture.md)，秘密和供应链边界见 [安全](security.md)。

## 第四阶段实现指针

| 组件/契约 | 代码指针 | 当前状态 |
|---|---|---|
| 固定节点与只读探测白名单 | `ops/bootstrap/preflight:83-164` | 已实现；Linux/Windows 查询面固定，无任意命令参数 |
| 严格 SSH 主机密钥、输出解码与 IPv4/IPv6/身份脱敏 | `ops/bootstrap/preflight:225-446` | 已实现；固定 known_hosts，原始 stdout/stderr 仅保留完整哈希 |
| 十类语义校验、三样本时钟与同步健康 | `ops/bootstrap/preflight:461-605` | 已实现；采集完整性与尖峰就绪状态分离 |
| 有界流式探测与节点采集 | `ops/bootstrap/preflight:634-827` | 已实现；每流 8 MiB 上限，超限终止并失败关闭 |
| exclusive 记录包、敏感扫描与构建来源证明 | `ops/bootstrap/preflight:829-1016` | 已实现；嵌入 recorder/pin/schema/Python runtime，新运行不覆盖旧证据 |
| IO-01b 固定构建记录与双记录包验证器 | `ops/bootstrap/preflight:1018-1395` | 已实现；六条本地命令、固定工件集、独立 seal/trust 校验 |
| 记录器与模式定义的固定哈希 | `ops/bootstrap/preflight.sha256:1`, `ops/bootstrap/bundle.schema.json` | 记录器 `c927ad7…06def`；模式定义 `c6c3677…8343` |
| 安全、语义、工具链与防篡改测试 | `tests/operations/test_bootstrap_preflight.py:32-290`, `tests/operations/test_toolchain_lock.py:1-55` | 22 项通过 |
| 唯一验证入口、证据签名与场景审计 | `ops/verify/run:1-532`, `tests/operations/test_verify_runner.py:1-96` | 已实现；正式导入 IO-01a/01b，生成追加式签名证据 |
| 三机网络看门狗与自动回退 | `ops/network-guard/guard.py:1-223`, `tests/operations/test_network_guard.py:1-58` | 已实现；IO-01d 三机演练通过 |
| 加密备份、SQLite online backup 与隔离恢复 | `ops/backup/backup_restore.py:1-397`, `tests/operations/test_backup_restore.py:1-54` | 已实现；IO-04a 演练通过 |
| MeshCentral G0 静态闭合校验 | `deploy/spike/meshcentral/verify.py:1-139`, `tests/operations/test_meshcentral_spike.py:1-46` | 已实现；配置、依赖锁和容器隔离校验通过，不替代实机 G0 |

当前三机引导候选项位于本地受限证据仓 `evidence/bootstrap/io-01a/io-01a-20260903T103433.753038Z-f9f2fd7839/`。113 个探针中 92 个成功，三机所有必填语义类别完整，时钟偏差分别约 `nix -0.000 s`、`echova -0.016 s`、`jiang-chenx -0.079 s` 且系统同步健康。记录包 SHA-256 为 `041f683…f703f`，环境快照哈希为 `d12b8cc…3e77`；完整性、构建来源证明、当前记录器匹配和受信状态均为 true。其余探测为明确记录的可选能力缺失；编码器事实作为 G0 尖峰 blocker 单独保留。

`IO-01b` 候选项位于 `evidence/bootstrap/io-01b/io-01b-20260903T103806.570259Z-ead7e91e65/`，固定六条工具链验证/Go build/前端 typecheck-test-build 命令全部通过。工具链 lock SHA-256 为 `b435f4c…328e7`，CycloneDX SBOM 含 130 个组件，记录包 SHA-256 为 `abde6ba…57057`，完整性/provenance/current/trusted 全部为 true。两类引导目录均由 `.gitignore` 排除并保留为哈希封存输入；`IO-01c` 已完成独立导入、重验与正式签发。

当前提交 `e500549f7c64824ad65528885d5940ff099793ff` 上，`IO-01a`/`IO-01b`/`IO-01c`/`IO-01d`/`IO-04a` 的最新正式通过运行依次为 `io-01a-20260903T111417.466974Z-2b63691ec1`、`io-01b-20260903T111422.752250Z-37281c869c`、`io-01c-20260903T111427.629698Z-2627317135`、`io-01d-20260903T111555.814325Z-2cd89b17c3`、`io-04a-20260903T111559.953182Z-f466d28fae`。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| `IO-01a` | 哈希固定三机只读 preflight 记录器与引导记录包 | 正式导入、重验和签名证据通过 |
| `IO-01b` | Git/构建/toolchain/SBOM/provenance/QG02 基线 | 正式导入、重验和签名证据通过 |
| `IO-01c`–`IO-01d` | 唯一验证入口与网络自动回滚 | 完成；当前提交正式证据通过 |
| `IO-03a`–`IO-03c` | 可观测性、10× 容量与跨进程故障/恢复 epoch | A14、QG03 |
| `IO-04a`–`IO-04b` | 备份恢复、兼容、金丝雀和回滚 DAG | `IO-04a` 完成；`IO-04b` 待后续依赖 |
| `IO-05a`–`IO-05g` | 按门聚合复核、迁移清理、QG 与签名总索引 | A01–A14、QG01–QG03 |

`IO-02a`–`IO-02h` 属 `clipboard`，其中 `IO-02f`/`IO-02g` 收口 mTLS gateway/条件连接器，`IO-02e` 的 24h 长稳测试是独立墙钟包，`IO-02h` 在 G5 聚合前撤销旧凭据并关闭公网/多余监听。完整依赖与每包 2–4 小时主动工时见[集成与运维任务](../../tasks/private-web-remote-integration-ops/_INDEX.md)。

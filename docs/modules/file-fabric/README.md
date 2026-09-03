# File Fabric — 统一文件数据面

**最后更新：** 2026-09-03  
**状态：** ✅ 血肉完成；代码均为 `[计划中 — 代码尚未存在]`

## 一句话职责

以目标普通用户权限提供三机统一命名空间、安全文件操作、审计、断点续传和双端授权的跨设备复制。

## 边界

- Linux 从 `/`、Windows 从可用卷根开始；不可访问对象显示权限不足，不提权。
- `/home/operator/nas` 是普通目录，不拥有独立页面、API、权限或缓存副本。
- 同设备支持复制/移动；跨设备只支持复制，不出现移动入口。
- 不开放文件预览执行、回收站恢复/清空、自动同步、任意 URL 拉取或特殊设备访问。

## 核心流程

| 场景 | 流程 |
|---|---|
| 浏览/搜索 | 设备能力 → SafeFS 逐组件打开 → 类型/权限/挂载分类 → 分页结果 |
| 变更/批量 | 操作摘要/幂等键 → 中心持久 intent → 租约/capability → 端点 journal 幂等执行 → outbox 回传审计与逐项 effects |
| 上传/替换 | 预留空间 → 同目录排他临时对象 → 分块确认/SHA-256 → 前置条件重验 → 原子提交 |
| 下载 | 句柄与能力复核 → Web Worker 携带内存 capability 直连代理 → Range 流式落盘/逐块确认 → 客户端最终哈希 |
| 跨机复制 | 固定源/目标设备 ID → 双端授权与共同 manifest → 代理直传 → 目标原子提交 |
| 删除 | `Trash` → Trashed；仅 Unsupported 可进入二次确认和新授权的永久删除 |

## 业务规则

| 规则 | 结果 |
|---|---|
| 同名或目标已变化 | 永不静默覆盖；提供替换/取消/自动改名，替换需新鲜前置条件 |
| 批量/跨卷移动 | 每项 `succeeded|partial|failed|unknown`，同时报告 `effects/sourceState/destinationState/recoveryAction`；不伪装为原子成功 |
| 链接/挂载/reparse | 显示真实类型；搜索不递归跟随；删除链接只删链接本身 |
| 传播性挂载 | 可访问时显示存储类型；覆盖/移动/删除增加外部传播警示 |
| 回收站 Unsupported | 显式不可恢复二次确认后签发新一次性授权；Failed/Unknown 不可降级永久删除 |
| 大文件 | 上传、下载、跨机复制均提供 Query/Resume/Abort/Result、>3 GB 断点续传和 SHA-256；浏览器不支持直连流式写盘时触发选型阻断，不回退门户中转 |
| 审计 | 中心 intent 成功才授权端点；端点 durable journal + outbox 跨崩溃重传，Portal 只在中心 receipt 后显示终态成功 |

## 对外契约

字段、route、operation、`ItemResult`、传输生命周期、审计一致性和 deadline **只**由[协议契约 §2–§5、§9](../../appendix/protocol-contracts.md)定义。本表仅索引所有权。

| 接口组 | 权威条目 | 消费者 |
|---|---|---|
| 读取/搜索 | File Fabric v1 entries/object/searches | portal |
| 变更/永久删除 | File Fabric v1 mutations/permanent-delete | portal |
| 传输 | Transfer Start/Query/Resume/Abort/Result/Commit + data plane | portal/agent |
| 跨机复制 | `Operation(kind=file.device-copy)` + Transfer lifecycle | portal、两端 agent |
| 审计 | intent + journal + outbox + `AuditReceipt` | 本模块内部 |

详细组件与状态机见 [架构](architecture.md)，安全边界见 [安全](security.md)。

## 工作包映射

| 工作包 | 内容 | 验收 |
|---|---|---|
| FF-00（4h） | 三台锁定浏览器 >3 GiB 流式落盘/恢复能力尖峰 | A11 前置硬门 |
| FF-01（4h） | SafeFS 与三平台命名空间/对象分类 | A08 |
| `FF-02a`–`FF-02c` | 列表/搜索、先行审计一致性骨架、其上的变更/部分结果与回收站 | A09–A10、A12、SG04 |
| `FF-03a`–`FF-03c` | 浏览器直连硬门、Transfer lifecycle、分块续传与原子提交 | A10–A11；>3 GB 硬门 |
| `FF-04a`–`FF-04b` | 双端授权跨机复制、固定设备解析与路径切换 | A09–A11、N04 |
| `FF-05a`–`FF-05d` | Portal 集成及按目标拆分的三来源/故障矩阵 | A08–A12 |

所属交付流见 [文件数据面任务](../../tasks/private-web-remote-files/_INDEX.md)。

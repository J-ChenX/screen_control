# 文件数据面 — 安全

**最后更新：** 2026-09-03

## 权限要求

| 操作 | 必须绑定 |
|---|---|
| 浏览/搜索/下载 | 来源节点、目标设备、对象/根、动作、期限；直连数据面另绑定 `PeerBindingProof` |
| 变更/删除/提交 | 上述字段 + 租约、对象/父目录身份模块、操作摘要、幂等键 |
| 跨设备复制 | 来源节点、源/目标设备、源读、目标写、两端对象、清单哈希、期限 |
| 永久删除 | `Trash=Unsupported` 证据、明确挑战文本、新的一次性能力凭据 |

## 句柄级安全

- Linux 逐组件不跟随链接；优先 `openat2` 约束解析，回退必须保持目录句柄链与等价测试。
- Windows 打开对象后核验 final 路径、volume、reparse tag 与普通用户访问；拒绝设备命名空间和危险特殊对象。
- 修改/提交前重新核验对象及父目录身份模块、权限和页面打开后的陈旧条件；字符串规范化不是授权边界。
- 搜索默认不跨挂载、不跟随链接；显式允许可访问挂载时仍受深度、对象数和传播警示约束。

## 威胁与缓解

| 威胁 | 缓解 |
|---|---|
| 路径穿越/TOCTOU | 句柄链、对象身份模块、提交前重验 |
| SSRF/开放代理 | 只接收登记设备 ID；固定端点；禁重定向；连接后复核对端 |
| IDOR | 操作、游标、search、challenge、session/evidence、transfer/manifest/chunk/result 每次访问均复核统一 `ResourceBinding` 与父代次 |
| 临时文件覆盖/链接 | 同目录随机排他不跟随链接创建，最小权限与本项目标记 |
| 磁盘耗尽/稀疏文件 | 声明大小、实际块归属、预留空间、并发与 TTL 配额 |
| 主动内容 | attachment、nosniff、限制 CSP；首版无同源预览 |
| 永久误删 | 只有 Unsupported 进入二次确认；Failed/Unknown 绝不降级 |
| 审计泄密 | 结构化允许字段清单，敏感字段和正文统一过滤 |
| 中心审计中断后的远端变更 | 中心先持久意图；端点 journal/outbox 分阶段 fsync；无回执不报终态成功，恢复按对象身份模块协调而非盲重做 |
| 普通代理借 LocalAPI 提权 | 代理不持有 tailscaled 套接字；最小权限 `screen-control-peer-helper` 只自行接受专用文件端口并移交数据流 + 一次性签名 `PeerBindingProof`；辅助进程失败则拒绝数据面 |

## 安全测试

A08 对抗矩阵覆盖 Linux `/proc`/`/sys`/设备节点、符号链接/挂载点以及 Windows junction/reparse/卷/保留设备名；A09–A12 全部在隔离目录，既有数据只做只读清单与摘要比对。另按[协议契约 §3、§9](../../appendix/protocol-contracts.md)覆盖 operation/cursor/search/challenge/transfer 等所有不透明资源的跨主体/跨来源/旧代次复用、传输 Query/Resume/Abort/Result、跨卷 `partial/effects`、>3 GB 浏览器内存/泄漏门和审计六个崩溃切点。

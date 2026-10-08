# 文档导航

[返回项目首页](../README.md)

## 使用与参与

| 想了解的问题 | 入口 |
| --- | --- |
| 项目是什么、当前能做什么 | [项目首页](../README.md) |
| 启动、日常操作、手机、文件与可选网关 | [使用与部署指南](USAGE.md) |
| 环境变量、加载优先级、服务配置 | [配置指南](CONFIGURATION.md)、[公开示例](../.env.example) |
| 如何贡献、报告问题与漏洞 | [贡献指南](../CONTRIBUTING.md)、[支持说明](../SUPPORT.md)、[安全政策](../SECURITY.md) |
| 已有变化与后续方向 | [变更记录](../CHANGELOG.md)、[路线图](ROADMAP.md) |
| GitHub 协作与质量配置 | [仓库维护说明](REPOSITORY.md) |

## 开发与验证

| 主题 | 入口 |
| --- | --- |
| 构建与测试命令 | [Makefile](../Makefile)、[测试说明](../tests/README.md) |
| 模块职责与依赖 | [架构全景](ARCHITECTURE.md)、[模块设计目录](modules/) |
| 字段、错误、权限与兼容 | [协议契约](appendix/protocol-contracts.md) |
| 安全与网络边界 | [威胁模型](appendix/threat-model.md)、[全局关注点](appendix/global-concerns.md)、[网络选路](tasks/private-web-remote/NETWORK_ROUTING.md) |
| 正式验收与固定工具链 | [验证策略](appendix/verification-strategy.md)、[当前工具链清单](../deploy/releases/current/toolchain.lock.json) |
| 性能与资源管理 | [内存评估](performance/MEMORY.md)、[测量与修复记录目录](performance/) |

## 部署入口

- [统一 Tailscale 套件](../deploy/g0/suite/README.md)
- [普通用户文件通道](../deploy/g0/files/README.md)
- [MeshAgent 部署与回滚](../deploy/g0/meshagent/README.md)
- [可选 HTTPS 网关](../deploy/gateway/README.md)
- [Rust 原生候选构建](../deploy/g0/meshagent/rust-native/README.md)
- [MeshCentral 隔离尖峰](../deploy/spike/meshcentral/README.md)

## 规划与证据的阅读方式

[原始需求](tasks/private-web-remote/_INDEX.md)、[决策记录](tasks/private-web-remote/DECISIONS.md)和[当前任务指针](tasks/_ACTIVE.md)用于追溯阶段与工作包。架构、环境审计和任务指针可能保留早期三机范围及当时状态；不能据此禁用后来存在的手机、第四台电脑或可选网关，也不能凭代码或页面演示宣布生产门完成。

当前用法先查项目首页、使用及配置指南；计划看需求和模块设计；是否通过测试与实机验收看对应日期、提交和适用版本的证据。历史签名与封存记录不随当前代码改写。

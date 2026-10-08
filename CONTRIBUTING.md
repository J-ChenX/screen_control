# 贡献指南

感谢你帮助改进 Screen Control。当前项目仍是私人环境的 G0 桥接；开始前请阅读[项目介绍](README.md)、[使用指南](docs/USAGE.md)及[行为准则](CODE_OF_CONDUCT.md)。涉及架构、权限或部署边界的改动，先通过功能建议 Issue 说明目标与验收方式。

## 开发环境

在仓库根目录运行：

```bash
make setup
make doctor
git switch -c codex/your-change
```

工具版本以 `.mise.toml`、`rust-toolchain.toml`、`web/package.json` 和锁文件为准。Python、C 编译器、OpenSSL 与 GnuPG 等宿主工具要求见[工具链清单](deploy/releases/current/toolchain.lock.json)。自动测试使用隔离夹具；只有运行真实桥接时才需要按[配置指南](docs/CONFIGURATION.md)准备 `.env`、Tailscale 和目标通道。

## 选择修改入口

- Go 运行入口在 `cmd/`，后端实现与包内测试在 `internal/`。
- React 界面和 Vitest 测试在 `web/`，隔离浏览器场景在 `tests/browser/`。
- Rust 协议核心和 C ABI 在 `native/`，原生集成测试在 `tests/native/`。
- 运维脚本在 `ops/`、`deploy/`，Python 回归在 `tests/operations/`。
- 使用和配置文档在 `docs/`；[文档导航](docs/README.md)区分当前说明、生产设计和历史证据。

优先扩展已有实现；跨模块字段、错误和权限语义变更须同步提供方、调用方、测试与[协议契约](docs/appendix/protocol-contracts.md)。不要以新的备用接口复制已有职责。

## 提交前验证

按实际变更选择检查，不为纯文档改动运行全部业务测试：

| 变更 | 检查 |
| --- | --- |
| 文档与注释 | 审阅中文、链接、命令；`git diff --check` |
| Go | `mise exec -- go test ./...`；并发、会话或通道改动补充 `mise exec -- go test -race ./...` |
| 前端 | `make test-web`；布局和交互改动补充 `make test-browser`，核对受影响的桌面和手机场景 |
| Rust / C ABI | `make test-native` |
| 运维与配置 | `make test-operations` 与 `make verify` |
| GitHub 工作流 | 校验 YAML、检查权限与 Action SHA，等待实际 GitHub Actions 结果 |

首次浏览器验证先执行 `mise exec -- corepack pnpm --dir web exec playwright install chromium`。完整入口与专项前置条件见[测试说明](tests/README.md)。Windows 的文件权限遵循 ACL，Linux 的 POSIX 模式位断言不能直接替代 Windows 权限验收。

依赖变更要保留锁文件，并复核当前工具链清单的固定哈希；历史签名证据不改写。CI 和模拟测试不能替代真实设备、长稳或正式阶段门。

## Pull Request

1. 保持一个清晰目标，保留工作区中不属于本次任务的改动。
2. 标题描述结果，可使用 `feat:`、`fix:`、`docs:`、`test:` 或 `ci:`；正文遵循 PR 模板，说明问题、改后行为和实际验证结果。
3. 用户可见说明、注释与文档使用简体中文；标识符、命令、配置键、协议字段及工具语法保留原文。
4. UI 悬停不得造成位置、大小或间距变化；危险操作保留明确确认，授权由服务端复核。
5. 提交前检查差异，排除 `.env`、凭据、个人路径、屏幕内容、用户文件及构建产物。示例只用占位符。
6. 部署与实机操作写明适用范围、备份、健康检查和回滚；PR 检查本身不连接私人设备或执行部署。

提交的自有代码沿用 [MIT 协议](LICENSE)。包含第三方代码、补丁或资源时说明来源及许可证；不要求额外签署 CLA，也不承诺未经维护者确认的合并或响应期限。

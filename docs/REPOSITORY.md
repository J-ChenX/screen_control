# GitHub 仓库维护

本页记录仓库协作配置、验证方法和需要在 GitHub 管理端单独核对的设置，不宣称项目已经通过生产或安全认证。

## 文件级建设

| 入口 | 用途 |
| --- | --- |
| [README](../README.md)、[使用指南](USAGE.md)、[文档导航](README.md) | 项目概览、快速开始、实际能力与详细使用说明 |
| [贡献指南](../CONTRIBUTING.md)、[支持说明](../SUPPORT.md)、[行为准则](../CODE_OF_CONDUCT.md) | 开发流程、反馈分类和协作约定 |
| [安全政策](../SECURITY.md) | 私密漏洞报告、维护范围和安全边界 |
| [Issue 表单](../.github/ISSUE_TEMPLATE/)、[PR 模板](../.github/PULL_REQUEST_TEMPLATE.md) | 提供复现、验收、验证和回滚信息，不预设不存在的标签 |
| [CODEOWNERS](../.github/CODEOWNERS) | 默认代码审查责任人；强制审查仍依赖分支规则 |
| [Dependabot](../.github/dependabot.yml) | Actions 每周、Go/前端/Rust 每月提出有限数量的依赖更新 PR，不自动合并 |
| [变更记录](../CHANGELOG.md)、[路线图](ROADMAP.md) | 追溯已有变化，区分当前桥接与生产规划 |

依赖提议不等于批准升级。维护者须核对工具链、清单固定哈希、第三方许可和相关回归；只刷新当前适用清单，不改写历史签名证据。

## 自动检查

[CI](../.github/workflows/ci.yml)在 PR、`main` 推送和手动触发时运行，保留现有跨平台矩阵。只读 `contents` 权限、完整 Action SHA、关闭 checkout 凭据保留、作业超时和 PR 并发取消共同限制不必要的授权与资源占用。

- Go：生产版本 Linux/Windows、下一兼容版本 Linux，全包测试、`go vet`、Linux 竞态检查与两个可执行入口的构建。
- Rust：Linux/Windows 格式、测试、Clippy 和静态库，Linux 补充 C ABI sanitizer。
- 前端：先安装固定 Node/pnpm，再按锁文件安装依赖，执行类型检查、测试、构建和六项隔离 Chromium 场景。关闭依赖未安装时会调用 pnpm 的 setup-node 缓存初始化。
- 运维：Python 回归、当前工具链清单、bootstrap 场景 dry-run 与 MeshCentral 静态配置校验。
- 工作流：Linux Go 作业使用固定 actionlint 版本检查工作流结构与表达式。

[CodeQL](../.github/workflows/codeql.yml)单独分析 Go、JavaScript/TypeScript、Python 与 GitHub Actions。Go 使用固定工具链和显式构建，不运行部署目标；只有扫描作业获得 `security-events: write` 用于上传结果。该配置不宣称覆盖所有 Rust、C/C++、第三方上游或实机权限问题。

两份工作流均使用普通 `pull_request`，不在特权上下文 checkout 外部 PR，不访问私人环境。检查结果以实际 GitHub run 为准；成功上传扫描结果不等于没有漏洞，告警仍需逐项核查。

## GitHub 管理端核对

2026-10-08 初始检查：仓库公开，Issues 可用，社区健康分数 42%；没有贡献、安全、行为准则、Issue 或 PR 模板，`main` 未受保护且无规则集，仓库简介过短、topics 为空。秘密扫描与 push protection 已启用；私密漏洞报告和 Dependabot 安全更新初始关闭。社区健康分数只反映部分协作文件，不能作为安全评分。

仓库文件在合并到默认分支后才作为默认社区入口生效。维护者应确认：

1. **简介与 topics**：准确描述私人 Tailscale 远控及文件桥接；不发布私人部署地址或虚构官网。
2. **私密漏洞报告与依赖告警**：启用报告入口和 Dependabot alerts；依赖安全更新通过 PR 复核，不自动合并。
3. **分支规则**：建议对 `main` 要求 PR 和相关 CI 检查，禁止强推和删除。仓库为个人维护，是否强制他人审批、管理员是否绕过，应按实际协作方式决定；本次不自动变更合并权限。
4. **Actions**：建议管理端也要求完整 SHA，限制可用 Action。启用后须核对现有固定引用及维护流程。
5. **发布**：建立真实 release 时再附适用提交、目标平台、摘要、SBOM、来源证明与回滚说明；当前不创建虚构稳定版本或改写历史工件。

没有 Discussions、资助入口、自动关闭 Issue 或英文副本不构成缺陷；按实际维护需求启用，避免无用入口和重复文档。

## 本地检查与维护

```bash
git diff --check
make test-operations
make verify
mise exec -- go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck= -pyflakes= .github/workflows/ci.yml .github/workflows/codeql.yml
```

actionlint 使用固定工具版本，只检查工作流，不修改应用依赖。YAML 和文档变动还须检查表单字段唯一性、本地链接与使用说明的相对路径；行为或构建矩阵发生变化时执行受影响检查。发布前查看 GitHub 实际 CI / CodeQL 结果，不把本地通过写成远端通过。

## 依据

- [GitHub 社区健康文件](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
- [GitHub Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)
- [Dependabot 配置参考](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [CodeQL 高级配置](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)
- [CodeQL 编译语言构建模式](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages)

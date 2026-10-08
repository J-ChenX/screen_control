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

[CI](../.github/workflows/ci.yml)是唯一自建工作流入口，将构建、测试与 CodeQL 集中到同一个流程。Linux 统一使用 `ubuntu-22.04`，Windows 保留 `windows-2025`；不建立 Ubuntu 小版本矩阵。托管 runner 的内核和软件包会更新，该标签不能代替真实设备的环境快照或实机验收。

| 触发与变更 | 实际运行范围 |
| --- | --- |
| PR 仅修改 Markdown、许可证、CODEOWNERS 或 Issue 表单 | 变更与文档轻量检查；不编译、不启动浏览器、不运行 CodeQL |
| PR 修改 Go 源码 | Go Linux/Windows、Linux 竞态与相关 Go CodeQL |
| PR 修改前端或浏览器场景 | 前端测试、类型检查、构建、七项隔离浏览器回归及相关 CodeQL |
| PR 修改 Rust / C ABI | Linux/Windows 原生检查及 Linux C ABI sanitizer |
| PR 修改运维或部署实现 | 运维回归与静态校验，Python/JS 改动追加对应 CodeQL |
| PR 修改应用锁文件或清单 | 对应模块检查，并校验当前工具链固定哈希 |
| PR 修改工作流、CI 范围判断、共享构建配置，或范围无法确定 | 保守运行全量，Go 下一兼容版本仍留给主分支或手动检查 |
| `main` 推送或手动触发 | 全量构建、测试、四语言 CodeQL 和 Go 下一兼容版本 |

[范围判断脚本](../ops/ci/plan.py)仅使用 Python 标准库与 Git 提交差异，包含删除和重命名两侧路径；未知文件不会静默跳过。轻量入口每次执行范围选择回归、可确定提交差异的 `git diff --check`，并核对本次修改 Markdown 的本地链接路径。文档检查不执行代码示例，不访问外部链接，也不验证锚点。

各检查的职责保留：

- Go 生产版本在 Linux/Windows 执行全包测试、`go vet` 和两个可执行入口构建；Linux 补充竞态和固定 actionlint。下一兼容版本只在主分支/手动执行测试与构建。
- Rust 在 Linux/Windows 执行测试、Clippy 和静态库构建；格式检查与 C ABI sanitizer 在 Linux 执行。
- 前端先安装固定 Node/pnpm 和锁文件依赖，执行测试、构建与浏览器回归。`build` 已包含 TypeScript 检查，CI 不重复执行 `tsc`；本地 `make test-web` 保持原入口。
- 运维执行 Python 回归、工具链清单、bootstrap dry-run 和 MeshCentral 静态配置校验。
- CodeQL 对 PR 按相关语言分析，主分支/手动运行 Go、JavaScript/TypeScript、Python 与 Actions。Go 显式构建；仅扫描作业拥有 `security-events: write`。不宣称覆盖 Rust、C/C++、第三方上游或实机权限问题。

工作流始终接收普通 `pull_request`，通过作业条件跳过无关检查，避免在工作流层过滤后留下阻塞合并的 Pending 必需检查。仍使用只读权限、完整 Action SHA、关闭 checkout 凭据保留、超时与 PR 并发取消；不在特权上下文 checkout 外部 PR，不访问私人环境。

当前未修改分支保护。后续启用时须核对必需检查名称及作业跳过语义；CI / CodeQL 成功不等于正式生产验收或没有安全告警。

## GitHub 管理端核对

2026-10-08 初始检查：仓库公开，Issues 可用，社区健康分数 42%；没有贡献、安全、行为准则、Issue 或 PR 模板，`main` 未受保护且无规则集，仓库简介过短、topics 为空。秘密扫描与 push protection 已启用；私密漏洞报告和 Dependabot 安全更新初始关闭。社区健康分数只反映部分协作文件，不能作为安全评分。

同日已更新仓库简介与技术 topics，启用并复核私密漏洞报告、Dependabot alerts 和自动安全更新提议；秘密扫描与 push protection 继续启用。文件级建设通过独立 PR 交付，主分支状态及检查结果以 GitHub 为准。未修改仓库可见性、合并权限或私人环境服务。

仓库文件在合并到默认分支后才作为默认社区入口生效。维护者应确认：

1. **简介与 topics**：准确描述私人 Tailscale 远控及文件桥接；不发布私人部署地址或虚构官网。
2. **私密漏洞报告与依赖告警**：启用报告入口和 Dependabot alerts；依赖安全更新通过 PR 复核，不自动合并。
3. **分支规则**：建议对 `main` 要求 PR 和相关 CI 检查，禁止强推和删除。仓库为个人维护，是否强制他人审批、管理员是否绕过，应按实际协作方式决定；本次不自动变更合并权限。
4. **Actions**：建议管理端也要求完整 SHA，限制可用 Action。启用后须核对现有固定引用及维护流程。
5. **发布**：建立真实 release 时再附适用提交、目标平台、摘要、SBOM、来源证明与回滚说明；当前不创建虚构稳定版本或改写历史工件。

没有 Discussions、资助入口、自动关闭 Issue 或英文副本不构成缺陷；按实际维护需求启用，避免无用入口和重复文档。

## 本次检查发现的依赖告警

2026-10-08 启用 Dependabot alerts 后，仓库清单检出 7 项告警：1 项严重、5 项高危、1 项中危。它们在本次修改前已存在；下表记录当时 GitHub 给出的修复版本，不表示已经验证实际部署的可利用性。最新状态见[仓库依赖告警](https://github.com/J-ChenX/screen_control/security/dependabot)。

| 清单与依赖 | 告警 | 当时已公布的修复版本 |
| --- | --- | --- |
| `deploy/spike/meshcentral/package-lock.json`：`proxy-addr` | 严重，IPv4-mapped IPv6 信任子网中的来源 IP 伪造 | `2.0.8`，见[告警 6](https://github.com/J-ChenX/screen_control/security/dependabot/6) |
| 同上：`compression` | 高危，响应提前关闭导致内存泄漏与拒绝服务 | `1.8.2`，见[告警 5](https://github.com/J-ChenX/screen_control/security/dependabot/5) |
| 同上：`node-forge` | 高危，RSA PKCS#1 v1.5 签名验证接受异常嵌套结构 | 尚无已公布修复版本，见[告警 4](https://github.com/J-ChenX/screen_control/security/dependabot/4) |
| 同上：`brace-expansion` | 两项高危递归拒绝服务、一项中危 CPU 拒绝服务 | 同时覆盖当时三个范围需 `2.1.7`；见[告警 1](https://github.com/J-ChenX/screen_control/security/dependabot/1)、[2](https://github.com/J-ChenX/screen_control/security/dependabot/2)、[3](https://github.com/J-ChenX/screen_control/security/dependabot/3) |
| `web/pnpm-lock.yaml`：`source-map-js`（开发依赖） | 高危，索引 source map 偏移导致事件循环拒绝服务 | `1.2.2`，见[告警 7](https://github.com/J-ChenX/screen_control/security/dependabot/7) |

本次仓库建设没有升级应用或上游依赖。[项目约束](../AGENTS.md)第 4 节要求未经本次需求要求不升级依赖；MeshCentral 尖峰还在当前桥接链路使用，不能因目录名含 `spike` 忽略其告警。修复需要另行明确升级范围，核对上游支持、当前锁文件与固定哈希，运行相关测试，并按既有流程准备实际部署、备份和回滚。没有修复版本的 `node-forge` 需追踪上游处理及适用调用路径；不通过隐藏或忽略告警宣称安全通过。

## 本地检查与维护

```bash
git diff --check
make test-operations
make verify
mise exec -- go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck= -pyflakes= .github/workflows/ci.yml
```

actionlint 使用固定工具版本，只检查工作流，不修改应用依赖。YAML 和文档变动还须检查表单字段唯一性、本地链接与使用说明的相对路径；行为或构建矩阵发生变化时执行受影响检查。发布前查看 GitHub 实际 CI / CodeQL 结果，不把本地通过写成远端通过。

## 依据

- [GitHub 社区健康文件](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
- [GitHub Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)
- [Dependabot 配置参考](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [CodeQL 高级配置](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configuring-advanced-setup-for-code-scanning)
- [CodeQL 编译语言构建模式](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages)

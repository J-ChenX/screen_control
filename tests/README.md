# 测试与流程维护

## 当前运行链路

日常构建入口为根目录 `Makefile`：`build-web` 构建门户，`build` 再构建两个 Go 可执行文件，`bundle` 打包既有套件。部署仍使用 `deploy/g0/suite/`、`deploy/g0/files/` 和可选 `deploy/gateway/`。`deploy/spike/meshcentral/` 虽名为尖峰，仍被当前 G0 门户、Dockerfile、Compose 和 `make mesh-config` 使用，不能当作废弃流程删除。

Rust 是独立候选：`native/protocol-core` 处理纯协议与图像边界，`native/protocol-ffi` 提供 C ABI；`deploy/g0/meshagent/rust-native/build.py` 负责固定上游源码、补丁和构建。Python 负责调用编译器与验证外部进程，未被 Rust 核心替代。生产代理替换仍须完成候选文档所列验证，本次整理不推进任何验收门。

## 本地与 CI 入口

以下命令在仓库根目录执行，先运行 `make setup`。Python、C 编译器等宿主工具遵循[工具链清单](../deploy/releases/current/toolchain.lock.json)。

| 入口 | 职责 | 是否操作真实设备 |
| --- | --- | --- |
| `make test-native` | Rust 格式、测试、Clippy、静态库及隔离 C ABI 检查 | 否 |
| `make test-operations` | 自动发现 `operations/test_*.py`，检查运维脚本与配置 | 默认否；显式启用的 systemd 专项另行隔离 |
| `make test-go` | Go 全包测试和竞态检查 | 否 |
| `make test-web` | Vitest 与 TypeScript 类型检查 | 否 |
| `make test` | 汇总上述四组 | 同各组边界 |
| `make test-browser` | 构建前端，使用临时端口运行六项模拟浏览器回归 | 否，预览不加载私有配置或代理 API 到真实后端 |
| `make verify` | 工具链哈希、验证场景、MeshCentral 静态配置 | 否 |

首次运行浏览器检查前安装锁定浏览器：

```bash
mise exec -- corepack pnpm --dir web exec playwright install chromium
make test-browser
```

已有当前前端构建时可只运行特定场景：

```bash
mise exec -- node tests/browser/run.mjs desktop-files desktop-lock-exit
```

六个名称为 `files`、`transfer-window`、`directory-performance`、`desktop-files`、`desktop-lock-exit`、`desktop-performance`，分别覆盖文件交互、传输兼容、大目录、控屏文件弹窗、锁屏确认和画质切换。保留每个脚本的直接调用方式，但必须显式传入本机静态预览 origin，不再内置各不相同的端口。`files` 在映射到回环地址的 `screen-control.test` 验证非安全上下文，OPFS 专项在回环安全上下文中运行。

浏览器启动统一在 `support/browser.mjs`；默认使用锁定 Playwright 配套 Chromium。`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 仅用于明确选择其他浏览器的对照，不能冒充锁定工具链验收。整组执行的合成页面截图存入 `web/test-results/browser-*`，失败时保留；直接执行使用 `web/test-results/browser`，也可设置 `SCREEN_CONTROL_TEST_OUTPUT`。这些路径受 Git 忽略，不写入历史验收证据。

## GitHub 检查与跨平台范围

CI 对 Go 增加 `go vet` 与两个可执行入口构建，使用固定 actionlint 校验工作流；前端先安装固定 pnpm，再安装依赖，避免缓存初始化早于 pnpm。CodeQL 单独检查 Go、JavaScript/TypeScript、Python 与 Actions，结果和未覆盖范围见[仓库维护说明](../docs/REPOSITORY.md)。

Windows 文件权限基于 ACL；共享测试继续验证内容、原子发布和权限保持，但只在支持的平台断言 POSIX `0600`。目录打开测试核对实际目录身份，兼容 Windows 临时路径大小写规范化；这不代替 Windows ACL 实机验收。加密备份回归使用隔离的 `GNUPGHOME` 并清理其 agent，不依赖 runner 或开发者原有 GnuPG 配置。

## 保留的专项脚本

这些入口与上述本地检查有不同前置条件，不能因为未进入默认测试就判定过时，也不能用模拟回归替代实机结果。

| 目录或入口 | 用途与前置条件 |
| --- | --- |
| `browser/gateway_smoke.py` | `make build` 后启动本机临时 HTTPS 网关，再调用 `gateway-smoke.mjs` 检查登录、模拟桌面重连和退出；只用临时密钥，不修改系统信任库 |
| `browser/desktop_keyboard.mjs` | 显式传入固定 MeshCentral `agent-desktop.js`，在 Node VM 验证键盘编码；不发送远程输入 |
| `performance/desktop-*.mjs` | 实机测量、资源释放和恢复专项；需明确可信门户与登记目标。其中 `desktop-session-live.mjs` 显式发送一次 Ctrl 按下/释放，其余被动探针不发送输入；保留各自断言及普通会话清理 |
| `performance/file-transfer.mjs` | 使用本地文件进程和临时数据测量确认等待对吞吐的影响 |
| `performance/file-worker-live.mjs`、`file-worker-local-peak.py` | 同一文件协议探针的远端/本地模式与本地峰值内存包装；不是两套文件实现 |
| `performance/files-browser-*.mjs` | 分别验证跨设备复制和本机浏览器上传/下载；需预先创建隔离目录 |
| `performance/*-memory*.py` | MeshAgent/SyncClipboard 的内存采样；具体参数与权限见各脚本和部署说明 |
| `native/` | Rust 与上游 C 的 ABI、图像、资源生命周期集成检查；使用独立候选源码/工件，真实 X11 专项需相应显示环境 |
| `operations/syncclipboard-*` | 固定 .NET 源码和实际安装依赖的剪贴板回归；不属于 Go 或 Rust 单元测试 |

原生光标的 `run_cursor_classification.py`、`run_cursor_state.py`、`run_x11_cursor_live.py` 分别检查识别、主循环状态和真实 XFixes 输入，覆盖层不同。候选构建和其余专项参数见[原生候选说明](../deploy/g0/meshagent/rust-native/README.md)；文件专项见[普通用户文件通道](../deploy/g0/files/README.md)，剪贴板专项见[通知连接恢复](../deploy/g0/suite/syncclipboard-latency/README.md)。

## 2026-09-29 清理依据

- 清理前提交 `e61fa53` 中，Rust 实现为 7 个文件、1,357 个物理行，另有 5 个测试文件、529 行；Python 共 47 个文件、5,975 行，其中 34 个文件位于 `tests/`。该口径不含依赖和生成物，不等同于 GitHub 按字节统计的语言占比。
- 两个 `.js` 管理包装文件均有实际调用方：`provision.js` 被 Compose 的账号初始化调用，`meshctrl-secret.js` 由镜像和管理说明使用，保留它们以延续现有凭据传递方式。
- 删除未被任何构建脚本引用、缺少完整释放证明的 `event-emitter-forward-ownership.patch`。当前候选使用后续弱状态实验；旧补丁仍可从 `e61fa53` 的原路径追溯，历史测量记录不改写。
- 删除 `test_rust_native.py` 中重复的 Rust 版本一致性检查，统一由 `test_toolchain_lock.py` 与生产校验器验证；保留构建拒绝无效源码和保护已有目录的回归。
- 合并 13 处浏览器启动配置；网关的 JS 场景从 Python 内嵌字符串移至独立文件，Python 继续承担临时 HTTPS 与后端进程生命周期。网关测试显式使用临时配置与模拟设备快照，避免继承真实后端配置和收藏路径。
- 文件回归的非安全测试域名由 Playwright 转取回环静态资源，避免依赖系统 DNS 或代理；控屏文件弹窗的旧尺寸断言按当前接近全宽的布局修正，继续检查留白和视口边界。
- 网关桌面模拟遵守连接回调可被清除的契约，修正停止阶段调用空回调导致重连检查失败的过时夹具。
- 补齐六项隔离浏览器回归的统一入口并接入 CI，删除文件回归中可提前成功退出、跳过其余断言的临时 `SCREEN_CONTROL_PREVIEW_ONLY` 分支。

后续清理先核对调用方与覆盖范围。名称含 `spike`、使用 Python/JS、仅由人工执行或未被具名引用，都不足以证明文件可以删除。已替代实验从当前目录移除并留下历史定位；有独立覆盖的回归继续保留。

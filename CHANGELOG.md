# 变更记录

本文件从仓库可追溯提交整理面向使用者的变化。项目尚未建立稳定发布系列；以下按日期和提交记录，不虚构版本号，不代替实机部署记录或正式验收。第三方组件与各设备运行状态仍以对应工件清单为准。

## 未发布

- 整理项目首页，将完整使用步骤集中到 `docs/USAGE.md`，补齐文档导航和实现边界路线图。
- 增加贡献、安全、支持、行为准则及 Issue / PR 模板和代码所有者入口。
- 增加 Dependabot 更新提议，完善 CI 初始化、安全限制和跨平台测试适配。

## 2026-10-07

- 控屏支持沉浸式全屏、触屏缩放和平移，并保留工具栏展开、适应尺寸与退出入口。
- 追溯：[ae4b76c](https://github.com/J-ChenX/screen_control/commit/ae4b76c63623a4e126db34776fc111586c034f57)。

## 2026-09-29

- 优化 Rust 分片分配与消息结束后的缓冲回收，修复 Linux 采集暂停。
- 整理 Rust 独立候选、浏览器回归与测试入口，优化远控及文件传输内存，修复剪贴板同步。
- 追溯：`96c642d`、`e61fa53`；范围与限制见 [Rust 实机记录](docs/performance/RUST_RUNTIME_20260929.md)及 [Ubuntu 更新记录](docs/performance/UBUNTU_RUST_RUNTIME_20260929.md)。

更早变化见 [Git 历史](https://github.com/J-ChenX/screen_control/commits/main/) 与对应 [性能记录](docs/performance/)。

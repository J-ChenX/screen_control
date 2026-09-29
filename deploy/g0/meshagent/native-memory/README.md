# 原生代理内存回收候选补丁（未部署）

两台已装 Linux MeshAgent 的 `-info` 均为提交 `62b206e0b485b296e8a73a6547cef02bbf5a2d62`，2026-02-15 构建。本候选只回移两项上游修复，不更换依赖与协议：

- https://github.com/Ylianst/MeshAgent/pull/406 ：取消连接时释放请求、WebSocket 分片、SNI 等资源，取消重复重连调度，并修正关联分配器记账与边界。
- https://github.com/Ylianst/MeshAgent/pull/415 ：子进程退出后及时回收失效对象，脚本堆增长后执行 GC，Linux/glibc 归还空闲页。

`native-memory-backport.patch` 是针对上述旧提交生成的统一补丁。上游线程清理分支在旧提交中带有 `__APPLE__ || ILIB_NO_TIMEDJOIN` 条件；回移保留旧平台选择，仅应用对应释放逻辑。

`native-memory-manifest.json` 保存源压缩包、补丁、候选二进制摘要与构建参数。Linux x64 构建通过，`-info` 与独立子进程冒烟测试通过；尚未完成真实代理身份、连接取消、跨平台和长期稳定性验收。不得因编译成功就替换已登记工件或修改其校验和。

此早期 C-only 候选不包含 Duktape 可读流指定 `unpipe` 的后继反向指针修复；旧二进制在连续移除多个管道时仍可错误投递数据。该修复已叠加到 Rust 隔离候选。此 C-only 工件不能作为当前生产崩溃的完整修复发布，且两类故障是否同因尚未证明。

## 重现构建

1. 下载固定提交源码压缩包：`https://codeload.github.com/Ylianst/MeshAgent/tar.gz/62b206e0b485b296e8a73a6547cef02bbf5a2d62`，校验 manifest 中的摘要。
2. 在隔离目录解压，运行 `patch --dry-run -p1 < native-memory-backport.patch`，确认全部适用后再执行 `patch -p1 < native-memory-backport.patch`。
3. 在源码目录运行 `make linux ARCHID=6 -j4`。需要编译器、X11/XTest/XRandR 开发头文件；依赖版本沿用源码自带静态库。
4. 源码压缩包没有 Git 元数据。候选构建使用明确的 `SOURCE_COMMIT_DATE` 和 `SOURCE_COMMIT_HASH` 标记（旧提交加 `+406+415`），不能将其标为上游原版。
5. 调试符号副本保留用于分配、释放和取消路径检查；测试只使用隔离目录，不使用生产 `.msh` 或 `.db` 启动第二份相同身份代理。

## 发布前仍需完成

- 对照证明旧版与候选在连接失败/取消、重复采样、控屏结束后，存活堆与原生缓冲是否回落；不能只比较 RSS 单点。
- 检查子进程退出时仍有管道缓冲/回调的场景，确认不会提前销毁仍在使用的资源。
- Linux 实机验证首次画面、流畅/原画质、断线重连及停止后的资源回收；Windows 单独构建与验证。
- 备份原二进制和固定摘要，沿用现有身份、地址限制与回滚流程；不取消校验或增加自动更新入口。
- 长期观测回收后基线、内存增长斜率和交互可用性。短测不构成 11 天故障的根治证明。

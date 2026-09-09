# 2026-09-08 验证与部署记录

> 公开版本已将实际地址与用户路径替换为配置变量/占位符；历史环境记录不表示当前部署配置。变量说明见根目录 `.env.example` 和 `docs/CONFIGURATION.md`。

已完成代码改造并部署到 echova 的原私有服务。公网网关默认关闭；没有创建 DNS、公网隧道或公网访问密钥，没有开放旧 G0 端口。

- `make test`：50 项 Python 运维测试、Go 测试及竞态检查、14 项前端测试、TypeScript 检查通过。
- `make verify`：锁定工具链、验证场景及 MeshCentral 静态配置检查通过。
- HTTPS 浏览器检查：实际登录、设备识别、退出和退出后 API 401 通过；以模拟桌面协议检查断线新建会话、主动结束后停止重试。
- Go HTTPS/WebSocket 集成测试：真实双向二进制转发、另一登录不能接管/结束会话、退出关闭活动 WebSocket 通过。
- 生产构建成功。Vite 对三个运行时提供的经典 MeshCentral 脚本提示不参与打包；这些脚本仍由受认证的同源 `/api/v1/vendor/` 提供。
- 新私有服务部署后，echova、nix、jiang-chenx 的身份接口均返回 HTTP 200 与正确设备 ID。
- 公网端口、真实异地代理网络、受控端中继回退及真实断线后的文件续传尚未验收。

当前发布目录：`$HOME/.local/lib/screen-control/releases/20260908T053554Z`。

本次部署前的服务单元与旧发布指针备份：`$HOME/.local/state/screen-control/before-gateway-20260908-133554/`。

下一步需要实际公网域名及隧道/服务器资源，按 README 创建 HTTPS 入口并从代理网络验证完整控屏链路。随机访问密钥授予设备标签的访问权，不构成物理设备绑定。

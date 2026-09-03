# Platform Agent — 安全

**最后更新：** 2026-09-03

## 核心不变量

- 文件代理进程永不以 root、SYSTEM 或管理员身份运行；安装器不得让运行身份漂移。
- 系统级 MeshAgent 不暴露文件、终端、PowerShell、命令、录制、共享链接和剪贴板能力。
- `screen-control-peer-helper` 只监听配置中本机 Tailscale 地址的专用文件 HTTPS 端口并把认证 stream 移交普通代理；启动后发现绑定、ACL 或防火墙漂移立即停止文件服务。
- 普通用户代理永不直接访问 tailscaled LocalAPI socket/命名管道。最小权限 peer helper 只能接受专用文件端口并查询它实际接受的 socket peer；不能接受调用方提供的任意 IP、读取其他 LocalAPI 资源或返回可复用 bearer 身份。
- capability 经受保护请求头传输，每请求和最终提交均重验真实 peer、来源、目标、动作、对象、父代次与期限。
- 路径策略只有一个 `SafeFS` 实现；浏览、搜索、上传、下载、移动、删除都必须经句柄契约。

## 对抗测试

覆盖 symlink/junction/reparse/mount 竞态、`/proc`/`/sys`/设备节点、Windows 保留设备名、跨卷替换、句柄换绑、重定向、伪造身份头、服务身份漂移及高权限句柄继承。另以普通用户和非代理进程验证无法打开 LocalAPI/peer-helper 管道，无法要求 helper 查询任意 IP，无法把一条连接的证明绑定到另一连接；helper 崩溃、LocalAPI 超时、签名代次变化、IPC ACL 漂移和证明重放均须使文件入口不可用。测试只用隔离目录。

helper 只降低 LocalAPI 暴露面，不能抵御已取得端点系统管理员权限的攻击者；该残余风险及端点失陷处置见[项目威胁模型](../../appendix/threat-model.md)。

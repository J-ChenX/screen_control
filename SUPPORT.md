# 使用支持与问题反馈

使用与配置从[项目首页](README.md)、[使用指南](docs/USAGE.md)和[配置指南](docs/CONFIGURATION.md)开始。此项目面向个人登记环境，尚无商业支持、响应 SLA 或适用于任意设备的一键安装承诺。

## 选择反馈入口

| 问题 | 入口 |
| --- | --- |
| 可复现缺陷 | [缺陷报告](https://github.com/J-ChenX/screen_control/issues/new?template=bug_report.yml) |
| 功能、交互与架构建议 | [功能建议](https://github.com/J-ChenX/screen_control/issues/new?template=feature_request.yml) |
| 安装、配置、使用问题或文档改进 | [使用与文档反馈](https://github.com/J-ChenX/screen_control/issues/new?template=help.yml) |
| 权限绕过、凭据泄漏等漏洞 | [私密安全报告](SECURITY.md) |

## 提交前准备

先搜索已有 Issue，记录 `git rev-parse --short HEAD` 和受影响组件，附上操作系统、浏览器、来源/目标角色及最小复现。工具链问题可附 `make doctor` 的版本结果；日志只截取脱敏片段，不发送完整环境变量、服务配置或诊断包。

部署问题先确认自己使用的是开发入口、统一套件还是可选 HTTPS 网关，并核对现有配置加载优先级。未知或失败的文件操作不要通过自动重试判断成功，先检查隔离测试目录中的实际状态。实机与性能专项须使用自己的登记设备、测试账号和合成文件，不能借测试操作他人的电脑或真实用户数据。

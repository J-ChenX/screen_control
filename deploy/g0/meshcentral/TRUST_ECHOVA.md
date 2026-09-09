# echova 上的 G0 浏览器信任配置

此信任锚仅用于让 `echova` 的浏览器验证私有 MeshCentral G0 源站。它不会使服务对外公开，也不得复制到无关设备。

MeshCentral 生成的根证书具有证书签名密钥，但缺少 `basicConstraints=CA:TRUE` 扩展，因此 Chromium 拒绝将其作为信任锚。已安装的浏览器信任锚复用相同的根公钥和完全一致的主体，由现有根密钥自签名，并添加关键的 CA 与基本密钥用途约束。私钥始终保留在隔离的 Docker 卷内。

`echova` 上的安装状态：

- 系统信任锚：`/usr/local/share/ca-certificates/screen-control-meshcentral-g0-root.crt`
- 用户 NSS 昵称：`screen-control-meshcentral-g0-root`
- 已审计的公开文件：`~/.local/state/screen-control/certs/`
- 证书 SHA-256 指纹：
  `54:DD:BD:93:F7:78:52:A6:47:62:BF:B2:63:A8:18:35:DD:09:F8:FF:77:5F:19:7C:8A:38:A1:F8:91:F9:AD:26`
- 公钥 SHA-256：
  `29d5a5c99932daab81c41704d43c93d2af19845d0e9b31c2cbee237a37c168c7`

系统和 NSS 验证均已通过，当前网页服务器证书也可通过此信任锚验证。首次安装后必须完全重启 Chromium，因为浏览器进程会缓存证书状态。

回滚仅限于本项目拥有的昵称和文件：

```bash
certutil -D -d sql:$HOME/.pki/nssdb -n screen-control-meshcentral-g0-root
sudo rm /usr/local/share/ca-certificates/screen-control-meshcentral-g0-root.crt
sudo update-ca-certificates --fresh
```

不要自动卸载 `libnss3-tools`，其他软件可能仍在使用它。已审计的公开文件只能在最终 G0 清理回执流程中删除。MeshCentral 数据卷及其私钥不属于本次回滚范围，必须遵循独立的 G0 控制面清理流程。

$ErrorActionPreference = "Stop"
$RemoteUrl = $env:SCREEN_CONTROL_CLIPBOARD_URL
if (-not $RemoteUrl) { throw "set SCREEN_CONTROL_CLIPBOARD_URL before migrating" }
$Config = if ($args.Count -gt 0) { $args[0] } else { Join-Path $env:APPDATA "SyncClipboard\SyncClipboard.json" }

if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    throw "未找到 SyncClipboard 配置：$Config"
}

$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$Backup = "$Config.before-tailscale.$Timestamp"
Copy-Item -LiteralPath $Config -Destination $Backup
$Document = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
foreach ($Account in $Document.SavedAccounts.SyncClipboard.PSObject.Properties) {
    $Account.Value.RemoteURL = $RemoteUrl
}
$Document | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Config -Encoding UTF8

Write-Host "SyncClipboard 地址已改为 $RemoteUrl"
Write-Host "备份位于 $Backup；请重启 SyncClipboard 客户端。"

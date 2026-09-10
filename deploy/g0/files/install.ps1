param([Parameter(Mandatory=$true)][string]$Binary)
$ErrorActionPreference = 'Stop'
# 以 SSH 登录账号执行，不创建 SYSTEM 服务。
$uid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($uid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw '文件进程必须以普通登录账号安装' }
$root = Join-Path $env:USERPROFILE '.local\lib\screen-control-files'
$id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + $PID
$release = Join-Path $root ('releases\' + $id)
New-Item -ItemType Directory -Path $release -Force | Out-Null
Copy-Item -LiteralPath $Binary -Destination (Join-Path $release 'screen-control-files.exe')
$current = Join-Path $root 'current'
$next = Join-Path $root 'current.next'
$previous = ''
if (Test-Path -LiteralPath $current) {
    $link = Get-Item -LiteralPath $current
    if ($link.LinkType -ne 'Junction') { throw '现有 current 不是文件进程目录联接，停止安装' }
    $previous = $link.Target[0]
}
$previous | Set-Content -LiteralPath (Join-Path $release 'previous') -Encoding UTF8
New-Item -ItemType Junction -Path $next -Target $release | Out-Null
if (Test-Path -LiteralPath $current) { cmd /c rmdir "`"$current`""; if ($LASTEXITCODE -ne 0) { throw '无法切换文件进程目录' } }
Rename-Item -LiteralPath $next -NewName 'current'
Write-Output ('普通用户文件进程已安装：' + $id)

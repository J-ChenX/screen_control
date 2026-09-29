[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Arm", "Restore")]
    [string]$Mode,
    [string]$CandidatePath,
    [string]$CandidateSha256,
    [string]$BackupDir
)

$ErrorActionPreference = "Stop"
$Root = "C:\ProgramData\ScreenControl\MeshAgent"
$AgentPath = Join-Path $Root "meshagent.exe"
$GuardPath = Join-Path $Root "meshagent-guard.ps1"
$Watchdog = "Screen-Control-G0-MeshAgent-Watchdog"
$Rollback = "Screen-Control-Rust-MeshAgent-Canary-Rollback"
$OldSha256 = "07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7"
$ServiceName = "Mesh Agent"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "需要管理员令牌"
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Set-GuardHash([string]$From, [string]$To) {
    # 只替换 ASCII 哈希字节，保留已安装守护脚本的编码和其他内容。
    $bytes = [IO.File]::ReadAllBytes($GuardPath)
    $old = [Text.Encoding]::ASCII.GetBytes($From)
    $new = [Text.Encoding]::ASCII.GetBytes($To)
    $matches = 0
    for ($i = 0; $i -le $bytes.Length - $old.Length; $i++) {
        $same = $true
        for ($j = 0; $j -lt $old.Length; $j++) {
            if ($bytes[$i + $j] -ne $old[$j]) { $same = $false; break }
        }
        if ($same) {
            $matches++
            for ($j = 0; $j -lt $new.Length; $j++) { $bytes[$i + $j] = $new[$j] }
        }
    }
    if ($matches -ne 1) { throw "已安装守护脚本的预期哈希不唯一" }
    $next = "$GuardPath.canary-next"
    [IO.File]::WriteAllBytes($next, $bytes)
    Move-Item -LiteralPath $next -Destination $GuardPath -Force
}

function Stop-CurrentAgent {
    Stop-ScheduledTask -TaskName $Watchdog -ErrorAction SilentlyContinue
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(20)
    while (((Get-Service -Name $ServiceName).Status -ne "Stopped" -or
        (Get-ScheduledTask -TaskName $Watchdog).State -eq "Running") -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ((Get-Service -Name $ServiceName).Status -ne "Stopped" -or
        (Get-ScheduledTask -TaskName $Watchdog).State -eq "Running") { throw "代理或守护未停止" }
    # 服务退出后仍可能留下同路径子进程；它会锁住待恢复的 EXE。
    $residual = @(Get-CimInstance Win32_Process -Filter "Name='meshagent.exe'" |
        Where-Object { $_.ExecutablePath -ieq $AgentPath })
    foreach ($process in $residual) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $remaining = @(Get-CimInstance Win32_Process -Filter "Name='meshagent.exe'" |
            Where-Object { $_.ExecutablePath -ieq $AgentPath })
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "同路径代理子进程未退出"
}

function Start-GuardedAgent([string]$ExpectedSha256) {
    Start-ScheduledTask -TaskName $Watchdog
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Service -Name $ServiceName).Status -eq "Running" -and
            (Get-ScheduledTask -TaskName $Watchdog).State -eq "Running") {
            & $GuardPath -Mode Assert -ExpectedSha256 $ExpectedSha256 | Out-Null
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "受守护代理未在时限内启动"
}

function Restore-Agent([string]$Directory) {
    $savedAgent = Join-Path $Directory "meshagent.exe"
    $savedGuard = Join-Path $Directory "meshagent-guard.ps1"
    if (-not (Test-Path -LiteralPath $savedAgent -PathType Leaf) -or
        -not (Test-Path -LiteralPath $savedGuard -PathType Leaf) -or
        (Get-Sha256 $savedAgent) -ne $OldSha256) { throw "旧代理备份不完整" }
    Stop-CurrentAgent
    Copy-Item -LiteralPath $savedAgent -Destination $AgentPath -Force
    Copy-Item -LiteralPath $savedGuard -Destination $GuardPath -Force
    if ((Get-Sha256 $AgentPath) -ne $OldSha256 -or
        (Get-Sha256 $GuardPath) -ne (Get-Sha256 $savedGuard)) { throw "旧工件恢复摘要不符" }
    Start-GuardedAgent $OldSha256
    Unregister-ScheduledTask -TaskName $Rollback -Confirm:$false -ErrorAction SilentlyContinue
    [ordered]@{ status = "restored"; agentSha256 = Get-Sha256 $AgentPath;
        service = (Get-Service -Name $ServiceName).Status.ToString() } | ConvertTo-Json -Compress
}

if ($Mode -eq "Restore") {
    if (-not $BackupDir) { throw "需要备份目录" }
    Restore-Agent $BackupDir
    return
}

if (-not $CandidatePath -or $CandidateSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw "需要候选路径及 SHA-256"
}
$CandidateSha256 = $CandidateSha256.ToLowerInvariant()
if ((Get-Sha256 $AgentPath) -ne $OldSha256 -or
    (Get-Sha256 $CandidatePath) -ne $CandidateSha256) { throw "旧工件或候选摘要不符" }
if ((Get-Service -Name $ServiceName).Status -ne "Running" -or
    (Get-ScheduledTask -TaskName $Watchdog).State -ne "Running") { throw "旧代理基线未运行" }
& $GuardPath -Mode Assert -ExpectedSha256 $OldSha256 | Out-Null

if (Get-ScheduledTask -TaskName $Rollback -ErrorAction SilentlyContinue) {
    throw "已有候选回滚任务，拒绝叠加"
}
$BackupDir = Join-Path $Root ("canary-" + (Get-Date -Format "yyyyMMddTHHmmss") + "-" +
    [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $BackupDir -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $AgentPath -Destination (Join-Path $BackupDir "meshagent.exe")
Copy-Item -LiteralPath $GuardPath -Destination (Join-Path $BackupDir "meshagent-guard.ps1")
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $BackupDir "windows-canary.ps1")
if ((Get-Sha256 (Join-Path $BackupDir "meshagent.exe")) -ne $OldSha256) { throw "备份摘要不符" }

$restoreScript = Join-Path $BackupDir "windows-canary.ps1"
$restoreArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$restoreScript`" -Mode Restore -BackupDir `"$BackupDir`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $restoreArgs
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(6)
Register-ScheduledTask -TaskName $Rollback -Action $action -Trigger $trigger `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null

try {
    Stop-CurrentAgent
    foreach ($name in @("MeshAgent.msh", "MeshAgent.db")) {
        $source = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "代理身份文件缺失" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $BackupDir $name)
        if ((Get-Sha256 $source) -ne (Get-Sha256 (Join-Path $BackupDir $name))) {
            throw "代理身份文件备份摘要不符"
        }
    }
    Copy-Item -LiteralPath $CandidatePath -Destination $AgentPath -Force
    Set-GuardHash $OldSha256 $CandidateSha256
    if ((Get-Sha256 $AgentPath) -ne $CandidateSha256) { throw "候选工件复制后摘要不符" }
    Start-GuardedAgent $CandidateSha256
    [ordered]@{ status = "armed"; backupDir = $BackupDir; agentSha256 = Get-Sha256 $AgentPath;
        service = (Get-Service -Name $ServiceName).Status.ToString(); rollbackTask = $Rollback } |
        ConvertTo-Json -Compress
} catch {
    $original = $_
    try { Restore-Agent $BackupDir | Out-Null } catch {
        Write-Warning "即时回滚失败；独立 SYSTEM 回滚任务仍已设置：$($_.Exception.Message)"
    }
    throw $original
}

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Arm", "Restore", "Retain")]
    [string]$Mode,
    [string]$CandidatePath,
    [string]$CandidateSha256,
    [string]$BackupDir,
    [string]$BuildManifest,
    [switch]$Automatic
)

$ErrorActionPreference = "Stop"
$Root = "C:\ProgramData\ScreenControl\MeshAgent"
$AgentPath = Join-Path $Root "meshagent.exe"
$GuardPath = Join-Path $Root "meshagent-guard.ps1"
$Watchdog = "Screen-Control-G0-MeshAgent-Watchdog"
$Rollback = "Screen-Control-Rust-MeshAgent-Canary-Rollback"
$OldSha256 = "07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7"
$ServiceName = "Mesh Agent"
$ReceiptPath = Join-Path $Root "rust-runtime.json"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "需要管理员令牌"
}

# 自动回滚和保留操作共用锁，避免定时任务在检查后切回旧版。
$mutex = New-Object System.Threading.Mutex($false, "Global\ScreenControlRustAgentUpdate")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "另一个代理版本操作尚未完成" }

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
    if (Test-Path -LiteralPath $ReceiptPath) {
        $receipt = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($receipt.backupDir -eq $Directory) { Remove-Item -LiteralPath $ReceiptPath }
    }
    Unregister-ScheduledTask -TaskName $Rollback -Confirm:$false -ErrorAction SilentlyContinue
    [ordered]@{ status = "restored"; agentSha256 = Get-Sha256 $AgentPath;
        service = (Get-Service -Name $ServiceName).Status.ToString() } | ConvertTo-Json -Compress
}

if ($Mode -eq "Restore") {
    if (-not $BackupDir) { throw "需要备份目录" }
    if ($Automatic -and (Test-Path -LiteralPath $ReceiptPath)) {
        # 任务可能在 Retain 注销前已启动并等待锁；此时不能再撤回已保留的同一版本。
        $retained = $null
        try { $retained = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
        if ($retained -and $retained.backupDir -eq $BackupDir -and
            $retained.status -eq "retained-for-observation" -and
            (Get-Sha256 $AgentPath) -eq $retained.agentSha256) {
            [ordered]@{ status = "already-retained" } | ConvertTo-Json -Compress
            return
        }
    }
    Restore-Agent $BackupDir
    return
}

if ($Mode -eq "Retain") {
    # Retain 由完成实机会话及回滚演练的操作者显式调用；不把服务运行当作验收。
    if (-not $BackupDir -or -not $BuildManifest -or $CandidateSha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "保留版本需要备份目录、构建清单及候选摘要"
    }
    $CandidateSha256 = $CandidateSha256.ToLowerInvariant()
    $build = Get-Content -LiteralPath $BuildManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($build.status -ne "built-windows-not-deployed" -or
        $build.windowsBuild.serviceSha256 -ne $CandidateSha256 -or
        (Get-Sha256 (Join-Path $BackupDir "meshagent.exe")) -ne $OldSha256 -or
        -not (Test-Path -LiteralPath (Join-Path $BackupDir "meshagent-guard.ps1")) -or
        (Get-Sha256 $AgentPath) -ne $CandidateSha256) { throw "运行工件、构建清单或回滚备份不一致" }
    $task = Get-ScheduledTask -TaskName $Rollback -ErrorAction Stop
    if (@($task.Actions).Count -ne 1 -or
        -not $task.Actions[0].Arguments.Contains('"' + $BackupDir + '"')) { throw "回滚任务不属于此备份" }
    if ((Get-Service -Name $ServiceName).Status -ne "Running" -or
        (Get-ScheduledTask -TaskName $Watchdog).State -ne "Running") { throw "受守护代理不健康" }
    & $GuardPath -Mode Assert -ExpectedSha256 $CandidateSha256 | Out-Null
    # 凭据原子落盘是保留提交点；此前始终保留独立自动回滚，写入失败不撤销它。
    $nextReceipt = "$ReceiptPath.next"
    [ordered]@{ status = "retained-for-observation"; agentSha256 = $CandidateSha256;
        previousSha256 = $OldSha256; backupDir = $BackupDir;
        buildManifestSha256 = Get-Sha256 $BuildManifest;
        rustLibrarySha256 = $build.windowsMsvcLibrarySha256;
        retainedUtc = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $nextReceipt -Encoding UTF8
    if (Test-Path -LiteralPath $ReceiptPath) {
        [IO.File]::Replace($nextReceipt, $ReceiptPath, $null)
    } else {
        [IO.File]::Move($nextReceipt, $ReceiptPath)
    }
    try {
        Unregister-ScheduledTask -TaskName $Rollback -Confirm:$false -ErrorAction Stop
    } catch {
        # 已提交保留；仍在排队的任务会读取同一凭据，不能再与提交状态相反地恢复。
        Write-Warning "版本已保留，回滚计划任务待清理；自动任务会核对保留凭据后退出"
    }
    [ordered]@{ status = "retained-for-observation"; agentSha256 = Get-Sha256 $AgentPath;
        service = (Get-Service -Name $ServiceName).Status.ToString() } | ConvertTo-Json -Compress
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
$restoreArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$restoreScript`" -Mode Restore -Automatic -BackupDir `"$BackupDir`""
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
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

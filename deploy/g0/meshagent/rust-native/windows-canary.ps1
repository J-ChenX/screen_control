[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Arm", "Restore", "Retain")]
    [string]$Mode,
    [string]$CandidatePath,
    [string]$CandidateSha256,
    [string]$ExpectedPreviousSha256,
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
$ServiceName = "Mesh Agent"
$ReceiptPath = Join-Path $Root "rust-runtime.json"
$ActivePath = Join-Path $Root "rust-canary-active.json"
$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "需要管理员令牌"
}

# 所有模式共用锁；事务标记另外阻止上一轮已排队的自动任务撤回新一轮版本。
$mutex = New-Object System.Threading.Mutex($false, "Global\ScreenControlRustAgentUpdate")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(60000) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw "另一个代理版本操作尚未完成" }
    if ($Automatic -and $Mode -ne "Restore") { throw "Automatic 仅用于自动 Restore" }

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Write-AtomicBytes([string]$Path, [byte[]]$Bytes) {
    $next = "$Path.next"
    [IO.File]::WriteAllBytes($next, $Bytes)
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($next, $Path, [NullString]::Value) }
    else { [IO.File]::Move($next, $Path) }
}

function Write-AtomicJson([string]$Path, $Value) {
    $text = ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    $encoding = New-Object Text.UTF8Encoding($false)
    Write-AtomicBytes $Path $encoding.GetBytes($text)
}

function Read-Json([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Read-Active {
    if (Test-Path -LiteralPath $ActivePath) { return Read-Json $ActivePath }
    return $null
}

function Remove-OwnedActive($Transaction) {
    $active = Read-Active
    if ($active -and $active.transactionId -eq $Transaction.transactionId -and
        $active.backupDir -eq $Transaction.backupDir) {
        Remove-Item -LiteralPath $ActivePath -ErrorAction Stop
    }
}

function Get-GuardBytes([byte[]]$Bytes, [string]$From, [string]$To) {
    # 只替换唯一 ASCII 哈希，保持已安装守护脚本的编码和其他内容。
    $old = [Text.Encoding]::ASCII.GetBytes($From)
    $new = [Text.Encoding]::ASCII.GetBytes($To)
    $matches = 0
    for ($i = 0; $i -le $Bytes.Length - $old.Length; $i++) {
        $same = $true
        for ($j = 0; $j -lt $old.Length; $j++) {
            if ($Bytes[$i + $j] -ne $old[$j]) { $same = $false; break }
        }
        if ($same) {
            $matches++
            for ($j = 0; $j -lt $new.Length; $j++) { $Bytes[$i + $j] = $new[$j] }
        }
    }
    if ($matches -ne 1) { throw "已安装守护脚本的预期哈希不唯一" }
    return ,$Bytes
}

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-RestoreArguments([string]$Directory) {
    $restoreScript = Join-Path $Directory "windows-canary.ps1"
    return "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$restoreScript`" -Mode Restore -Automatic -BackupDir `"$Directory`""
}

function Test-OwnedTask($Task, $Transaction) {
    return ($Task -and @($Task.Actions).Count -eq 1 -and
        $Task.Actions[0].Execute -ieq $PowerShellPath -and
        $Task.Actions[0].Arguments -ceq (Get-RestoreArguments $Transaction.backupDir))
}

function Assert-RollbackTask($Transaction) {
    $task = Get-ScheduledTask -TaskName $Rollback -ErrorAction Stop
    if (-not (Test-OwnedTask $task $Transaction)) { throw "回滚任务不属于此事务" }
    if ($task.Principal.UserId -notin @("SYSTEM", "NT AUTHORITY\SYSTEM", "S-1-5-18") -or
        $task.Principal.RunLevel.ToString() -notin @("Highest", "1") -or
        @($task.Triggers).Count -ne 1 -or -not $task.Triggers[0].Enabled -or
        -not $task.Settings.StartWhenAvailable -or $task.Settings.DisallowStartIfOnBatteries -or
        $task.Settings.StopIfGoingOnBatteries) { throw "独立 SYSTEM 回滚任务配置不符" }
    $due = [DateTime]::Parse($Transaction.rollbackDueUtc).ToUniversalTime()
    $actual = [DateTime]::Parse($task.Triggers[0].StartBoundary).ToUniversalTime()
    if ([Math]::Abs(($actual - $due).TotalSeconds) -gt 2) { throw "回滚触发时间不符" }
}

function Remove-OwnedTask($Transaction) {
    $task = Get-ScheduledTask -TaskName $Rollback -ErrorAction SilentlyContinue
    if (-not $task) { return }
    if (-not (Test-OwnedTask $task $Transaction)) { throw "拒绝注销其他事务的回滚任务" }
    Unregister-ScheduledTask -TaskName $Rollback -Confirm:$false -ErrorAction Stop
}

function Read-Transaction([string]$Directory, [switch]$RequireComplete) {
    $directoryPath = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\', '/'))
    $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $directoryPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "备份目录不属于固定代理目录"
    }
    $transaction = Read-Json (Join-Path $directoryPath "canary-manifest.json")
    if ($transaction.schemaVersion -ne 1 -or $transaction.transactionId -notmatch '^[a-f0-9]{32}$' -or
        $transaction.backupDir -ine $directoryPath -or
        $transaction.previousSha256 -notmatch '^[a-f0-9]{64}$' -or
        $transaction.candidateSha256 -notmatch '^[a-f0-9]{64}$' -or
        $transaction.candidateGuardSha256 -notmatch '^[a-f0-9]{64}$') { throw "回滚清单无效" }
    # 自动救援不依赖尚未完成的身份快照和候选构建清单，只核对恢复必需的备份。
    foreach ($name in @("meshagent.exe", "meshagent-guard.ps1", "windows-canary.ps1")) {
        $expected = $transaction.files.PSObject.Properties[$name].Value
        if ($expected -notmatch '^[a-f0-9]{64}$' -or
            (Get-Sha256 (Join-Path $directoryPath $name)) -ne $expected) { throw "回滚工件备份损坏：$name" }
    }
    if ($transaction.files.'meshagent.exe' -ne $transaction.previousSha256) { throw "旧代理备份摘要不符" }
    if ($transaction.previousReceiptPresent -isnot [bool]) { throw "原运行凭据状态无效" }
    if ($transaction.previousReceiptPresent -and
        (Get-Sha256 (Join-Path $directoryPath "rust-runtime.previous.json")) -ne $transaction.previousReceiptSha256) {
        throw "原运行凭据备份损坏"
    }
    if ($RequireComplete) {
        if (-not $transaction.identitySnapshotComplete) { throw "代理身份备份尚未完成" }
        foreach ($name in @("candidate.json", "MeshAgent.msh", "MeshAgent.db")) {
            $expected = $transaction.files.PSObject.Properties[$name].Value
            if ($expected -notmatch '^[a-f0-9]{64}$' -or
                (Get-Sha256 (Join-Path $directoryPath $name)) -ne $expected) { throw "完整备份损坏：$name" }
        }
    }
    return $transaction
}

function Test-PreviousReceipt($Transaction) {
    if (-not $Transaction.previousReceiptPresent) { return -not (Test-Path -LiteralPath $ReceiptPath) }
    return ((Test-Path -LiteralPath $ReceiptPath -PathType Leaf) -and
        (Get-Sha256 $ReceiptPath) -eq $Transaction.previousReceiptSha256)
}

function Test-RetainedReceipt($Transaction, [switch]$RequireCandidate) {
    if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { return $false }
    try { $receipt = Read-Json $ReceiptPath } catch { return $false }
    $retained = ($receipt.status -eq "retained-for-observation" -and
        $receipt.transactionId -eq $Transaction.transactionId -and
        $receipt.backupDir -eq $Transaction.backupDir -and
        $receipt.agentSha256 -eq $Transaction.candidateSha256)
    if ($RequireCandidate) {
        return ($retained -and (Test-Path -LiteralPath $AgentPath -PathType Leaf) -and
            (Get-Sha256 $AgentPath) -eq $Transaction.candidateSha256)
    }
    # 显式恢复只核对保留凭据的事务归属；已保留的 EXE 损坏时仍须允许救援。
    return $retained
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
    foreach ($process in $residual) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
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

function Restore-Agent($Transaction) {
    Stop-CurrentAgent
    Copy-Item -LiteralPath (Join-Path $Transaction.backupDir "meshagent.exe") -Destination $AgentPath -Force
    Copy-Item -LiteralPath (Join-Path $Transaction.backupDir "meshagent-guard.ps1") -Destination $GuardPath -Force
    if ((Get-Sha256 $AgentPath) -ne $Transaction.previousSha256 -or
        (Get-Sha256 $GuardPath) -ne $Transaction.files.'meshagent-guard.ps1') { throw "旧工件恢复摘要不符" }
    Start-GuardedAgent $Transaction.previousSha256
    if ($Transaction.previousReceiptPresent) {
        Write-AtomicBytes $ReceiptPath ([IO.File]::ReadAllBytes((Join-Path $Transaction.backupDir "rust-runtime.previous.json")))
    } elseif (Test-Path -LiteralPath $ReceiptPath) {
        Remove-Item -LiteralPath $ReceiptPath -ErrorAction Stop
    }
    if (-not (Test-PreviousReceipt $Transaction)) { throw "原运行凭据恢复摘要不符" }
    Remove-OwnedActive $Transaction
    try { Remove-OwnedTask $Transaction } catch { Write-Warning "旧工件已恢复，回滚任务待清理：$($_.Exception.Message)" }
    [ordered]@{ status = "restored"; transactionId = $Transaction.transactionId;
        agentSha256 = Get-Sha256 $AgentPath; service = (Get-Service -Name $ServiceName).Status.ToString() } |
        ConvertTo-Json -Compress
}

if ($Mode -in @("Restore", "Retain")) {
    if (-not $BackupDir) { throw "需要备份目录" }
    $transaction = Read-Transaction $BackupDir
    $active = Read-Active
    if ($Mode -eq "Restore") {
        if ($Automatic -and (Test-RetainedReceipt $transaction -RequireCandidate)) {
            [ordered]@{ status = "already-retained" } | ConvertTo-Json -Compress
            return
        }
        $owned = $active -and $active.transactionId -eq $transaction.transactionId -and
            $active.backupDir -eq $transaction.backupDir
        if ($Automatic -and -not $owned) {
            [ordered]@{ status = "inactive-transaction" } | ConvertTo-Json -Compress
            return
        }
        if (-not $Automatic -and -not $owned) {
            if ($active) { throw "另一个候选事务正在运行，拒绝恢复旧事务" }
            if (-not (Test-RetainedReceipt $transaction)) {
                if ((Test-Path -LiteralPath $AgentPath -PathType Leaf) -and
                    (Get-Sha256 $AgentPath) -eq $transaction.previousSha256 -and
                    (Get-Sha256 $GuardPath) -eq $transaction.files.'meshagent-guard.ps1' -and
                    (Test-PreviousReceipt $transaction)) {
                    if ((Get-Service -Name $ServiceName).Status -eq "Running" -and
                        (Get-ScheduledTask -TaskName $Watchdog).State -eq "Running") {
                        & $GuardPath -Mode Assert -ExpectedSha256 $transaction.previousSha256 | Out-Null
                        [ordered]@{ status = "already-restored" } | ConvertTo-Json -Compress
                    } else {
                        Restore-Agent $transaction
                    }
                    return
                }
                throw "当前运行状态不属于此备份"
            }
        }
        Restore-Agent $transaction
        return
    }

    # Retain 由操作者在实机会话及回滚演练后显式调用；服务运行本身不是验收。
    if (-not $BuildManifest -or $CandidateSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        -not $active -or $active.transactionId -ne $transaction.transactionId -or
        $active.backupDir -ne $transaction.backupDir) { throw "保留版本需要同一活动事务、构建清单及候选摘要" }
    $transaction = Read-Transaction $BackupDir -RequireComplete
    $CandidateSha256 = $CandidateSha256.ToLowerInvariant()
    if ($CandidateSha256 -ne $transaction.candidateSha256 -or
        (Get-Sha256 $BuildManifest) -ne $transaction.files.'candidate.json' -or
        (Get-Sha256 $AgentPath) -ne $CandidateSha256 -or
        (Get-Sha256 $GuardPath) -ne $transaction.candidateGuardSha256 -or
        -not (Test-PreviousReceipt $transaction)) { throw "运行工件、构建清单或原凭据不一致" }
    $build = Read-Json (Join-Path $transaction.backupDir "candidate.json")
    Assert-RollbackTask $transaction
    if ((Get-Service -Name $ServiceName).Status -ne "Running" -or
        (Get-ScheduledTask -TaskName $Watchdog).State -ne "Running") { throw "受守护代理不健康" }
    & $GuardPath -Mode Assert -ExpectedSha256 $CandidateSha256 | Out-Null
    # 原子凭据是保留提交点；提交前始终保留独立自动回滚。
    Write-AtomicJson $ReceiptPath ([ordered]@{
        status = "retained-for-observation"; transactionId = $transaction.transactionId;
        agentSha256 = $CandidateSha256; previousSha256 = $transaction.previousSha256;
        backupDir = $transaction.backupDir; buildManifestSha256 = $transaction.files.'candidate.json';
        rustLibrarySha256 = $build.windowsMsvcLibrarySha256; retainedUtc = [DateTime]::UtcNow.ToString("o")
    })
    try { Remove-OwnedActive $transaction } catch { Write-Warning "版本已保留，活动事务标记待清理" }
    try { Remove-OwnedTask $transaction } catch {
        Write-Warning "版本已保留，回滚计划任务待清理；自动任务会核对保留凭据后退出"
    }
    [ordered]@{ status = "retained-for-observation"; transactionId = $transaction.transactionId;
        agentSha256 = Get-Sha256 $AgentPath; service = (Get-Service -Name $ServiceName).Status.ToString() } |
        ConvertTo-Json -Compress
    return
}

if (-not $CandidatePath -or -not $BuildManifest -or
    $CandidateSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
    $ExpectedPreviousSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Arm 需要候选路径、构建清单、候选摘要及明确的旧工件摘要"
}
$CandidateSha256 = $CandidateSha256.ToLowerInvariant()
$ExpectedPreviousSha256 = $ExpectedPreviousSha256.ToLowerInvariant()
$buildHash = Get-Sha256 $BuildManifest
$build = Read-Json $BuildManifest
if ($build.status -ne "built-windows-not-deployed" -or
    $build.windowsBuild.serviceSha256 -ne $CandidateSha256 -or
    $build.windowsMsvcLibrarySha256 -notmatch '^[a-fA-F0-9]{64}$' -or
    $CandidateSha256 -eq $ExpectedPreviousSha256 -or
    (Get-Sha256 $AgentPath) -ne $ExpectedPreviousSha256 -or
    (Get-Sha256 $CandidatePath) -ne $CandidateSha256) { throw "旧工件、候选工件或构建清单不符" }
if ((Get-Service -Name $ServiceName).Status -ne "Running" -or
    (Get-ScheduledTask -TaskName $Watchdog).State -ne "Running") { throw "旧代理基线未运行" }
& $GuardPath -Mode Assert -ExpectedSha256 $ExpectedPreviousSha256 | Out-Null
if ((Read-Active) -or (Get-ScheduledTask -TaskName $Rollback -ErrorAction SilentlyContinue)) {
    throw "已有候选事务或回滚任务，拒绝叠加"
}
$nextGuardBytes = Get-GuardBytes ([IO.File]::ReadAllBytes($GuardPath)) $ExpectedPreviousSha256 $CandidateSha256
$BackupDir = Join-Path $Root ("canary-" + (Get-Date -Format "yyyyMMddTHHmmss") + "-" +
    [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $BackupDir -ErrorAction Stop | Out-Null
$files = [ordered]@{}
foreach ($entry in @(
    @{ source = $AgentPath; name = "meshagent.exe" },
    @{ source = $GuardPath; name = "meshagent-guard.ps1" },
    @{ source = $PSCommandPath; name = "windows-canary.ps1" },
    @{ source = $BuildManifest; name = "candidate.json" }
)) {
    $expected = Get-Sha256 $entry.source
    $destination = Join-Path $BackupDir $entry.name
    Copy-Item -LiteralPath $entry.source -Destination $destination
    if ((Get-Sha256 $destination) -ne $expected) { throw "备份摘要不符：$($entry.name)" }
    $files[$entry.name] = $expected
}
if ($files.'meshagent.exe' -ne $ExpectedPreviousSha256 -or $files.'candidate.json' -ne $buildHash) {
    throw "基线或构建清单在备份期间变化"
}
$receiptPresent = Test-Path -LiteralPath $ReceiptPath -PathType Leaf
$receiptHash = $null
if ($receiptPresent) {
    $receiptHash = Get-Sha256 $ReceiptPath
    Copy-Item -LiteralPath $ReceiptPath -Destination (Join-Path $BackupDir "rust-runtime.previous.json")
    if ((Get-Sha256 (Join-Path $BackupDir "rust-runtime.previous.json")) -ne $receiptHash) { throw "原运行凭据备份摘要不符" }
}
$nextGuardBytes = Get-GuardBytes ([IO.File]::ReadAllBytes((Join-Path $BackupDir "meshagent-guard.ps1"))) $ExpectedPreviousSha256 $CandidateSha256
$rollbackAt = (Get-Date).AddMinutes(6)
$transaction = [ordered]@{
    schemaVersion = 1; transactionId = [guid]::NewGuid().ToString("N"); backupDir = $BackupDir;
    previousSha256 = $ExpectedPreviousSha256; candidateSha256 = $CandidateSha256;
    candidateGuardSha256 = Get-BytesSha256 $nextGuardBytes; files = $files;
    previousReceiptPresent = [bool]$receiptPresent; previousReceiptSha256 = $receiptHash;
    identitySnapshotComplete = $false; rollbackDueUtc = $rollbackAt.ToUniversalTime().ToString("o")
}
$manifestPath = Join-Path $BackupDir "canary-manifest.json"
Write-AtomicJson $manifestPath $transaction
Write-AtomicJson $ActivePath ([ordered]@{ transactionId = $transaction.transactionId; backupDir = $BackupDir })
$agentMayHaveStopped = $false
try {
    $action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument (Get-RestoreArguments $BackupDir)
    $trigger = New-ScheduledTaskTrigger -Once -At $rollbackAt
    # 使用 Windows PowerShell 5 的 ScheduledTasks 参数，掉电源或错过触发时仍能救援。
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $Rollback -Action $action -Trigger $trigger -Settings $settings `
        -User "SYSTEM" -RunLevel Highest -Force | Out-Null
    Assert-RollbackTask $transaction
    # 独立任务与核心备份均已读回验证，才允许停止当前代理。
    $null = Read-Transaction $BackupDir
    $agentMayHaveStopped = $true
    Stop-CurrentAgent
    foreach ($name in @("MeshAgent.msh", "MeshAgent.db")) {
        $source = Join-Path $Root $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "代理身份文件缺失" }
        $expected = Get-Sha256 $source
        Copy-Item -LiteralPath $source -Destination (Join-Path $BackupDir $name)
        if ((Get-Sha256 (Join-Path $BackupDir $name)) -ne $expected) { throw "代理身份文件备份摘要不符" }
        $files[$name] = $expected
    }
    $transaction.identitySnapshotComplete = $true
    Write-AtomicJson $manifestPath $transaction
    if ((Get-Sha256 $AgentPath) -ne $ExpectedPreviousSha256 -or
        (Get-Sha256 $GuardPath) -ne $files.'meshagent-guard.ps1' -or
        -not (Test-PreviousReceipt $transaction)) { throw "停止期间基线工件或原凭据变化" }
    Copy-Item -LiteralPath $CandidatePath -Destination $AgentPath -Force
    Write-AtomicBytes $GuardPath $nextGuardBytes
    if ((Get-Sha256 $AgentPath) -ne $CandidateSha256 -or
        (Get-Sha256 $GuardPath) -ne $transaction.candidateGuardSha256) { throw "候选工件复制后摘要不符" }
    Start-GuardedAgent $CandidateSha256
    [ordered]@{ status = "armed"; transactionId = $transaction.transactionId; backupDir = $BackupDir;
        agentSha256 = Get-Sha256 $AgentPath; service = (Get-Service -Name $ServiceName).Status.ToString();
        rollbackTask = $Rollback } | ConvertTo-Json -Compress
} catch {
    $original = $_
    if ($agentMayHaveStopped) {
        try { Restore-Agent (Read-Transaction $BackupDir) | Out-Null } catch {
            Write-Warning "即时回滚失败；请检查独立 SYSTEM 回滚任务及备份：$($_.Exception.Message)"
        }
    } else {
        # 注册或读回失败时尚未停止代理；只清理本次事务，保持旧服务运行。
        try { Remove-OwnedActive $transaction; Remove-OwnedTask $transaction } catch {
            Write-Warning "未切换代理，本次事务清理待处理：$($_.Exception.Message)"
        }
    }
    throw $original
}
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

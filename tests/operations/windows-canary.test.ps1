[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CanaryScript)

# 只在自建目录运行改写路径的脚本；服务、计划任务与进程全部由假对象接管。
$ErrorActionPreference = "Stop"
$fixture = Join-Path $env:TEMP ("sc-canary-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixture | Out-Null
$sourceCode = Get-Content -LiteralPath $CanaryScript -Raw -Encoding UTF8
$global:SCFixture = $null
function Get-Service { param($Name) [pscustomobject]@{ Status = $global:SCFixture.service } }
function Stop-Service {
    param($Name, [switch]$Force, $ErrorAction)
    $global:SCFixture.stopCount++; $global:SCFixture.service = "Stopped"
}
function Get-CimInstance { param($ClassName, $Filter) return @() }
function Get-ScheduledTask {
    param($TaskName, $ErrorAction)
    if ($TaskName -like '*Watchdog') { return [pscustomobject]@{ State = $global:SCFixture.watchdog } }
    return $global:SCFixture.task
}
function Stop-ScheduledTask { param($TaskName, $ErrorAction) $global:SCFixture.watchdog = "Ready" }
function Start-ScheduledTask {
    param($TaskName)
    $agent = Join-Path $global:SCFixture.root "meshagent.exe"
    if ($global:SCFixture.failCandidateStart -and (Hash $agent) -eq $global:SCFixture.candidateHash) {
        $global:SCFixture.failCandidateStart = $false
        throw "模拟候选启动失败"
    }
    # 同时执行假守护的默认摘要检查，避免只验证 Assert 显式参数。
    & (Join-Path $global:SCFixture.root "meshagent-guard.ps1") -Mode Assert | Out-Null
    $global:SCFixture.watchdog = "Running"; $global:SCFixture.service = "Running"
}
function New-ScheduledTaskAction {
    param($Execute, $Argument)
    [pscustomobject]@{ Execute = $Execute; Arguments = $Argument }
}
function New-ScheduledTaskTrigger {
    param([switch]$Once, [datetime]$At)
    [pscustomobject]@{ StartBoundary = $At.ToString('o'); Enabled = $true }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries,
        [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit, $MultipleInstances)
    [pscustomobject]@{ StartWhenAvailable = [bool]$StartWhenAvailable;
        DisallowStartIfOnBatteries = -not $AllowStartIfOnBatteries;
        StopIfGoingOnBatteries = -not $DontStopIfGoingOnBatteries;
        ExecutionTimeLimit = $ExecutionTimeLimit; MultipleInstances = $MultipleInstances }
}
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Settings, $User, $RunLevel, [switch]$Force)
    if ($global:SCFixture.badRegistration) { $User = "other-user" }
    $global:SCFixture.task = [pscustomobject]@{ Actions = @($Action); Triggers = @($Trigger);
        Settings = $Settings; Principal = [pscustomobject]@{ UserId = $User; RunLevel = $RunLevel }; State = "Ready" }
}
function Unregister-ScheduledTask {
    param($TaskName, $Confirm, $ErrorAction)
    if ($global:SCFixture.failUnregister) { throw "模拟任务注销失败" }
    $global:SCFixture.task = $null
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected $Message
}
function Hash($Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Json($Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function New-Case([switch]$ExistingReceipt) {
    $directory = Join-Path $fixture ([guid]::NewGuid().ToString('N'))
    $root = Join-Path $directory "agent"
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $agent = Join-Path $root "meshagent.exe"
    $candidate = Join-Path $directory "candidate.exe"
    Set-Content -LiteralPath $agent -Value "old-binary"
    Set-Content -LiteralPath $candidate -Value "rust-binary"
    $old = Hash $agent; $new = Hash $candidate
    $guard = Join-Path $root "meshagent-guard.ps1"
    $guardCode = 'param($Mode,[string]$ExpectedSha256="' + $old + '")' + "`r`n" +
        '$actual=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot "meshagent.exe")).Hash.ToLowerInvariant()' + "`r`n" +
        'if($actual -ne $ExpectedSha256){throw "test guard hash mismatch"}'
    Set-Content -LiteralPath $guard -Value $guardCode -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $root "MeshAgent.msh") -Value "test-identity"
    Set-Content -LiteralPath (Join-Path $root "MeshAgent.db") -Value "test-database"
    $receipt = Join-Path $root "rust-runtime.json"
    if ($ExistingReceipt) {
        # 保留特殊空格和换行，以摘要证明恢复原始字节而非重新序列化。
        $previous = "{`r`n  `"status`": `"retained-for-observation`",`r`n  `"agentSha256`": `"$old`"`r`n}`r`n"
        [IO.File]::WriteAllBytes($receipt, [Text.Encoding]::UTF8.GetBytes($previous))
    }
    $manifest = Join-Path $directory "candidate.json"
    @{ status = "built-windows-not-deployed"; windowsBuild = @{ serviceSha256 = $new };
        windowsMsvcLibrarySha256 = ('a' * 64) } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
    $code = $sourceCode.Replace('C:\ProgramData\ScreenControl\MeshAgent', $root).
        Replace('Global\ScreenControlRustAgentUpdate', 'Local\SCFixture-' + [guid]::NewGuid().ToString('N'))
    $script = Join-Path $directory "canary.ps1"
    Set-Content -LiteralPath $script -Value $code -Encoding UTF8
    $global:SCFixture = @{ service = "Running"; watchdog = "Running"; task = $null;
        failUnregister = $false; failCandidateStart = $false; badRegistration = $false;
        stopCount = 0; root = $root; candidateHash = $new }
    return @{ root = $root; agent = $agent; candidate = $candidate; manifest = $manifest;
        script = $script; old = $old; new = $new; guard = $guard; guardHash = Hash $guard;
        receipt = $receipt; receiptHash = $(if ($ExistingReceipt) { Hash $receipt } else { $null });
        active = Join-Path $root "rust-canary-active.json" }
}
function Arm($Case) {
    return (& ($Case.script) -Mode Arm -CandidatePath $Case.candidate -CandidateSha256 $Case.new `
        -ExpectedPreviousSha256 $Case.old -BuildManifest $Case.manifest | ConvertFrom-Json)
}
function Retain($Case, $Armed) {
    return (& ($Case.script) -Mode Retain -BackupDir $Armed.backupDir -CandidateSha256 $Case.new `
        -BuildManifest $Case.manifest -WarningAction SilentlyContinue | ConvertFrom-Json)
}
function Assert-Baseline($Case) {
    Assert-True ((Hash $Case.agent) -eq $Case.old -and (Hash $Case.guard) -eq $Case.guardHash) "原工件或守护未恢复"
    if ($Case.receiptHash) { Assert-True ((Hash $Case.receipt) -eq $Case.receiptHash) "原凭据未按字节恢复" }
    else { Assert-True (-not (Test-Path -LiteralPath $Case.receipt)) "原先不存在的凭据未清理" }
    Assert-True (-not (Test-Path -LiteralPath $Case.active)) "恢复后活动事务未清理"
    Assert-True ($global:SCFixture.service -eq 'Running' -and $global:SCFixture.watchdog -eq 'Running') "旧代理未受守护运行"
}
try {
    # Arm 不再以替换源代码中的固定摘要模拟部署；显式摘要与构建清单都必须匹配。
    $case = New-Case -ExistingReceipt
    Assert-Rejected { & ($case.script) -Mode Arm -CandidatePath $case.candidate -CandidateSha256 $case.new -BuildManifest $case.manifest } "Arm 接受缺失旧摘要"
    Assert-Rejected { & ($case.script) -Mode Arm -CandidatePath $case.candidate -CandidateSha256 $case.new -ExpectedPreviousSha256 ('b' * 64) -BuildManifest $case.manifest } "Arm 接受错误旧摘要"
    $manifestBytes = [IO.File]::ReadAllBytes($case.manifest)
    @{ status = "built-windows-not-deployed"; windowsBuild = @{ serviceSha256 = ('b' * 64) };
        windowsMsvcLibrarySha256 = ('a' * 64) } | ConvertTo-Json | Set-Content -LiteralPath $case.manifest
    Assert-Rejected { Arm $case } "Arm 接受错误候选构建绑定"
    [IO.File]::WriteAllBytes($case.manifest, $manifestBytes)
    Assert-True ($global:SCFixture.stopCount -eq 0 -and -not $global:SCFixture.task -and -not (Test-Path $case.active)) "Arm 拒绝前触碰运行状态"

    # 原凭据存在/不存在时，提交失败均须保留可运行的自动回退，并保留当前身份数据库。
    foreach ($withReceipt in @($false, $true)) {
        $case = New-Case -ExistingReceipt:$withReceipt
        $armed = Arm $case
        Assert-True ((Hash $case.agent) -eq $case.new) "Arm 未切换工件"
        $backup = Json (Join-Path $armed.backupDir "canary-manifest.json")
        Assert-True ($backup.previousSha256 -eq $case.old -and $backup.identitySnapshotComplete) "备份清单未冻结旧摘要或完整快照"
        foreach ($name in @('meshagent.exe', 'meshagent-guard.ps1', 'windows-canary.ps1', 'candidate.json', 'MeshAgent.msh', 'MeshAgent.db')) {
            Assert-True ((Hash (Join-Path $armed.backupDir $name)) -eq $backup.files.PSObject.Properties[$name].Value) "备份清单摘要不符：$name"
        }
        $task = $global:SCFixture.task
        Assert-True ($task.Principal.UserId -eq 'SYSTEM' -and $task.Principal.RunLevel -eq 'Highest') "回滚任务缺少 SYSTEM/Highest"
        Assert-True ($task.Actions[0].Execute -ieq (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -and $task.Actions[0].Arguments.Contains('-Automatic')) "回滚执行程序或自动标记不符"
        Assert-True ($task.Settings.StartWhenAvailable -and -not $task.Settings.DisallowStartIfOnBatteries -and -not $task.Settings.StopIfGoingOnBatteries) "救援任务设置不符"
        $seconds = ([datetime]::Parse($task.Triggers[0].StartBoundary) - (Get-Date)).TotalSeconds
        Assert-True ($seconds -gt 345 -and $seconds -le 361) "未保留六分钟自动回退"
        Set-Content -LiteralPath (Join-Path $case.root 'MeshAgent.db') -Value 'candidate-updated-database'
        $dbHash = Hash (Join-Path $case.root 'MeshAgent.db')
        $next = "$($case.receipt).next"
        New-Item -ItemType Directory -Path $next | Out-Null
        Assert-Rejected { Retain $case $armed } "模拟凭据写入失败未拒绝"
        Assert-True ($null -ne $global:SCFixture.task -and (Test-Path $case.active)) "提交失败丢失自动回退"
        Remove-Item -LiteralPath $next
        # 运行备份内的恢复脚本，验证独立任务不依赖调用者原始脚本仍在。
        & (Join-Path $armed.backupDir 'windows-canary.ps1') -Mode Restore -Automatic -BackupDir $armed.backupDir | Out-Null
        Assert-Baseline $case
        Assert-True ((Hash (Join-Path $case.root 'MeshAgent.db')) -eq $dbHash) "回滚改写当前身份数据库"
        Assert-True ($null -eq $global:SCFixture.task) "自动恢复未清理自己的任务"
        Assert-Rejected { Retain $case $armed } "不能保留已恢复的候选"
        $again = & ($case.script) -Mode Restore -BackupDir $armed.backupDir | ConvertFrom-Json
        Assert-True ($again.status -eq 'already-restored') "显式恢复不幂等"
        $global:SCFixture.service = 'Stopped'; $global:SCFixture.watchdog = 'Ready'
        $restarted = & ($case.script) -Mode Restore -BackupDir $armed.backupDir | ConvertFrom-Json
        Assert-True ($restarted.status -eq 'restored') "停服时不能仅报告 already-restored"
        Assert-Baseline $case
    }

    # 保留提交后，即使任务注销失败，排队任务也不得撤回；显式恢复仍还原原凭据。
    $case = New-Case -ExistingReceipt
    $armed = Arm $case
    $global:SCFixture.failUnregister = $true
    $retained = Retain $case $armed
    Assert-True ($retained.status -eq 'retained-for-observation' -and -not (Test-Path $case.active)) "保留提交点或活动标记错误"
    $automatic = & (Join-Path $armed.backupDir 'windows-canary.ps1') -Mode Restore -Automatic -BackupDir $armed.backupDir | ConvertFrom-Json
    Assert-True ($automatic.status -eq 'already-retained' -and (Hash $case.agent) -eq $case.new) "排队任务误恢复已保留版本"
    $global:SCFixture.failUnregister = $false
    & ($case.script) -Mode Restore -BackupDir $armed.backupDir | Out-Null
    Assert-Baseline $case

    # 保留后候选损坏或缺失不撤销显式恢复授权，且旧自动任务仍不得越过提交点。
    foreach ($failure in @('corrupt', 'missing')) {
        $case = New-Case -ExistingReceipt
        $armed = Arm $case
        $null = Retain $case $armed
        if ($failure -eq 'corrupt') { Add-Content -LiteralPath $case.agent -Value 'corruption' }
        else { Remove-Item -LiteralPath $case.agent }
        $automatic = & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir | ConvertFrom-Json
        Assert-True ($automatic.status -eq 'inactive-transaction') "自动任务越过保留提交点"
        & ($case.script) -Mode Restore -BackupDir $armed.backupDir | Out-Null
        Assert-Baseline $case
    }

    # 确定性模拟旧自动任务等锁后迟至下一轮 Arm 才继续，必须完全不触碰新事务。
    $case = New-Case -ExistingReceipt
    $armedA = Arm $case
    $null = Retain $case $armedA
    $receiptAHash = Hash $case.receipt
    $oldA = $case.old; $newA = $case.new; $guardAHash = Hash $case.guard
    Set-Content -LiteralPath $case.candidate -Value 'rust-binary-second-transaction'
    $case.old = $newA; $case.new = Hash $case.candidate
    @{ status = 'built-windows-not-deployed'; windowsBuild = @{ serviceSha256 = $case.new };
        windowsMsvcLibrarySha256 = ('c' * 64) } | ConvertTo-Json | Set-Content -LiteralPath $case.manifest
    $armedB = Arm $case
    $taskArgumentsB = $global:SCFixture.task.Actions[0].Arguments
    $guardBHash = Hash $case.guard; $activeBHash = Hash $case.active; $stopCount = $global:SCFixture.stopCount
    $automatic = & (Join-Path $armedA.backupDir 'windows-canary.ps1') -Mode Restore -Automatic -BackupDir $armedA.backupDir | ConvertFrom-Json
    Assert-True ($automatic.status -eq 'inactive-transaction' -and (Hash $case.agent) -eq $case.new -and
        (Hash $case.guard) -eq $guardBHash -and (Hash $case.active) -eq $activeBHash -and
        $global:SCFixture.task.Actions[0].Arguments -ceq $taskArgumentsB -and $global:SCFixture.stopCount -eq $stopCount) "旧自动任务破坏下一轮事务"
    Assert-Rejected { & ($case.script) -Mode Restore -BackupDir $armedA.backupDir } "旧显式 Restore 可覆盖活动新事务"
    Assert-Rejected { Retain $case $armedA } "旧 Retain 可提交新事务"
    & ($case.script) -Mode Restore -BackupDir $armedB.backupDir | Out-Null
    Assert-True ((Hash $case.agent) -eq $newA -and (Hash $case.guard) -eq $guardAHash -and (Hash $case.receipt) -eq $receiptAHash) "第二轮恢复未还原第一轮保留状态"
    & ($case.script) -Mode Restore -BackupDir $armedA.backupDir | Out-Null
    $case.old = $oldA
    Assert-Baseline $case

    # 恢复必需的备份损坏须在停止服务前拒绝；修复备份后仍可回退。
    foreach ($name in @('meshagent.exe', 'meshagent-guard.ps1', 'windows-canary.ps1', 'rust-runtime.previous.json', 'canary-manifest.json')) {
        $case = New-Case -ExistingReceipt
        $armed = Arm $case
        $path = Join-Path $armed.backupDir $name
        $bytes = [IO.File]::ReadAllBytes($path)
        Add-Content -LiteralPath $path -Value 'corruption'
        $stopCount = $global:SCFixture.stopCount
        Assert-Rejected { & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir } "损坏备份仍被 Restore 接受：$name"
        Assert-Rejected { Retain $case $armed } "损坏备份仍被 Retain 接受：$name"
        Assert-True ((Hash $case.agent) -eq $case.new -and $global:SCFixture.stopCount -eq $stopCount -and $null -ne $global:SCFixture.task) "备份拒绝路径触碰代理或丢失任务"
        [IO.File]::WriteAllBytes($path, $bytes)
        & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir | Out-Null
        Assert-Baseline $case
    }
    # 身份快照或候选清单损坏阻止保留，但不妨碍只恢复旧工件的紧急救援。
    foreach ($name in @('candidate.json', 'MeshAgent.msh', 'MeshAgent.db')) {
        $case = New-Case -ExistingReceipt
        $armed = Arm $case
        Add-Content -LiteralPath (Join-Path $armed.backupDir $name) -Value 'corruption'
        Assert-Rejected { Retain $case $armed } "不完整备份仍被 Retain 接受：$name"
        Assert-True ($null -ne $global:SCFixture.task) "保留拒绝丢失自动回退"
        & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir | Out-Null
        Assert-Baseline $case
    }

    # 使用中途变化的外部构建清单或原凭据提交均须失败。
    foreach ($target in @('manifest', 'receipt')) {
        $case = New-Case -ExistingReceipt
        $armed = Arm $case
        Add-Content -LiteralPath $case[$target] -Value 'changed'
        Assert-Rejected { Retain $case $armed } "Retain 接受变化的 $target"
        & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir | Out-Null
        Assert-Baseline $case
    }

    # 精确 action、SYSTEM、最高权限、触发器与救援设置都在提交前复核。
    foreach ($field in @('execute', 'arguments', 'user', 'runLevel', 'triggerTime', 'triggerEnabled', 'startAvailable', 'batteryStart', 'batteryStop')) {
        $case = New-Case -ExistingReceipt
        $armed = Arm $case
        $task = $global:SCFixture.task
        switch ($field) {
            'execute' { $task.Actions[0].Execute = 'other.exe' }
            'arguments' { $task.Actions[0].Arguments += ' -Unexpected' }
            'user' { $task.Principal.UserId = 'other-user' }
            'runLevel' { $task.Principal.RunLevel = 'Limited' }
            'triggerTime' { $task.Triggers[0].StartBoundary = (Get-Date).AddHours(2).ToString('o') }
            'triggerEnabled' { $task.Triggers[0].Enabled = $false }
            'startAvailable' { $task.Settings.StartWhenAvailable = $false }
            'batteryStart' { $task.Settings.DisallowStartIfOnBatteries = $true }
            'batteryStop' { $task.Settings.StopIfGoingOnBatteries = $true }
        }
        Assert-Rejected { Retain $case $armed } "Retain 接受错误任务配置：$field"
        Assert-True ((Hash $case.receipt) -eq $case.receiptHash -and $null -ne $global:SCFixture.task) "任务拒绝路径提前提交凭据或丢失任务"
        & ($case.script) -Mode Restore -Automatic -BackupDir $armed.backupDir -WarningAction SilentlyContinue | Out-Null
        Assert-Baseline $case
        if ($field -in @('execute', 'arguments')) { Assert-True ($null -ne $global:SCFixture.task) "Restore 注销了不属于自己的任务" }
        else { Assert-True ($null -eq $global:SCFixture.task) "Restore 未清理属于自己的任务" }
    }

    # 注册读回失败时不能先停旧服务；身份快照或候选启动失败则用核心备份恢复。
    $case = New-Case -ExistingReceipt
    $global:SCFixture.badRegistration = $true
    Assert-Rejected { Arm $case } "Arm 接受非 SYSTEM 注册结果"
    Assert-True ($global:SCFixture.stopCount -eq 0 -and $null -eq $global:SCFixture.task) "注册失败仍停旧服务或留下本次任务"
    Assert-Baseline $case
    $case = New-Case -ExistingReceipt
    Remove-Item -LiteralPath (Join-Path $case.root 'MeshAgent.db')
    Assert-Rejected { Arm $case } "Arm 接受缺失身份文件"
    Assert-Baseline $case
    Assert-True ($null -eq $global:SCFixture.task) "部分身份快照失败未清理回退任务"
    $case = New-Case -ExistingReceipt
    $global:SCFixture.failCandidateStart = $true
    Assert-Rejected { Arm $case } "候选启动失败未拒绝"
    Assert-Baseline $case
    Assert-True ($null -eq $global:SCFixture.task) "候选失败后未恢复并清理任务"

    Write-Output '{"windowsCanaryLifecycle":"passed","realServicesModified":false,"crossTransactionStaleRestore":"covered","previousReceiptExactRestore":"covered","backupAndTaskIntegrity":"covered"}'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Variable -Name SCFixture -Scope Global
}

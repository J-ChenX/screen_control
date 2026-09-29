[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$CanaryScript)

# 只在自建目录中运行改写路径的脚本；所有服务、任务和进程调用均由假对象接管。
$ErrorActionPreference = "Stop"
$fixture = Join-Path $env:TEMP ("sc-canary-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixture | Out-Null
$global:SCFixture = @{ service = "Running"; watchdog = "Running"; task = $null; failUnregister = $false }
function Get-Service { param($Name) [pscustomobject]@{ Status = $global:SCFixture.service } }
function Stop-Service { param($Name, [switch]$Force, $ErrorAction) $global:SCFixture.service = "Stopped" }
function Get-CimInstance { param($ClassName, $Filter) return @() }
function Get-ScheduledTask {
    param($TaskName, $ErrorAction)
    if ($TaskName -like '*Watchdog') { return [pscustomobject]@{ State = $global:SCFixture.watchdog } }
    return $global:SCFixture.task
}
function Stop-ScheduledTask { param($TaskName, $ErrorAction) $global:SCFixture.watchdog = "Ready" }
function Start-ScheduledTask {
    param($TaskName)
    $global:SCFixture.watchdog = "Running"; $global:SCFixture.service = "Running"
}
function New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{ Arguments = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$Once, $At) [pscustomobject]@{ At = $At } }
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $User, $RunLevel, [switch]$Force)
    $global:SCFixture.task = [pscustomobject]@{ Actions = @($Action); State = "Ready" }
}
function Unregister-ScheduledTask {
    param($TaskName, $Confirm, $ErrorAction)
    if ($global:SCFixture.failUnregister) { throw "模拟任务注销失败" }
    $global:SCFixture.task = $null
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Hash($Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
try {
    $root = Join-Path $fixture "agent"
    New-Item -ItemType Directory -Path $root | Out-Null
    $agent = Join-Path $root "meshagent.exe"
    $candidate = Join-Path $fixture "candidate.exe"
    Set-Content $agent "old-binary"; Set-Content $candidate "rust-binary"
    $old = Hash $agent; $new = Hash $candidate
    Set-Content (Join-Path $root "meshagent-guard.ps1") ('param($Mode,$ExpectedSha256)' + "`n# " + $old)
    Set-Content (Join-Path $root "MeshAgent.msh") "test-identity"
    Set-Content (Join-Path $root "MeshAgent.db") "test-database"
    $manifest = Join-Path $fixture "candidate.json"
    @{ status = "built-windows-not-deployed"; windowsBuild = @{ serviceSha256 = $new };
        windowsMsvcLibrarySha256 = ('a' * 64) } | ConvertTo-Json | Set-Content $manifest
    $code = Get-Content -LiteralPath $CanaryScript -Raw -Encoding UTF8
    $code = $code.Replace('C:\ProgramData\ScreenControl\MeshAgent', $root).
        Replace('07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7', $old).
        Replace('Global\ScreenControlRustAgentUpdate', 'Local\SCFixture-' + [guid]::NewGuid().ToString('N'))
    $script = Join-Path $fixture "canary.ps1"
    Set-Content -LiteralPath $script -Value $code -Encoding UTF8
    $armed = (& $script -Mode Arm -CandidatePath $candidate -CandidateSha256 $new | ConvertFrom-Json)
    Assert-True ((Hash $agent) -eq $new) "Arm 未切换测试工件"
    Assert-True ($global:SCFixture.task.Actions[0].Arguments.Contains('-Automatic')) "自动回滚标记缺失"

    # 提交失败时仍保留有效的自动回滚。
    $next = Join-Path $root "rust-runtime.json.next"
    New-Item -ItemType Directory -Path $next | Out-Null
    $rejected = $false
    try { & $script -Mode Retain -BackupDir $armed.backupDir -BuildManifest $manifest -CandidateSha256 $new | Out-Null }
    catch { $rejected = $true }
    Assert-True ($rejected -and $null -ne $global:SCFixture.task) "写入失败丢失自动回滚"
    Remove-Item -LiteralPath $next
    & $script -Mode Restore -Automatic -BackupDir $armed.backupDir | Out-Null
    Assert-True ((Hash $agent) -eq $old) "写入失败后自动恢复失败"

    # 自动恢复先完成时，后续保留必须失败。
    $rejected = $false
    try { & $script -Mode Retain -BackupDir $armed.backupDir -BuildManifest $manifest -CandidateSha256 $new | Out-Null }
    catch { $rejected = $true }
    Assert-True $rejected "不能保留已恢复的候选"

    $armed = (& $script -Mode Arm -CandidatePath $candidate -CandidateSha256 $new | ConvertFrom-Json)
    $global:SCFixture.failUnregister = $true
    $retained = (& $script -Mode Retain -BackupDir $armed.backupDir -BuildManifest $manifest -CandidateSha256 $new -WarningAction SilentlyContinue | ConvertFrom-Json)
    Assert-True ($retained.status -eq 'retained-for-observation') "注销失败不应撤回已提交保留"
    $automatic = (& $script -Mode Restore -Automatic -BackupDir $armed.backupDir | ConvertFrom-Json)
    Assert-True ($automatic.status -eq 'already-retained' -and (Hash $agent) -eq $new) "排队任务误恢复已保留版本"
    $global:SCFixture.failUnregister = $false
    & $script -Mode Restore -BackupDir $armed.backupDir | Out-Null
    Assert-True ((Hash $agent) -eq $old -and -not (Test-Path (Join-Path $root 'rust-runtime.json'))) "显式恢复未完成"
    Assert-True ((Get-Content (Join-Path $root 'MeshAgent.db')) -eq 'test-database') "回滚不应改写当前身份数据库"
    Write-Output '{"windowsCanaryLifecycle":"passed","realServicesModified":false}'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
    Remove-Variable -Name SCFixture -Scope Global
}

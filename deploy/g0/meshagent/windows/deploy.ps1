[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Root = "C:\ProgramData\ScreenControl\MeshAgent"
$AgentPath = Join-Path $Root "meshagent.exe"
$GuardPath = Join-Path $Root "meshagent-guard.ps1"
$WatchdogInstallerPath = Join-Path $Root "install-watchdog.ps1"
$InstallerPath = "C:\ProgramData\ScreenControl\MeshAgent\screen-control-meshagent.exe"
$ExpectedSha256 = "07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7"
$RollbackTask = "Screen-Control-G0-Rollback"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "administrator token required"
}

$sourceAgent = Join-Path $env:USERPROFILE "meshagent-windows-x64.exe"
$sourceGuard = Join-Path $env:USERPROFILE "meshagent-guard.ps1"
$sourceWatchdogInstaller = Join-Path $env:USERPROFILE "install-watchdog.ps1"
foreach ($path in @($sourceAgent, $sourceGuard, $sourceWatchdogInstaller)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing staged file: $path" }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $sourceAgent).Hash.ToLowerInvariant() -ne $ExpectedSha256) {
    throw "staged agent hash mismatch"
}

# 安装前先校验，仅为 SYSTEM 任务持久化网络设置。
& $sourceGuard -Mode Validate | Out-Null
foreach ($name in @("SCREEN_CONTROL_MESH_HOST", "SCREEN_CONTROL_MESH_BIND_IP", "SCREEN_CONTROL_REGISTERED_IPS")) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($value) { [Environment]::SetEnvironmentVariable($name, $value, "Machine") }
}
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Copy-Item -LiteralPath $sourceGuard -Destination $GuardPath -Force
Copy-Item -LiteralPath $sourceWatchdogInstaller -Destination $WatchdogInstallerPath -Force
Copy-Item -LiteralPath $sourceAgent -Destination $InstallerPath -Force

$rollbackArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$GuardPath`" -Mode Rollback"
$rollbackAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $rollbackArgs
$rollbackTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
Register-ScheduledTask -TaskName $RollbackTask -Action $rollbackAction -Trigger $rollbackTrigger `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null

try {
    & $GuardPath -Mode Preblock -AgentPath $AgentPath -InstallerPath $InstallerPath -ExpectedSha256 $ExpectedSha256

    & $GuardPath -Mode PrepareHost -AgentPath $AgentPath -InstallerPath $InstallerPath -ExpectedSha256 $ExpectedSha256

    $install = Start-Process -FilePath $InstallerPath -ArgumentList @(
        "-fullinstall", '--installPath="C:\ProgramData\ScreenControl\MeshAgent"'
    ) -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw "MeshAgent installer failed: $($install.ExitCode)" }

    $service = Get-CimInstance Win32_Service | Where-Object {
        $_.PathName.Replace('\\', '\') -match [Regex]::Escape($AgentPath)
    }
    if (@($service).Count -ne 1) { throw "installed MeshAgent service was not found at the fixed path" }
    Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue

    & $GuardPath -Mode Apply -AgentPath $AgentPath -InstallerPath $InstallerPath -ExpectedSha256 $ExpectedSha256
    Set-Service -Name $service.Name -StartupType Manual
    & $WatchdogInstallerPath -GuardPath $GuardPath
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Service -Name $service.Name).Status -ne "Running" -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if ((Get-Service -Name $service.Name).Status -ne "Running") {
        throw "boot guard did not start MeshAgent"
    }
    & $GuardPath -Mode Assert -AgentPath $AgentPath -InstallerPath $InstallerPath -ExpectedSha256 $ExpectedSha256

    [ordered]@{
        service = $service.Name
        status = (Get-Service -Name $service.Name).Status.ToString()
        agentSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $AgentPath).Hash.ToLowerInvariant()
        ruleCount = @(Get-NetFirewallRule -Group "Screen Control G0 MeshAgent").Count
        watchdog = (Get-ScheduledTask -TaskName "Screen-Control-G0-MeshAgent-Watchdog").State.ToString()
        rollbackArmed = (Get-ScheduledTask -TaskName $RollbackTask).State.ToString()
    } | ConvertTo-Json -Compress
} catch {
    $originalError = $_
    try {
        & $GuardPath -Mode Rollback -AgentPath $AgentPath -InstallerPath $InstallerPath -ExpectedSha256 $ExpectedSha256
    } catch {
        Write-Warning "rollback reported an additional error: $($_.Exception.Message)"
    }
    throw $originalError
}

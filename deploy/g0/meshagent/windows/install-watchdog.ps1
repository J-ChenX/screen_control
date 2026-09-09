[CmdletBinding()]
param(
    [string]$GuardPath = "C:\ProgramData\ScreenControl\MeshAgent\meshagent-guard.ps1"
)

$ErrorActionPreference = "Stop"
$TaskName = "Screen-Control-G0-MeshAgent-Watchdog"
$argument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$GuardPath`" -Mode Boot"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

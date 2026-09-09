[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Validate", "Preblock", "PrepareHost", "Apply", "Assert", "Boot", "Watchdog", "Rollback")]
    [string]$Mode,

    [string]$AgentPath = "C:\ProgramData\ScreenControl\MeshAgent\meshagent.exe",
    [string]$InstallerPath = "C:\ProgramData\ScreenControl\MeshAgent\screen-control-meshagent.exe",
    [string]$ExpectedSha256 = "07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7"
)

$ErrorActionPreference = "Stop"
$RuleGroup = "Screen Control G0 MeshAgent"
$TaskName = "Screen-Control-G0-MeshAgent-Watchdog"

$DefaultHostLines = @(
    "# Screen Control preserved local host entries",
    "127.0.0.1 localhost",
    "::1 localhost"
)
# SYSTEM 计划任务不会继承安装程序的进程环境。
function Get-DeploymentValue([string]$Name) {
    if ($Mode -in @("Boot", "Watchdog")) {
        $current = [Environment]::GetEnvironmentVariable($Name, "Machine")
        if ($current) { return $current }
    }
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($Name, "Machine") }
    if (-not $value) { throw "set $Name before deployment" }
    return $value
}

function ConvertTo-IPv4Number([string]$Value) {
    $ip = [System.Net.IPAddress]::Parse($Value)
    if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -ne $Value) {
        throw "expected a canonical individual IPv4 address"
    }
    $b = $ip.GetAddressBytes()
    if ($b[0] -ne 100 -or $b[1] -lt 64 -or $b[1] -gt 127) { throw "only Tailscale IPv4 addresses are allowed" }
    return [uint64]$b[0] * 16777216 + [uint64]$b[1] * 65536 + [uint64]$b[2] * 256 + [uint64]$b[3]
}

function ConvertFrom-IPv4Number([uint64]$Value) {
    return "{0}.{1}.{2}.{3}" -f (($Value -shr 24) -band 255), (($Value -shr 16) -band 255), (($Value -shr 8) -band 255), ($Value -band 255)
}

function Initialize-NetworkConfig {
    $script:ServerHost = Get-DeploymentValue "SCREEN_CONTROL_MESH_HOST"
    if ($ServerHost.Length -gt 253 -or $ServerHost -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') { throw "invalid MESH_HOST" }
    foreach ($label in $ServerHost.Split('.')) {
        if ($label.Length -gt 63 -or $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') { throw "invalid DNS label" }
    }
    $script:ServerIp = Get-DeploymentValue "SCREEN_CONTROL_MESH_BIND_IP"
    [void](ConvertTo-IPv4Number $ServerIp)
    $script:AllowedIps = @((Get-DeploymentValue "SCREEN_CONTROL_REGISTERED_IPS").Split(',') | ForEach-Object { $_.Trim() })
    if ($AllowedIps.Count -ne 3 -or @($AllowedIps | Sort-Object -Unique).Count -ne 3 -or $ServerIp -notin $AllowedIps) {
        throw "configure three distinct addresses including MESH_BIND_IP"
    }
    $numbers = @($AllowedIps | ForEach-Object { ConvertTo-IPv4Number $_ } | Sort-Object)
    $script:BlockedIpv4 = @()
    [uint64]$next = 0
    foreach ($number in $numbers) {
        if ($number -gt $next) {
            $script:BlockedIpv4 += "$(ConvertFrom-IPv4Number $next)-$(ConvertFrom-IPv4Number ($number - 1))"
        }
        $next = $number + 1
    }
    if ($next -le 4294967295) { $script:BlockedIpv4 += "$(ConvertFrom-IPv4Number $next)-255.255.255.255" }
}
$BlockedIpv6 = @("::/1", "8000::/1")

function Get-AgentService {
    $escaped = [Regex]::Escape($AgentPath)
    $services = @(Get-CimInstance Win32_Service | Where-Object {
        $_.PathName.Replace('\\', '\') -match $escaped
    })
    if ($services.Count -ne 1) {
        throw "expected exactly one service for the fixed MeshAgent path"
    }
    return $services[0]
}

function Assert-Prerequisites {
    if (-not (Test-Path -LiteralPath $AgentPath -PathType Leaf)) {
        throw "agent binary missing"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $AgentPath).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw "agent hash mismatch"
    }
    $tailscale = Get-NetAdapter -Name "Tailscale" -ErrorAction Stop
    if ($tailscale.Status -ne "Up") {
        throw "Tailscale adapter is not up"
    }
    $hostLine = Get-Content -LiteralPath "$env:SystemRoot\System32\drivers\etc\hosts" |
        Where-Object { $_ -match ("^\s*" + [Regex]::Escape($ServerIp) + "\s+" + [Regex]::Escape($ServerHost) + "\s+# screen-control-g0\s*$") }
    if (@($hostLine).Count -ne 1) {
        throw "fixed desktop host mapping missing or duplicated"
    }
    foreach ($ip in $AllowedIps) {
        $route = Find-NetRoute -RemoteIPAddress $ip | Select-Object -First 1
        if ($null -eq $route -or $route.InterfaceIndex -ne $tailscale.ifIndex) {
            throw "registered address $ip does not route through Tailscale"
        }
    }
    [void](Get-AgentService)
}

function Remove-OwnedRules {
    Get-NetFirewallRule -Group $RuleGroup -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

function Add-PreblockRules {
    Remove-OwnedRules
    New-NetFirewallRule -DisplayName "SC-G0 preblock installed agent" -Group $RuleGroup `
        -Direction Outbound -Action Block -Program $AgentPath -Profile Any -RemoteAddress Any | Out-Null
    New-NetFirewallRule -DisplayName "SC-G0 preblock installer" -Group $RuleGroup `
        -Direction Outbound -Action Block -Program $InstallerPath -Profile Any -RemoteAddress Any | Out-Null
}

function Add-EnforcementRules {
    Assert-Prerequisites
    $service = Get-AgentService
    & sc.exe sidtype $service.Name unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to enable the MeshAgent service SID" }
    Remove-OwnedRules

    New-NetFirewallRule -DisplayName "SC-G0 allow registered Tailnet" -Group $RuleGroup `
        -Direction Outbound -Action Allow -Service $service.Name -Profile Any `
        -InterfaceAlias "Tailscale" -RemoteAddress $AllowedIps | Out-Null
    New-NetFirewallRule -DisplayName "SC-G0 block all other IPv4" -Group $RuleGroup `
        -Direction Outbound -Action Block -Service $service.Name -Profile Any `
        -RemoteAddress $BlockedIpv4 | Out-Null
    New-NetFirewallRule -DisplayName "SC-G0 block all IPv6" -Group $RuleGroup `
        -Direction Outbound -Action Block -Service $service.Name -Profile Any `
        -RemoteAddress $BlockedIpv6 | Out-Null

    $otherInterfaces = @(Get-NetIPInterface -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -ne "Tailscale" -and $_.InterfaceIndex -ne 1 -and $_.ConnectionState -eq "Connected"
    } | Sort-Object InterfaceIndex -Unique)
    foreach ($interface in $otherInterfaces) {
        New-NetFirewallRule -DisplayName "SC-G0 block registered via $($interface.InterfaceIndex)" -Group $RuleGroup `
            -Direction Outbound -Action Block -Service $service.Name -Profile Any `
            -InterfaceAlias $interface.InterfaceAlias -RemoteAddress $AllowedIps | Out-Null
    }
}

function Assert-Enforcement {
    Assert-Prerequisites
    $rules = @(Get-NetFirewallRule -Group $RuleGroup -ErrorAction Stop)
    if ($rules.Count -lt 4 -or @($rules | Where-Object Enabled -ne "True").Count -ne 0) {
        throw "owned firewall rules are missing or disabled"
    }
    foreach ($name in @("SC-G0 allow registered Tailnet", "SC-G0 block all other IPv4", "SC-G0 block all IPv6")) {
        if (@($rules | Where-Object DisplayName -eq $name).Count -ne 1) {
            throw "required firewall rule missing: $name"
        }
    }
    $service = Get-AgentService
    foreach ($rule in $rules) {
        $serviceFilter = $rule | Get-NetFirewallServiceFilter
        if ($serviceFilter.Service -ne $service.Name) {
            throw "firewall rule is not bound to the MeshAgent service SID: $($rule.DisplayName)"
        }
    }
    $activeOtherInterfaces = @(Get-NetIPInterface -AddressFamily IPv4 | Where-Object {
        $_.InterfaceAlias -ne "Tailscale" -and $_.InterfaceIndex -ne 1 -and $_.ConnectionState -eq "Connected"
    } | Sort-Object InterfaceIndex -Unique)
    foreach ($interface in $activeOtherInterfaces) {
        $name = "SC-G0 block registered via $($interface.InterfaceIndex)"
        if (@($rules | Where-Object DisplayName -eq $name).Count -ne 1) {
            throw "active non-Tailscale interface is not blocked: $($interface.InterfaceIndex)"
        }
    }
}

function Get-HostLines {
    $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try { return @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop) } catch {
            if ($attempt -eq 20) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Set-HostLines([string[]]$Lines) {
    $hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
    $normalized = @($Lines)
    if ($normalized.Count -eq 0) {
        $normalized = $DefaultHostLines
    }
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            [System.IO.File]::WriteAllLines(
                $hostsPath,
                [string[]]$normalized,
                [System.Text.Encoding]::ASCII
            )
            return
        } catch {
            if ($attempt -eq 20) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Set-HostMapping {
    $lines = @(Get-HostLines | Where-Object { $_ -notmatch "# screen-control-g0\s*$" })
    if ($lines.Count -eq 0) {
        $lines = $DefaultHostLines
    }
    $lines += "$ServerIp $ServerHost # screen-control-g0"
    Set-HostLines -Lines $lines
}

function Remove-HostMapping {
    $lines = @(Get-HostLines | Where-Object { $_ -notmatch "# screen-control-g0\s*$" })
    Set-HostLines -Lines $lines
}

function Invoke-Rollback {
    try {
        $service = Get-AgentService
        Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
        Set-Service -Name $service.Name -StartupType Disabled -ErrorAction SilentlyContinue
    } catch { }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-OwnedRules
    Remove-HostMapping
}

# 即使配置缺失或无效，回滚功能也必须可用。
if ($Mode -notin @("Rollback", "Preblock")) {
    try { Initialize-NetworkConfig } catch {
        if ($Mode -in @("Boot", "Watchdog")) {
            try { Stop-Service -Name (Get-AgentService).Name -Force -ErrorAction SilentlyContinue } catch { }
        }
        throw
    }
}
switch ($Mode) {
    "Validate" { [ordered]@{ allowed = $AllowedIps; blocked = $BlockedIpv4 } | ConvertTo-Json -Compress }
    "Preblock" { Add-PreblockRules }
    "PrepareHost" { Set-HostMapping }
    "Apply" { Add-EnforcementRules; Assert-Enforcement }
    "Assert" { Assert-Enforcement }
    "Boot" {
        $service = Get-AgentService
        Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
        try {
            Add-EnforcementRules
            Set-Service -Name $service.Name -StartupType Manual
            Start-Service -Name $service.Name
        } catch {
            Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
            throw
        }
        while ($true) {
            try {
                Assert-Enforcement
            } catch {
                Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue
                throw
            }
            Start-Sleep -Seconds 2
        }
    }
    "Watchdog" {
        while ($true) {
            try {
                Assert-Enforcement
            } catch {
                try { Stop-Service -Name (Get-AgentService).Name -Force -ErrorAction SilentlyContinue } catch { }
                throw
            }
            Start-Sleep -Seconds 2
        }
    }
    "Rollback" { Invoke-Rollback }
}

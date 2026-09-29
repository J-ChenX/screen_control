[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$WorkDir)

$ErrorActionPreference = "Stop"
$manifestPath = Join-Path $WorkDir "candidate.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.status -ne "prepared-windows-not-deployed" -or
    $manifest.baselineCommit -notmatch '^[a-f0-9]{40}$') { throw "需要未构建的固定 Windows 候选" }
$source = Join-Path $WorkDir ("MeshAgent-" + $manifest.baselineCommit)
function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ((Get-Sha256 (Join-Path $source "screen_control_protocol_ffi.lib")) -ne $manifest.windowsMsvcLibrarySha256) {
    throw "Rust 静态库摘要不符"
}
foreach ($entry in $manifest.windowsMsvcFilesSha256.PSObject.Properties) {
    if ($entry.Name -notin @("meshservice/MeshService-2022.vcxproj", "meshconsole/MeshConsole-2022.vcxproj",
        "meshservice/MeshService.rc", "microscript/ILibduktape_EventEmitter.c")) { throw "未知的 MSVC 源码校验路径" }
    if ((Get-Sha256 (Join-Path $source $entry.Name)) -ne $entry.Value) { throw "MSVC 源码摘要不符" }
}
$locator = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$build = @(& $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe')
if ($LASTEXITCODE -ne 0 -or $build.Count -ne 1) { throw "无法唯一确定已安装的 MSBuild" }
$log = Join-Path $WorkDir "msbuild.log"
& $build[0] (Join-Path $source "MeshAgent-2022.sln") /t:Rebuild /p:Configuration=Release /p:Platform=x64 /m:2 /nologo /verbosity:quiet *> $log
if ($LASTEXITCODE -ne 0) { throw "MSVC 构建失败；请在本机检查 msbuild.log" }
$service = Join-Path $source "Release\MeshService64.exe"
$console = Join-Path $source "Release\MeshConsole64.exe"
$manifest.status = "built-windows-not-deployed"
$manifest | Add-Member -NotePropertyName windowsBuild -NotePropertyValue ([ordered]@{
    configuration = "Release|x64"; toolVersion = (Get-Item -LiteralPath $build[0]).VersionInfo.FileVersion;
    serviceSha256 = Get-Sha256 $service; consoleSha256 = Get-Sha256 $console;
    logSha256 = Get-Sha256 $log; completedUtc = [DateTime]::UtcNow.ToString("o")
})
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
[ordered]@{ status = $manifest.status; build = $manifest.windowsBuild } | ConvertTo-Json -Depth 4 -Compress

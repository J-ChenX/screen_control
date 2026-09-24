# 只修改已安装主程序的 GC 配置，不修改账号、历史或系统全局 .NET 设置。
[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory=$true)][string]$RuntimeConfig)
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $RuntimeConfig
if ($item.PSIsContainer -or $item.Name -notlike '*.runtimeconfig.json' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '必须指定主程序的普通 runtimeconfig.json 文件'
}
$document = Get-Content -LiteralPath $item.FullName -Raw | ConvertFrom-Json
if (-not $document.runtimeOptions) { throw '缺少 runtimeOptions' }
if (-not $document.runtimeOptions.configProperties) {
    $document.runtimeOptions | Add-Member -NotePropertyName configProperties -NotePropertyValue ([pscustomobject]@{})
}
$properties = $document.runtimeOptions.configProperties
$settings = @{ 'System.GC.Server'=$false; 'System.GC.ConserveMemory'=5; 'System.GC.HeapHardLimit'=402653184 }
foreach ($key in $settings.Keys) {
    $properties | Add-Member -NotePropertyName $key -NotePropertyValue $settings[$key] -Force
}
if ($PSCmdlet.ShouldProcess($item.Name, '备份原配置并设置 384 MiB 托管堆预算')) {
    $backup = $item.FullName + '.before-memory-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')
    $temporary = $item.FullName + '.memory-' + [guid]::NewGuid().ToString('N')
    Copy-Item -LiteralPath $item.FullName -Destination $backup -ErrorAction Stop
    try {
        [IO.File]::WriteAllText($temporary, ($document | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
        # 同卷原子替换保留原文件 ACL，备份保留原始字节；失败不删除备份。
        [IO.File]::Replace($temporary, $item.FullName, [NullString]::Value)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
    [pscustomobject]@{ RuntimeConfig=$item.FullName; Backup=$backup; HeapLimitBytes=402653184 }
}

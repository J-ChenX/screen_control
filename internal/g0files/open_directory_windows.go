package g0files

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// 固定脚本通过当前用户的交互令牌启动 Explorer，避免 SSH 会话中的窗口不可见。
// 路径只从环境变量解码为任务参数，不拼入 PowerShell 源码；任务不提权且用后删除。
const explorerTaskScript = `
$ErrorActionPreference = 'Stop'
$name = 'ScreenControl-OpenDirectory-' + [guid]::NewGuid().ToString('N')
$root = $null
$registered = $false
try {
 $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SCREEN_CONTROL_OPEN_DIRECTORY))
 $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
 $service = New-Object -ComObject 'Schedule.Service'
 $service.Connect()
 $root = $service.GetFolder('\')
 $task = $service.NewTask(0)
 $task.Principal.UserId = $identity
 $task.Principal.LogonType = 3
 $task.Principal.RunLevel = 0
 $task.Settings.DisallowStartIfOnBatteries = $false
 $task.Settings.StopIfGoingOnBatteries = $false
 $task.Settings.ExecutionTimeLimit = 'PT1M'
 $action = $task.Actions.Create(0)
 $action.Path = Join-Path $env:SystemRoot 'explorer.exe'
 $action.Arguments = $path
 $entry = $root.RegisterTaskDefinition($name, $task, 2, $identity, $null, 3)
 $registered = $true
 $running = $entry.Run($null)
 Start-Sleep -Milliseconds 500
} catch { exit 1 } finally {
 if ($registered) { $root.DeleteTask($name, 0) }
}
`

func launchWindowsDirectory(path string) error {
	root := os.Getenv("SystemRoot")
	if root == "" {
		return errors.New("系统文件管理器不可用")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", explorerTaskScript)
	cmd.Env = append(os.Environ(), "SCREEN_CONTROL_OPEN_DIRECTORY="+base64.StdEncoding.EncodeToString([]byte(syscall.EscapeArg(path))))
	if err := cmd.Run(); err != nil {
		return errors.New("无法在当前用户桌面打开目录，请确认该用户已登录且允许创建普通权限临时任务")
	}
	return nil
}

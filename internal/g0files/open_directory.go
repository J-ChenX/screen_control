package g0files

import (
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 仅启动固定文件管理器并传入已验证目录；不接受命令、程序或 URL。
func directoryToOpen(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(resolved, `\\`) {
		return "", errors.New("不支持在桌面打开网络或设备路径")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("只能在桌面打开目录")
	}
	directory, err := os.Open(resolved)
	if err != nil {
		return "", err
	}
	defer directory.Close()
	if _, err = directory.Readdirnames(1); err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	return resolved, nil
}

func openDirectory(path string) error {
	resolved, err := directoryToOpen(path)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		current, err := user.Current()
		if err != nil {
			return err
		}
		bus := "/run/user/" + current.Uid + "/bus"
		if info, err := os.Stat(bus); err != nil || info.Mode()&os.ModeSocket == 0 {
			return errors.New("目标用户没有可用的图形桌面会话，请先在目标电脑登录桌面")
		}
		cmd = exec.CommandContext(ctx, "/usr/bin/gio", "open", (&url.URL{Scheme: "file", Path: resolved}).String())
		cmd.Env = append(os.Environ(), "DBUS_SESSION_BUS_ADDRESS=unix:path="+bus, "XDG_RUNTIME_DIR=/run/user/"+current.Uid)
	case "windows":
		return launchWindowsDirectory(resolved)
	default:
		return errors.New("此系统暂不支持打开桌面目录")
	}
	if err := cmd.Run(); err != nil {
		return errors.New("系统文件管理器未接受打开请求，请确认目标用户已登录图形桌面")
	}
	return nil
}

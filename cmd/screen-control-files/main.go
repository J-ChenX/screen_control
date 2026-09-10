// screen-control-files 是随 SSH 会话退出的普通用户文件进程，不监听端口。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"screencontrol.local/screen-control/internal/g0files"
	"strings"
)

func main() {
	account, err := user.Current()
	if err != nil || os.Geteuid() == 0 || account.Uid == "0" || strings.EqualFold(account.Uid, "S-1-5-18") || strings.EqualFold(account.Uid, "S-1-5-19") || strings.EqualFold(account.Uid, "S-1-5-20") {
		fmt.Fprintln(os.Stderr, "文件进程必须以普通用户身份运行")
		os.Exit(1)
	}
	hello, _ := json.Marshal(map[string]any{"action": "workerReady", "version": 1, "uid": account.Uid})
	if err = g0files.WriteFrame(os.Stdout, hello); err == nil {
		err = g0files.Run(os.Stdin, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "文件通道已停止")
		os.Exit(1)
	}
}

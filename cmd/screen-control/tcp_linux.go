//go:build linux

package main

import (
	"context"
	"log/slog"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// 仅私网门户监听器使用 BBR；接受的 HTTP、HTTPS 和 WebSocket 连接继承设置。
func listenTailscaleTCP(address string) (net.Listener, error) {
	return listenTCPWithCongestion(address, "bbr")
}

func listenTCPWithCongestion(address, algorithm string) (net.Listener, error) {
	config := net.ListenConfig{Control: func(_, _ string, raw syscall.RawConn) error {
		var optionErr error
		err := raw.Control(func(fd uintptr) {
			optionErr = unix.SetsockoptString(int(fd), unix.IPPROTO_TCP, unix.TCP_CONGESTION, algorithm)
		})
		if err != nil || optionErr != nil {
			// 内核未提供或未允许该算法时保留系统默认，不阻止门户启动。
			slog.Warn("私网门户无法启用指定 TCP 拥塞控制，使用系统默认", "algorithm", algorithm)
		} else {
			slog.Info("私网门户 TCP 拥塞控制已启用", "algorithm", algorithm)
		}
		return nil
	}}
	return config.Listen(context.Background(), "tcp", address)
}

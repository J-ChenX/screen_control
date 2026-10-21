//go:build !linux

package main

import "net"

// 其他系统沿用原有 TCP 实现。
func listenTailscaleTCP(address string) (net.Listener, error) {
	return net.Listen("tcp", address)
}

//go:build linux

package main

import (
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestTailscaleCongestionInheritanceAndFallback(t *testing.T) {
	defaultBytes, err := os.ReadFile("/proc/sys/net/ipv4/tcp_congestion_control")
	if err != nil {
		t.Fatal(err)
	}
	available, err := os.ReadFile("/proc/sys/net/ipv4/tcp_allowed_congestion_control")
	if err != nil {
		t.Fatal(err)
	}
	for _, algorithm := range []string{"reno", "bbr", "sc-invalid"} {
		t.Run(algorithm, func(t *testing.T) {
			expected := strings.TrimSpace(string(defaultBytes))
			for _, allowed := range strings.Fields(string(available)) {
				if allowed == algorithm {
					expected = algorithm
				}
			}
			listener, err := listenTCPWithCongestion("127.0.0.1:0", algorithm)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			client, err := net.DialTimeout("tcp", listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			server, err := listener.Accept()
			if err != nil {
				t.Fatal(err)
			}
			defer server.Close()
			if err := server.SetDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			raw, err := server.(*net.TCPConn).SyscallConn()
			if err != nil {
				t.Fatal(err)
			}
			var actual string
			var optionErr error
			if err := raw.Control(func(fd uintptr) {
				actual, optionErr = unix.GetsockoptString(int(fd), unix.IPPROTO_TCP, unix.TCP_CONGESTION)
			}); err != nil || optionErr != nil {
				t.Fatalf("读取连接算法失败：%v %v", err, optionErr)
			}
			if actual != expected {
				t.Fatalf("接受连接算法 = %q，期望 %q", actual, expected)
			}
			if _, err := client.Write([]byte("ok")); err != nil {
				t.Fatal(err)
			}
			var payload [2]byte
			if _, err := io.ReadFull(server, payload[:]); err != nil || string(payload[:]) != "ok" {
				t.Fatalf("连接不可用：%q %v", payload, err)
			}
		})
	}
	after, err := os.ReadFile("/proc/sys/net/ipv4/tcp_congestion_control")
	if err != nil || string(after) != string(defaultBytes) {
		t.Fatalf("修改了系统默认算法：%q %v", after, err)
	}
}

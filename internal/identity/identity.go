// identity 包定义入口监听器与应用处理器共用的
// 可信设备身份边界。
package identity

import (
	"context"
	"errors"
	"net"
)

var (
	// ErrUnavailable 表示无法将连接绑定到 Tailscale 对端。
	ErrUnavailable = errors.New("device identity unavailable")
	// ErrUnregistered 表示 Tailscale 已认证对端，但其稳定节点
	// ID 未登记在 Screen Control 设备注册表中。
	ErrUnregistered = errors.New("device is not registered")
)

// Resolver 返回已认证且已登记的设备 ID。私有监听器使用套接字对端；
// 网关使用已验证的内部主体。始终不信任原始
// 身份请求头和客户端提供的设备 ID。
type Resolver interface {
	Resolve(context.Context, net.Addr, net.Addr) (string, error)
}

// Principal 由专用网关在验证服务端签发的访问密钥后设置，
// 绝不从 HTTP 身份请求头填充。
type Principal struct {
	DeviceID, SessionID string
	Lifetime            context.Context
}
type principalKey struct{}

func WithAuthenticatedPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}
func AuthenticatedPrincipal(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok && p.DeviceID != "" && p.SessionID != ""
}

// peer 包通过 tailscaled 的 LocalAPI 解析已登记的 Screen Control 设备，
// 仅接受来自实际连接的地址。
package peer

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	appidentity "screencontrol.local/screen-control/internal/identity"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

const lookupBudget = 500 * time.Millisecond

type whoIsClient interface {
	WhoIsForIP(context.Context, string, netip.Addr) (*apitype.WhoIsResponse, error)
}

// Resolver 将 Tailscale 稳定节点 ID 映射为应用设备 ID。
type Resolver struct {
	client        whoIsClient
	registrations map[tailcfg.StableNodeID]string
}

// NewResolver 基于主机的 tailscaled LocalAPI 构建解析器。
func NewResolver(registrations map[tailcfg.StableNodeID]string) (*Resolver, error) {
	return newResolver(new(local.Client), registrations)
}

func newResolver(client whoIsClient, registrations map[tailcfg.StableNodeID]string) (*Resolver, error) {
	if client == nil {
		return nil, errors.New("identity resolver requires a LocalAPI client")
	}
	if len(registrations) == 0 {
		return nil, errors.New("identity resolver requires registered Tailscale nodes")
	}
	copyOfRegistrations := make(map[tailcfg.StableNodeID]string, len(registrations))
	for stableID, deviceID := range registrations {
		if stableID == "" || strings.TrimSpace(deviceID) == "" {
			return nil, errors.New("identity registration contains an empty ID")
		}
		copyOfRegistrations[stableID] = deviceID
	}
	return &Resolver{client: client, registrations: copyOfRegistrations}, nil
}

// ParseRegistrations 解析以逗号分隔的 "device=stable-node-id" 配置项。
func ParseRegistrations(value string) (map[tailcfg.StableNodeID]string, error) {
	registrations := make(map[tailcfg.StableNodeID]string)
	seenDevices := make(map[string]struct{})
	for _, rawPair := range strings.Split(value, ",") {
		rawPair = strings.TrimSpace(rawPair)
		if rawPair == "" {
			continue
		}
		deviceID, stableID, ok := strings.Cut(rawPair, "=")
		deviceID = strings.TrimSpace(deviceID)
		stableID = strings.TrimSpace(stableID)
		if !ok || deviceID == "" || stableID == "" {
			return nil, fmt.Errorf("invalid device registration %q", rawPair)
		}
		if _, exists := seenDevices[deviceID]; exists {
			return nil, fmt.Errorf("duplicate device registration %q", deviceID)
		}
		stableNodeID := tailcfg.StableNodeID(stableID)
		if _, exists := registrations[stableNodeID]; exists {
			return nil, fmt.Errorf("duplicate stable node registration %q", stableID)
		}
		seenDevices[deviceID] = struct{}{}
		registrations[stableNodeID] = deviceID
	}
	if len(registrations) == 0 {
		return nil, errors.New("no Tailscale device registrations configured")
	}
	return registrations, nil
}

// Resolve 识别已接受的 Tailscale 连接的远端身份。
func (r *Resolver) Resolve(ctx context.Context, remoteAddr, localAddr net.Addr) (string, error) {
	remote, err := addrPort(remoteAddr)
	if err != nil || remote.Addr().IsLoopback() || !remote.Addr().IsValid() {
		return "", fmt.Errorf("%w: invalid remote socket peer", appidentity.ErrUnavailable)
	}
	destination, err := addrPort(localAddr)
	if err != nil || destination.Addr().IsLoopback() || !destination.Addr().IsValid() {
		return "", fmt.Errorf("%w: invalid local socket address", appidentity.ErrUnavailable)
	}

	lookupContext, cancel := context.WithTimeout(ctx, lookupBudget)
	defer cancel()
	who, lookupErr := r.client.WhoIsForIP(lookupContext, remote.String(), destination.Addr())
	if lookupErr != nil {
		// 身份设计允许一次短暂重试，仍受同一个 500 毫秒截止时间约束。
		// 固定延迟 50 毫秒，使测试和运维行为可预测。
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-timer.C:
			who, lookupErr = r.client.WhoIsForIP(lookupContext, remote.String(), destination.Addr())
		case <-lookupContext.Done():
			if !timer.Stop() {
				<-timer.C
			}
			lookupErr = lookupContext.Err()
		}
	}
	if lookupErr != nil || who == nil || who.Node == nil {
		return "", fmt.Errorf("%w: LocalAPI WhoIsForIP failed", appidentity.ErrUnavailable)
	}
	if !who.Node.KeyExpiry.IsZero() && !who.Node.KeyExpiry.After(time.Now()) {
		return "", fmt.Errorf("%w: Tailscale node key expired", appidentity.ErrUnregistered)
	}
	deviceID, registered := r.registrations[who.Node.StableID]
	if !registered {
		return "", fmt.Errorf("%w: stable node is not registered", appidentity.ErrUnregistered)
	}
	return deviceID, nil
}

func addrPort(address net.Addr) (netip.AddrPort, error) {
	if address == nil {
		return netip.AddrPort{}, errors.New("missing socket address")
	}
	return netip.ParseAddrPort(address.String())
}

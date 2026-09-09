package peer

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"

	appidentity "screencontrol.local/screen-control/internal/identity"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

type fakeWhoIs struct {
	response *apitype.WhoIsResponse
	err      error
	calls    int
	remote   string
	dst      netip.Addr
}

func (f *fakeWhoIs) WhoIsForIP(_ context.Context, remote string, dst netip.Addr) (*apitype.WhoIsResponse, error) {
	f.calls++
	f.remote = remote
	f.dst = dst
	return f.response, f.err
}

func TestResolveMapsStableNodeFromSocketAddresses(t *testing.T) {
	client := &fakeWhoIs{response: &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: "node-stable-nix"}}}
	resolver, err := newResolver(client, map[tailcfg.StableNodeID]string{"node-stable-nix": "nix"})
	if err != nil {
		t.Fatal(err)
	}
	deviceID, err := resolver.Resolve(context.Background(),
		&net.TCPAddr{IP: net.ParseIP("100.64.0.10"), Port: 54321},
		&net.TCPAddr{IP: net.ParseIP("100.64.0.20"), Port: 8444})
	if err != nil {
		t.Fatal(err)
	}
	if deviceID != "nix" {
		t.Fatalf("device = %q, want nix", deviceID)
	}
	if client.remote != "100.64.0.10:54321" || client.dst.String() != "100.64.0.20" {
		t.Fatalf("WhoIsForIP called with remote=%q dst=%q", client.remote, client.dst)
	}
}

func TestResolveRejectsLoopbackAndUnknownNodes(t *testing.T) {
	client := &fakeWhoIs{response: &apitype.WhoIsResponse{Node: &tailcfg.Node{StableID: "unknown"}}}
	resolver, err := newResolver(client, map[tailcfg.StableNodeID]string{"registered": "nix"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = resolver.Resolve(context.Background(),
		&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 5000},
		&net.TCPAddr{IP: net.ParseIP("100.64.0.20"), Port: 8444})
	if !errors.Is(err, appidentity.ErrUnavailable) || client.calls != 0 {
		t.Fatalf("loopback error = %v, calls = %d", err, client.calls)
	}

	_, err = resolver.Resolve(context.Background(),
		&net.TCPAddr{IP: net.ParseIP("100.64.0.9"), Port: 5000},
		&net.TCPAddr{IP: net.ParseIP("100.64.0.20"), Port: 8444})
	if !errors.Is(err, appidentity.ErrUnregistered) {
		t.Fatalf("unknown node error = %v", err)
	}
}

func TestParseRegistrationsRejectsAmbiguousMappings(t *testing.T) {
	registrations, err := ParseRegistrations("echova=node-a,nix=node-b,jiang-chenx=node-c")
	if err != nil || len(registrations) != 3 || registrations["node-b"] != "nix" {
		t.Fatalf("registrations = %#v, err = %v", registrations, err)
	}
	for _, value := range []string{"", "nix", "nix=node-a,nix=node-b", "nix=node-a,echova=node-a"} {
		if _, err := ParseRegistrations(value); err == nil {
			t.Fatalf("ParseRegistrations(%q) unexpectedly succeeded", value)
		}
	}
}

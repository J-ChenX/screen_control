package g0network

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type fakeClient struct {
	mu        sync.Mutex
	count     int
	self      tailcfg.StableNodeID
	responses []*ipnstate.PingResult
}

func (f *fakeClient) Status(context.Context) (*ipnstate.Status, error) {
	return &ipnstate.Status{BackendState: "Running", Self: &ipnstate.PeerStatus{ID: f.self}, Peer: map[key.NodePublic]*ipnstate.PeerStatus{{}: {ID: "node-nix", Online: true, TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.2")}}}}, nil
}
func (f *fakeClient) Ping(_ context.Context, ip netip.Addr, kind tailcfg.PingType) (*ipnstate.PingResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ip.String() != "100.64.0.2" || kind != tailcfg.PingDisco {
		panic("探测了未登记目标")
	}
	n := f.count
	f.count++
	if len(f.responses) == 0 {
		return nil, errors.New("失败")
	}
	if n >= len(f.responses) {
		n = len(f.responses) - 1
	}
	if f.responses[n] == nil {
		return nil, context.DeadlineExceeded
	}
	return f.responses[n], nil
}

func TestProbeVerifiesSourceAndOnlyUsesRegisteredPeer(t *testing.T) {
	r := Request{Source: "lerrem", Nodes: Registry{"lerrem": "node-lerrem", "nix": "node-nix"}}
	f := &fakeClient{self: "wrong"}
	if _, err := probe(context.Background(), f, r, 0); err == nil || f.count != 0 {
		t.Fatal("源身份不匹配时不应探测")
	}
	f.self = "node-lerrem"
	f.responses = []*ipnstate.PingResult{{DERPRegionID: 1, LatencySeconds: .1}, {Endpoint: "[2001:db8::1]:41641", LatencySeconds: .01}}
	out, err := probe(context.Background(), f, r, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := out.Results[0]
	if got.Path != "internet" || got.IPVersion != 6 || !got.InitialRelay || got.Responses != 5 || got.RTTMs == nil || *got.RTTMs != 10 {
		t.Fatalf("未保留中继转直连事实：%+v", got)
	}
}

func TestLastTimeoutMustNotReuseEarlierDirectResult(t *testing.T) {
	f := &fakeClient{self: "node-lerrem", responses: []*ipnstate.PingResult{{Endpoint: "192.168.1.2:41641", LatencySeconds: .01}, nil}}
	out, err := probe(context.Background(), f, Request{Source: "lerrem", Nodes: Registry{"lerrem": "node-lerrem", "nix": "node-nix"}}, 0)
	if err != nil || out.Results[0].Path != "timeout" || out.Results[0].IPVersion != 0 || out.Results[0].RTTMs != nil {
		t.Fatalf("最后一次失败应保持未知：%+v %v", out, err)
	}
}

func TestConnectionClassificationDoesNotInferDirectFromRelayMetadata(t *testing.T) {
	for _, tc := range []struct {
		result  ipnstate.PingResult
		want    string
		version int
	}{
		{ipnstate.PingResult{Endpoint: "192.168.1.2:41641"}, "lan", 4},
		{ipnstate.PingResult{Endpoint: "203.0.113.2:41641"}, "internet", 4},
		{ipnstate.PingResult{Endpoint: "[2001:db8::1]:41641"}, "internet", 6},
		{ipnstate.PingResult{Endpoint: "[fd12::2]:41641"}, "lan", 6},
		{ipnstate.PingResult{Endpoint: "[fe80::2%eth0]:41641"}, "lan", 6},
		{ipnstate.PingResult{Endpoint: "[::ffff:192.168.1.2]:41641"}, "lan", 4},
		{ipnstate.PingResult{Endpoint: "100.64.1.2:41641"}, "unavailable", 0},
		{ipnstate.PingResult{Endpoint: "[fd7a:115c:a1e0::2]:41641"}, "unavailable", 0},
		{ipnstate.PingResult{Endpoint: "127.0.0.1:41641"}, "unavailable", 0},
		{ipnstate.PingResult{DERPRegionID: 1, Endpoint: "[2001:db8::1]:41641"}, "derp", 0},
		{ipnstate.PingResult{PeerRelay: "192.168.1.3:41641:vni:1"}, "peer-relay", 0},
		{ipnstate.PingResult{}, "unavailable", 0},
	} {
		if got, version := classify(&tc.result); got != tc.want || version != tc.version {
			t.Errorf("路径判定 %s/IPv%d，期望 %s/IPv%d", got, version, tc.want, tc.version)
		}
	}
}

func TestCanceledProbeStopsWithoutPublishingDirect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &fakeClient{self: "node-lerrem"}
	out, err := probe(ctx, f, Request{Source: "lerrem", Nodes: Registry{"lerrem": "node-lerrem", "nix": "node-nix"}}, time.Second)
	if err != nil || f.count != 0 || out.Results[0].Path != "unavailable" {
		t.Fatal("取消探测不应发布成功")
	}
}

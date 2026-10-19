// g0network 只探测登记节点之间的 Tailscale 路径，不接受地址或命令。
package g0network

import (
	"context"
	"errors"
	"math"
	"net/netip"
	"sort"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

type Registry map[string]tailcfg.StableNodeID

type Request struct {
	Source string   `json:"source"`
	Nodes  Registry `json:"nodes"`
}

type Result struct {
	Source       string   `json:"source"`
	Target       string   `json:"target"`
	Path         string   `json:"path"`
	IPVersion    int      `json:"ipVersion,omitempty"`
	RTTMs        *float64 `json:"rttMs,omitempty"`
	InitialRelay bool     `json:"initialRelay"`
	Responses    int      `json:"responses"`
	Attempts     int      `json:"attempts"`
}

type Output struct {
	Version    int                  `json:"version"`
	SourceNode tailcfg.StableNodeID `json:"sourceNode"`
	Results    []Result             `json:"results"`
}

type Client interface {
	Status(context.Context) (*ipnstate.Status, error)
	Ping(context.Context, netip.Addr, tailcfg.PingType) (*ipnstate.PingResult, error)
}

func ValidDevice(id string) bool {
	return id == "echova" || id == "nix" || id == "jiang-chenx" || id == "lerrem"
}

func (r Request) Validate() error {
	if !ValidDevice(r.Source) || len(r.Nodes) < 2 || len(r.Nodes) > 4 || r.Nodes[r.Source] == "" {
		return errors.New("登记节点配置无效")
	}
	seen := map[tailcfg.StableNodeID]bool{}
	for id, node := range r.Nodes {
		if !ValidDevice(id) || len(node) == 0 || len(node) > 128 || seen[node] {
			return errors.New("登记节点配置无效")
		}
		seen[node] = true
	}
	return nil
}

func Probe(ctx context.Context, r Request) (Output, error) {
	return probe(ctx, new(local.Client), r, 500*time.Millisecond)
}

func probe(ctx context.Context, client Client, r Request, interval time.Duration) (Output, error) {
	if err := r.Validate(); err != nil {
		return Output{}, err
	}
	status, err := client.Status(ctx)
	if err != nil || status == nil || status.Self == nil || status.BackendState != "Running" || status.Self.ID != r.Nodes[r.Source] {
		return Output{}, errors.New("无法核验探测电脑的 Tailscale 身份")
	}
	ids := make([]string, 0, len(r.Nodes)-1)
	for id := range r.Nodes {
		if id != r.Source {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	out := Output{Version: 1, SourceNode: status.Self.ID, Results: make([]Result, len(ids))}
	var wg sync.WaitGroup
	for i, id := range ids {
		var peer *ipnstate.PeerStatus
		for _, p := range status.Peer {
			if p.ID == r.Nodes[id] {
				peer = p
				break
			}
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			result := Result{Source: r.Source, Target: id, Path: "unavailable"}
			if peer == nil || len(peer.TailscaleIPs) == 0 {
				out.Results[i] = result
				return
			}
			for n := 0; n < 5 && ctx.Err() == nil; n++ {
				pingCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
				p, pingErr := client.Ping(pingCtx, peer.TailscaleIPs[0], tailcfg.PingDisco)
				cancel()
				result.Attempts++
				previous := result.Path
				result.Path, result.IPVersion, result.RTTMs = "unavailable", 0, nil
				if errors.Is(pingErr, context.DeadlineExceeded) {
					result.Path = "timeout"
				}
				if pingErr == nil && p != nil && p.Err == "" {
					result.Path, result.IPVersion = classify(p)
					if result.Path != "unavailable" && !math.IsNaN(p.LatencySeconds) && !math.IsInf(p.LatencySeconds, 0) && p.LatencySeconds >= 0 && p.LatencySeconds <= 120 {
						ms := math.Round(p.LatencySeconds*10000) / 10
						result.RTTMs = &ms
						result.Responses++
					} else {
						result.Path, result.IPVersion = "unavailable", 0
					}
				}
				if previous == "derp" || previous == "peer-relay" {
					result.InitialRelay = true
				}
				if n < 4 {
					select {
					case <-ctx.Done():
					case <-time.After(interval):
					}
				}
			}
			if result.Responses == 0 && !peer.Online {
				result.Path = "offline"
			}
			out.Results[i] = result
		}()
	}
	wg.Wait()
	return out, nil
}

func classify(p *ipnstate.PingResult) (string, int) {
	if p.PeerRelay != "" {
		return "peer-relay", 0
	}
	if p.DERPRegionID != 0 {
		return "derp", 0
	}
	endpoint, err := netip.ParseAddrPort(p.Endpoint)
	if err != nil {
		return "unavailable", 0
	}
	ip := endpoint.Addr().Unmap()
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip) {
		return "unavailable", 0
	}
	ipVersion := 6
	if ip.Is4() {
		ipVersion = 4
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return "lan", ipVersion
	}
	return "internet", ipVersion
}

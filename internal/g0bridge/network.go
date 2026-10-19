package g0bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"screencontrol.local/screen-control/internal/g0network"
	"screencontrol.local/screen-control/internal/identity/peer"
	"tailscale.com/client/local"
)

type networkSnapshot struct {
	State       string             `json:"state"`
	StartedAt   string             `json:"startedAt,omitempty"`
	CompletedAt string             `json:"completedAt,omitempty"`
	Results     []g0network.Result `json:"results"`
}

// NetworkTester 为私网与网关共用一轮有界探测，不随页面轮询启动后台循环。
type NetworkTester struct {
	mu      sync.Mutex
	current networkSnapshot
	started time.Time
	nodes   g0network.Registry
	targets map[string]string
	via     map[string]string
	probe   func(context.Context, string) ([]g0network.Result, error)
}

func NewNetworkTester(registry, targets, via string) (*NetworkTester, error) {
	registrations, err := peer.ParseRegistrations(registry)
	if err != nil {
		return nil, errors.New("直连测试需要登记节点配置")
	}
	t := &NetworkTester{nodes: g0network.Registry{}, targets: map[string]string{}, via: map[string]string{}}
	for node, id := range registrations {
		if g0network.ValidDevice(id) {
			t.nodes[id] = node
		}
	}
	if len(t.nodes) < 2 {
		return nil, errors.New("直连测试至少需要两台登记电脑")
	}
	for index, value := range []string{targets, via} {
		seen := map[string]bool{}
		for _, entry := range strings.Split(value, ",") {
			if strings.TrimSpace(entry) == "" {
				continue
			}
			id, target, ok := strings.Cut(strings.TrimSpace(entry), "=")
			if !ok || t.nodes[id] == "" || seen[id] {
				return nil, errors.New("直连测试目标配置无效")
			}
			seen[id] = true
			if index == 0 {
				if !fileTargetPattern.MatchString(target) || strings.EqualFold(strings.SplitN(target, "@", 2)[0], "root") {
					return nil, errors.New("直连测试 SSH 目标无效")
				}
				t.targets[id] = target
			} else {
				if t.nodes[target] == "" || target == id || target == "jiang-chenx" {
					return nil, errors.New("直连测试运维入口无效")
				}
				t.via[id] = target
			}
		}
	}
	for id, viaID := range t.via {
		if t.targets[id] == "" || t.targets[viaID] == "" || t.via[viaID] != "" {
			return nil, errors.New("直连测试运维入口配置不完整")
		}
	}
	t.current = networkSnapshot{State: "idle", Results: t.emptyResults("unavailable")}
	t.probe = t.runSource
	return t, nil
}

func (t *NetworkTester) emptyResults(path string) []g0network.Result {
	ids := make([]string, 0, len(t.nodes))
	for id := range t.nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	results := make([]g0network.Result, 0, len(ids)*(len(ids)-1))
	for _, source := range ids {
		for _, target := range ids {
			if source != target {
				results = append(results, g0network.Result{Source: source, Target: target, Path: path})
			}
		}
	}
	return results
}

func (t *NetworkTester) snapshot() networkSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked()
}

func (t *NetworkTester) snapshotLocked() networkSnapshot {
	snapshot := t.current
	snapshot.Results = append([]g0network.Result{}, t.current.Results...)
	return snapshot
}

func (t *NetworkTester) start() (networkSnapshot, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.current.State == "running" {
		return t.snapshotLocked(), true
	}
	if time.Since(t.started) < 15*time.Second {
		return t.snapshotLocked(), false
	}
	t.started = time.Now()
	t.current = networkSnapshot{State: "running", StartedAt: t.started.UTC().Format(time.RFC3339), Results: t.emptyResults("pending")}
	go t.run()
	return t.snapshotLocked(), true
}

func (t *NetworkTester) run() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for source := range t.nodes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results, err := t.probe(ctx, source)
			if err != nil || !t.validResults(source, results) {
				results = nil
				for target := range t.nodes {
					if target != source {
						results = append(results, g0network.Result{Source: source, Target: target, Path: "unavailable"})
					}
				}
			}
			t.mu.Lock()
			for i, old := range t.current.Results {
				for _, result := range results {
					if old.Source == result.Source && old.Target == result.Target {
						t.current.Results[i] = result
					}
				}
			}
			t.mu.Unlock()
		}()
	}
	wg.Wait()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.current.State = "complete"
	t.current.CompletedAt = time.Now().UTC().Format(time.RFC3339)
}

func (t *NetworkTester) validResults(source string, results []g0network.Result) bool {
	if len(results) != len(t.nodes)-1 {
		return false
	}
	seen := map[string]bool{}
	for _, r := range results {
		if r.Source != source || r.Target == source || t.nodes[r.Target] == "" || seen[r.Target] || r.Attempts < 0 || r.Attempts > 5 || r.Responses < 0 || r.Responses > r.Attempts {
			return false
		}
		seen[r.Target] = true
		switch r.Path {
		case "lan", "internet", "derp", "peer-relay":
			if r.Responses == 0 || r.RTTMs == nil {
				return false
			}
		case "timeout", "offline", "unavailable":
			if r.RTTMs != nil || r.IPVersion != 0 {
				return false
			}
		default:
			return false
		}
		if r.Path == "lan" || r.Path == "internet" {
			// 旧探针不提供协议族时保留未知，不根据 Tailscale 虚拟 IP 猜测。
			if r.IPVersion != 0 && r.IPVersion != 4 && r.IPVersion != 6 {
				return false
			}
		} else if r.IPVersion != 0 {
			return false
		}
		if r.RTTMs != nil && (math.IsNaN(*r.RTTMs) || math.IsInf(*r.RTTMs, 0) || *r.RTTMs < 0 || *r.RTTMs > 120000) {
			return false
		}
	}
	return true
}

type limitedNetworkOutput struct{ buffer bytes.Buffer }

func (b *limitedNetworkOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 64*1024 {
		return 0, errors.New("探针响应超限")
	}
	return b.buffer.Write(p)
}

func (b *limitedNetworkOutput) Read(p []byte) (int, error) { return b.buffer.Read(p) }

func networkSSHArgs(target, command string) []string {
	return []string{"-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "ServerAliveInterval=3", "-o", "ServerAliveCountMax=2", "--", target, command}
}

func (t *NetworkTester) runSource(ctx context.Context, source string) ([]g0network.Result, error) {
	request := g0network.Request{Source: source, Nodes: t.nodes}
	statusCtx, cancel := context.WithTimeout(ctx, time.Second)
	status, err := new(local.Client).StatusWithoutPeers(statusCtx)
	cancel()
	if err == nil && status != nil && status.Self != nil && status.Self.ID == t.nodes[source] {
		probeCtx, stop := context.WithTimeout(ctx, 9*time.Second)
		defer stop()
		out, err := g0network.Probe(probeCtx, request)
		return out.Results, err
	}
	target := t.targets[source]
	if target == "" {
		return nil, errors.New("未配置探针入口")
	}
	command := `exec "$HOME/.local/lib/screen-control-network-probe/current/screen-control-network-probe"`
	if source == "jiang-chenx" {
		command = `"%USERPROFILE%\.local\lib\screen-control-network-probe\current\screen-control-network-probe.exe"`
	}
	args := networkSSHArgs(target, command)
	if via := t.via[source]; via != "" {
		// 参数来自经验证的服务端配置，只有固定探针路径参与 shell 引用。
		quoted := make([]string, len(args)+1)
		for i, arg := range append([]string{"ssh"}, args...) {
			quoted[i] = "'" + strings.ReplaceAll(arg, "'", "'\"'\"'") + "'"
		}
		args = networkSSHArgs(t.targets[via], strings.Join(quoted, " "))
	}
	input, _ := json.Marshal(request)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 250 * time.Millisecond
	var output limitedNetworkOutput
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		return nil, errors.New("探针连接失败")
	}
	var response g0network.Output
	decoder := json.NewDecoder(&output)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&response) != nil || decoder.Decode(new(any)) != io.EOF || response.Version != 1 || response.SourceNode != t.nodes[source] {
		return nil, errors.New("探针身份或响应无效")
	}
	return response.Results, nil
}

func (s *Server) SetNetworkTester(t *NetworkTester) { s.network = t }

func (s *Server) handleNetworkTest(w http.ResponseWriter, r *http.Request) {
	reqID := requestID()
	if _, ok := s.resolveDevice(w, r, reqID); !ok {
		return
	}
	if s.network == nil {
		s.writeError(w, 503, reqID, "NETWORK_TEST_UNAVAILABLE", "直连测试尚未配置")
		return
	}
	if r.Method == http.MethodGet {
		s.writeJSON(w, 200, reqID, s.network.snapshot(), nil)
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256))
	decoder.DisallowUnknownFields()
	var body map[string]json.RawMessage
	if decoder.Decode(&body) != nil || body == nil || len(body) != 0 || decoder.Decode(new(any)) != io.EOF {
		s.writeError(w, 400, reqID, "INVALID_REQUEST", "直连测试只接受空对象，不接受目标或命令")
		return
	}
	snapshot, ok := s.network.start()
	if !ok {
		w.Header().Set("Retry-After", "15")
		s.writeError(w, 429, reqID, "NETWORK_TEST_RATE_LIMITED", "请稍后再测试，两轮测试至少间隔 15 秒")
		return
	}
	s.writeJSON(w, http.StatusAccepted, reqID, snapshot, nil)
}

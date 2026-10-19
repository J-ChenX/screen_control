package g0bridge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"screencontrol.local/screen-control/internal/g0network"
)

func networkFixture(t *testing.T) *NetworkTester {
	t.Helper()
	x, err := NewNetworkTester("lerrem=node-lerrem,nix=node-nix,xiaomi-15=node-phone", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return x
}

func TestNetworkTestChecksIdentityOriginAndRejectsCustomCommands(t *testing.T) {
	for _, tc := range []struct {
		identity, origin, body string
		want                   int
	}{
		{"nix", "http://127.0.0.1:5173", `{}`, 202},
		{"unknown", "http://127.0.0.1:5173", `{}`, 403},
		{"nix", "https://evil.example", `{}`, 403},
		{"nix", "http://127.0.0.1:5173", `{"target":"8.8.8.8"}`, 400},
		{"nix", "http://127.0.0.1:5173", `{"command":"id"}`, 400},
		{"nix", "http://127.0.0.1:5173", `{} {}`, 400},
		{"nix", "http://127.0.0.1:5173", `null`, 400},
	} {
		x := networkFixture(t)
		var called atomic.Int32
		x.probe = func(context.Context, string) ([]g0network.Result, error) { called.Add(1); return nil, nil }
		s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity(tc.identity), slog.New(slog.NewTextHandler(io.Discard, nil)))
		s.SetNetworkTester(x)
		r := httptest.NewRequest("POST", "/api/v1/network/tests", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%+v：%d %s", tc, w.Code, w.Body.String())
		}
		if tc.want != 202 && called.Load() != 0 {
			t.Fatal("拒绝请求启动了探测")
		}
	}
}

func TestNetworkTestsShareOneBoundedJobAndRejectInvalidSourceOutput(t *testing.T) {
	x := networkFixture(t)
	gate := make(chan struct{})
	var calls atomic.Int32
	x.probe = func(ctx context.Context, source string) ([]g0network.Result, error) {
		calls.Add(1)
		select {
		case <-gate:
		case <-ctx.Done():
		}
		return []g0network.Result{{Source: source, Target: "unknown", Path: "internet"}}, nil
	}
	if _, ok := x.start(); !ok {
		t.Fatal("未启动")
	}
	for i := 0; i < 5; i++ {
		if _, ok := x.start(); !ok {
			t.Fatal("并发应共用当前检测")
		}
	}
	close(gate)
	deadline := time.Now().Add(time.Second)
	for x.snapshot().State != "complete" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	s := x.snapshot()
	if s.State != "complete" || calls.Load() != 2 || len(s.Results) != 2 {
		t.Fatalf("共享任务异常：%+v %d", s, calls.Load())
	}
	for _, r := range s.Results {
		if r.Path != "unavailable" {
			t.Fatal("无效结果不应发布成功")
		}
	}
	if _, ok := x.start(); ok {
		t.Fatal("连续检测应限流")
	}
	data, _ := json.Marshal(s)
	if strings.Contains(string(data), "node-") {
		t.Fatal("响应泄漏了稳定节点 ID")
	}
}

func TestNetworkProbeConfigurationRejectsInjectionAndRoutingCycles(t *testing.T) {
	for _, tc := range []struct{ targets, via string }{
		{"nix=user@host;id", ""}, {"nix=root@host", ""}, {"nix=user@host,nix=user@host", ""},
		{"nix=user@host,lerrem=user@host", "nix=lerrem,lerrem=nix"}, {"nix=user@host", "nix=lerrem"},
	} {
		if _, err := NewNetworkTester("lerrem=node-lerrem,nix=node-nix", tc.targets, tc.via); err == nil {
			t.Fatalf("不应接受配置 %+v", tc)
		}
	}
}

func TestNetworkGetRequiresRegisteredIdentity(t *testing.T) {
	s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity("unknown"), nil)
	s.SetNetworkTester(networkFixture(t))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/network/tests", nil))
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestNetworkOutputCopyCannotBypassSizeLimit(t *testing.T) {
	var output limitedNetworkOutput
	if _, err := io.Copy(&output, strings.NewReader(strings.Repeat("x", 65537))); err == nil {
		t.Fatal("输出复制绕过了响应大小限制")
	}
	if output.buffer.Len() > 65536 {
		t.Fatal("探针响应没有保持有界")
	}
}

func TestNetworkResultsValidateIPVersionWithoutGuessingOldProbe(t *testing.T) {
	x := networkFixture(t)
	ms := 10.0
	for _, tc := range []struct {
		path    string
		version int
		valid   bool
	}{
		{"lan", 4, true}, {"lan", 6, true}, {"internet", 4, true}, {"internet", 6, true},
		{"internet", 0, true}, {"internet", 5, false}, {"derp", 6, false},
	} {
		result := g0network.Result{Source: "lerrem", Target: "nix", Path: tc.path, IPVersion: tc.version, RTTMs: &ms, Responses: 5, Attempts: 5}
		if x.validResults("lerrem", []g0network.Result{result}) != tc.valid {
			t.Fatalf("协议版本校验不符：%+v", tc)
		}
	}
}

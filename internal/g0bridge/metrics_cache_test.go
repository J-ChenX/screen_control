package g0bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestSlowMetricsDoNotBlockSnapshotsOrDeviceChecks(t *testing.T) {
	t.Setenv("SCREEN_CONTROL_METRICS_LOCAL_DEVICE", "")
	t.Setenv("SCREEN_CONTROL_METRICS_SSH_TARGETS", "")
	var requests atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var message map[string]any
			json.Unmarshal(raw, &message)
			if message["action"] == "nodes" {
				writeJSON(r.Context(), conn, map[string]any{"action": "nodes", "nodes": []map[string]any{{"_id": "node/nix", "name": "nix", "conn": 1}}})
			} else if message["type"] == "cpuinfo" {
				requests.Add(1)
				once.Do(func() { close(started) })
				<-release
				writeJSON(r.Context(), conn, map[string]any{"action": "msg", "type": "cpuinfo", "nodeid": "node/nix", "tag": "portal-metrics", "cpu": map[string]any{"total": 12.5}})
			}
		}
	}))
	defer server.Close()
	secret := filepath.Join(t.TempDir(), "credential")
	if err := os.WriteFile(secret, []byte("test-only"), 0600); err != nil {
		t.Fatal(err)
	}
	value, err := NewMeshClient(server.URL, "test", secret)
	if err != nil {
		t.Fatal(err)
	}
	client := value.(*meshClient)
	defer func() { close(release); waitMetrics(t, client) }()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	devices, err := client.Snapshot(ctx)
	if err != nil || len(devices) != 1 || devices[0].Metrics.CPUPercent != nil {
		t.Fatalf("首次快照应立即返回缺失指标：%+v %v", devices, err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("未启动后台采样")
	}
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := client.Snapshot(ctx); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	states, err := client.Devices(ctx)
	if err != nil || len(states) != 1 || states[0].Metrics != nil {
		t.Fatalf("会话状态校验不应查询指标：%+v %v", states, err)
	}
	if requests.Load() != 1 {
		t.Fatalf("并发页面重复采样：%d", requests.Load())
	}
}

func TestMetricsCopiesDoNotShareMutableValues(t *testing.T) {
	cpu, memory := 12.5, uint64(1024)
	value := &DeviceMetrics{CPUPercent: &cpu, MemoryUsedBytes: &memory, GPUs: []GPUMetrics{{Utilization: &cpu, MemoryUsedBytes: &memory}}}
	copy := cloneMetrics(value)
	*copy.CPUPercent = 99
	*copy.MemoryUsedBytes = 2
	*copy.GPUs[0].Utilization = 90
	*copy.GPUs[0].MemoryUsedBytes = 3
	if cpu != 12.5 || memory != 1024 {
		t.Fatal("调用方修改污染共享指标")
	}
}

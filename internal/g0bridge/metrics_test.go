package g0bridge

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseLiveCPUAndMemory(t *testing.T) {
	for _, raw := range []string{`{"cpu":{"total":0},"memory":{"total":1024,"free":256}}`, `{"cpu":{"total":0},"memory":{"MemTotal":"1048576","MemFree":"262144"}}`} {
		got := parseCPUInfo([]byte(raw))
		if got.CPUPercent == nil || *got.CPUPercent != 0 || got.MemoryUsedBytes == nil || *got.MemoryUsedBytes != 786432 || *got.MemoryTotalBytes != 1048576 {
			t.Fatalf("bad sample: %+v", got)
		}
	}
	got := parseCPUInfo([]byte(`{"cpu":{"total":null},"memory":{"total":10,"free":20}}`))
	if got.CPUPercent != nil || got.MemoryUsedBytes != nil {
		t.Fatal("unknown data rendered as valid")
	}
	if parseCPUInfo([]byte(`{"cpu":{"total":101}}`)).CPUPercent != nil {
		t.Fatal("invalid percentage accepted")
	}
}
func TestParseGPU(t *testing.T) {
	got := parseGPUCSV("RTX 3090, 0, 1024, 24576\nGPU 2, [N/A], [N/A], 1000\n")
	if len(got) != 2 || got[0].Utilization == nil || *got[0].Utilization != 0 || *got[0].MemoryUsedBytes != 1<<30 || got[1].Utilization != nil || got[1].MemoryUsedBytes != nil {
		t.Fatalf("bad GPU values: %+v", got)
	}
}
func TestMetricsRoutesSamplesToCorrectDevice(t *testing.T) {
	t.Setenv("SCREEN_CONTROL_METRICS_LOCAL_DEVICE", "")
	t.Setenv("SCREEN_CONTROL_METRICS_SSH_TARGETS", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg map[string]any
			json.Unmarshal(raw, &msg)
			if msg["action"] == "nodes" {
				writeJSON(ctx, conn, map[string]any{"action": "nodes", "nodes": []map[string]any{{"_id": "node/nix", "name": "nix", "conn": 1}, {"_id": "node/echova", "name": "echova", "conn": 0}}})
			} else if msg["type"] == "cpuinfo" {
				writeJSON(ctx, conn, map[string]any{"action": "msg", "type": "cpuinfo", "tag": "wrong-tag", "nodeid": "node/nix", "cpu": map[string]any{"total": 99}})
				writeJSON(ctx, conn, map[string]any{"action": "msg", "type": "cpuinfo", "tag": msg["tag"], "nodeid": "node/nix", "cpu": map[string]any{"total": 12.5}, "memory": map[string]any{"total": 1024, "free": 512}})
			}
		}
	}))
	defer server.Close()
	secret := filepath.Join(t.TempDir(), "credential")
	os.WriteFile(secret, []byte("test-only"), 0600)
	client, err := NewMeshClient(server.URL, "test", secret)
	if err != nil {
		t.Fatal(err)
	}
	devices, err := client.Devices(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 2 || devices[0].Metrics.CPUPercent == nil || *devices[0].Metrics.CPUPercent != 12.5 || devices[1].Metrics.CPUPercent != nil || devices[1].Metrics.GPUStatus != "offline" {
		t.Fatalf("incorrect samples: %+v", devices)
	}
	body, _ := json.Marshal(devices)
	if strings.Contains(string(body), "hardware") {
		t.Fatal("inventory leaked into live status")
	}
}

package g0bridge

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
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
	_, err = client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	waitMetrics(t, client.(*meshClient))
	devices, err := client.Snapshot(context.Background())
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
	concrete := client.(*meshClient)
	concrete.metrics.mu.Lock()
	concrete.metrics.completedAt = time.Now().Add(-metricsMaxAge - time.Second)
	concrete.metrics.mu.Unlock()
	stale, err := client.Snapshot(context.Background())
	if err != nil || stale[0].Metrics.CPUPercent != nil {
		t.Fatal("过期指标仍显示为有效")
	}
	concrete.metrics.mu.Lock()
	concrete.metrics.completedAt = time.Now()
	sample := concrete.metrics.samples["nix"]
	sample.nodeID = "node/replaced"
	concrete.metrics.samples["nix"] = sample
	concrete.metrics.mu.Unlock()
	replaced, err := client.Snapshot(context.Background())
	if err != nil || replaced[0].Metrics.CPUPercent != nil {
		t.Fatal("新节点复用了旧节点指标")
	}
}

func waitMetrics(t *testing.T, client *meshClient) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		client.metrics.mu.Lock()
		running := client.metrics.running
		client.metrics.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("指标采样未在截止时间结束")
}

// 使用隔离的命令与 DRM 目录复现驱动失败，避免依赖测试机显卡。
func TestLinuxGPUQueryPreservesFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux GPU 查询使用 POSIX shell")
	}
	for _, tc := range []struct {
		name, nvidia string
		amd, failed  bool
		count        int
	}{
		{name: "驱动版本不匹配", nvidia: "echo 'Failed to initialize NVML: Driver/library version mismatch' >&2; exit 9", failed: true},
		{name: "失败仍输出部分数据", nvidia: "echo 'RTX, 12, 1024, 24576'; exit 9", failed: true, count: 1},
		{name: "NVIDIA正常", nvidia: "echo 'RTX, 12, 1024, 24576'", count: 1},
		{name: "没有支持的采集器"},
		{name: "AMD正常", amd: true, count: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.nvidia != "" {
				if err := os.WriteFile(filepath.Join(dir, "nvidia-smi"), []byte("#!/bin/sh\n"+tc.nvidia+"\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			// AMD 使用 cat；仅提供系统 cat，不把系统 nvidia-smi 带入 PATH。
			cat, err := exec.LookPath("cat")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(cat, filepath.Join(dir, "cat")); err != nil {
				t.Fatal(err)
			}
			drm := filepath.Join(dir, "drm")
			if tc.amd {
				device := filepath.Join(drm, "card1", "device")
				if err := os.MkdirAll(device, 0700); err != nil {
					t.Fatal(err)
				}
				for name, value := range map[string]string{"gpu_busy_percent": "5", "mem_info_vram_used": "1048576", "mem_info_vram_total": "4194304"} {
					if err := os.WriteFile(filepath.Join(device, name), []byte(value), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, "/bin/sh", "-c", strings.ReplaceAll(linuxGPUQuery, "/sys/class/drm", drm))
			cmd.Env = append(os.Environ(), "PATH="+dir)
			output, err := cmd.Output()
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
			if (err != nil) != tc.failed {
				t.Fatalf("查询退出状态错误：err=%v, output=%s", err, output)
			}
			if got := len(parseGPUCSV(string(output))); got != tc.count {
				t.Fatalf("GPU 样本数量：%d，预期 %d", got, tc.count)
			}
		})
	}
}

func TestCollectGPUDriverFailureIsUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux GPU 查询使用 POSIX shell")
	}
	dir := t.TempDir()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sh, filepath.Join(dir, "sh")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nvidia-smi"), []byte("#!/bin/sh\necho 'Failed to initialize NVML' >&2\nexit 9\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("SCREEN_CONTROL_METRICS_LOCAL_DEVICE", "local-test")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	gpus, status := collectGPU(ctx, "local-test", "Ubuntu")
	if len(gpus) != 0 || status != "unavailable" {
		t.Fatalf("驱动故障被误分类：%s %+v", status, gpus)
	}
}

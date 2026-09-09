package g0bridge

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type DeviceMetrics struct {
	SampledAt        string       `json:"sampledAt,omitempty"`
	CPUPercent       *float64     `json:"cpuPercent"`
	MemoryUsedBytes  *uint64      `json:"memoryUsedBytes"`
	MemoryTotalBytes *uint64      `json:"memoryTotalBytes"`
	GPUs             []GPUMetrics `json:"gpus"`
	GPUStatus        string       `json:"gpuStatus"`
}
type GPUMetrics struct {
	Name             string   `json:"name"`
	Utilization      *float64 `json:"utilization"`
	MemoryUsedBytes  *uint64  `json:"memoryUsedBytes"`
	MemoryTotalBytes *uint64  `json:"memoryTotalBytes"`
	SampledAt        string   `json:"sampledAt"`
}

func validPercent(value *float64) *float64 {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > 100 {
		return nil
	}
	return value
}
func parseCPUInfo(raw []byte) *DeviceMetrics {
	var sample struct {
		CPU struct {
			Total *float64 `json:"total"`
		} `json:"cpu"`
		Memory struct {
			Total    *uint64 `json:"total"`
			Free     *uint64 `json:"free"`
			WinTotal string  `json:"MemTotal"`
			WinFree  string  `json:"MemFree"`
		} `json:"memory"`
	}
	if json.Unmarshal(raw, &sample) != nil {
		return nil
	}
	result := &DeviceMetrics{CPUPercent: validPercent(sample.CPU.Total), SampledAt: time.Now().UTC().Format(time.RFC3339)}
	var total, free uint64
	valid := false
	if sample.Memory.Total != nil && sample.Memory.Free != nil && *sample.Memory.Total <= math.MaxUint64/1024 && *sample.Memory.Free <= math.MaxUint64/1024 {
		total, free = *sample.Memory.Total*1024, *sample.Memory.Free*1024
		valid = true
	} else if sample.Memory.WinTotal != "" {
		var e1, e2 error
		total, e1 = strconv.ParseUint(sample.Memory.WinTotal, 10, 64)
		free, e2 = strconv.ParseUint(sample.Memory.WinFree, 10, 64)
		valid = e1 == nil && e2 == nil
	}
	if valid && total > 0 && free <= total {
		used := total - free
		result.MemoryTotalBytes = &total
		result.MemoryUsedBytes = &used
	}
	return result
}

// 使用有时限的只读原生指标请求；设备未响应时，
// 不得阻止返回其他设备的信息或在线状态快照。
func (c *meshClient) collectMetrics(ctx context.Context, conn *websocket.Conn, devices []Device) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	gpuResults := make([][]GPUMetrics, len(devices))
	gpuStates := make([]string, len(devices))
	pending := map[string]int{}
	for i := range devices {
		devices[i].Metrics = &DeviceMetrics{GPUStatus: "unavailable"}
		if devices[i].State != "online" {
			devices[i].Metrics.GPUStatus = "offline"
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			gpuResults[i], gpuStates[i] = collectGPU(ctx, devices[i].ID, devices[i].Platform)
		}(i)
		if writeJSON(ctx, conn, map[string]any{"action": "msg", "type": "cpuinfo", "nodeid": devices[i].NodeID, "tag": "portal-metrics"}) == nil {
			pending[devices[i].NodeID] = i
		}
	}
	for len(pending) > 0 {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var message struct {
			Action string
			Type   string
			NodeID string `json:"nodeid"`
			Tag    string
		}
		if json.Unmarshal(raw, &message) != nil || message.Action != "msg" || message.Type != "cpuinfo" || message.Tag != "portal-metrics" {
			continue
		}
		i, ok := pending[message.NodeID]
		if !ok {
			continue
		}
		delete(pending, message.NodeID)
		if metrics := parseCPUInfo(raw); metrics != nil {
			devices[i].Metrics = metrics
		}
	}
	wg.Wait()
	for i := range devices {
		if devices[i].State == "online" {
			devices[i].Metrics.GPUs = gpuResults[i]
			devices[i].Metrics.GPUStatus = gpuStates[i]
		}
	}
}

// Linux DRM 无需 root 权限即可提供 AMD 忙碌百分比和独立显存指标。
const linuxGPUQuery = `if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits; fi
for device in /sys/class/drm/card[0-9]*/device; do
 [ -r "$device/gpu_busy_percent" ] || continue
 busy=$(cat "$device/gpu_busy_percent")
 used="[N/A]"; total="[N/A]"
 if [ -r "$device/mem_info_vram_used" ]; then value=$(cat "$device/mem_info_vram_used"); used=$((value / 1048576)); fi
 if [ -r "$device/mem_info_vram_total" ]; then value=$(cat "$device/mem_info_vram_total"); total=$((value / 1048576)); fi
 printf 'AMD GPU (%s), %s, %s, %s\n' "$device" "$busy" "$used" "$total"
done`

const gpuQuery = "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"

// 目标只能由服务运维人员配置，禁止从 HTTP 输入获取。
// 不提供远程终端或任意命令执行端点。
func collectGPU(ctx context.Context, id, platform string) ([]GPUMetrics, string) {
	var cmd *exec.Cmd
	if id == os.Getenv("SCREEN_CONTROL_METRICS_LOCAL_DEVICE") {
		cmd = exec.CommandContext(ctx, "sh", "-c", linuxGPUQuery)
	} else {
		target := ""
		for _, entry := range strings.Split(os.Getenv("SCREEN_CONTROL_METRICS_SSH_TARGETS"), ",") {
			key, value, ok := strings.Cut(entry, "=")
			if ok && key == id {
				target = value
			}
		}
		if target == "" {
			return nil, "unsupported"
		}
		query := gpuQuery
		if platform == "Ubuntu" {
			query = linuxGPUQuery
		}
		cmd = exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=2", "-o", "ConnectionAttempts=1", "--", target, query)
	}
	output, err := cmd.Output()
	if err != nil {
		return nil, "unavailable"
	}
	result := parseGPUCSV(string(output))
	if len(result) == 0 {
		return nil, "unsupported"
	}
	return result, "live"
}
func parseGPUCSV(output string) []GPUMetrics {
	var result []GPUMetrics
	reader := csv.NewReader(strings.NewReader(output))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		if len(row) != 4 {
			continue
		}
		gpu := GPUMetrics{Name: strings.TrimSpace(row[0]), SampledAt: time.Now().UTC().Format(time.RFC3339)}
		if n, err := strconv.ParseFloat(strings.TrimSpace(row[1]), 64); err == nil {
			gpu.Utilization = validPercent(&n)
		}
		bytes := func(s string) *uint64 {
			n, e := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
			if e != nil || n > math.MaxUint64/(1<<20) {
				return nil
			}
			n *= 1 << 20
			return &n
		}
		gpu.MemoryUsedBytes = bytes(row[2])
		gpu.MemoryTotalBytes = bytes(row[3])
		if gpu.MemoryTotalBytes != nil && gpu.MemoryUsedBytes != nil && *gpu.MemoryUsedBytes > *gpu.MemoryTotalBytes {
			gpu.MemoryUsedBytes = nil
		}
		if gpu.Name != "" {
			result = append(result, gpu)
		}
	}
	return result
}

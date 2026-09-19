package g0bridge

import (
	"context"
	"sync"
	"time"
)

const metricsRefreshInterval = 5 * time.Second
const metricsMaxAge = 15 * time.Second

type metricsSample struct {
	nodeID string
	value  *DeviceMetrics
}

// 只缓存展示指标，不缓存设备登记、在线状态或任何授权结果。
// 采样结果发布后不可变；每次返回深拷贝，避免调用方影响其他请求。
type metricsCache struct {
	mu          sync.Mutex
	lastAttempt time.Time
	completedAt time.Time
	running     bool
	samples     map[string]metricsSample
}

func cloneMetrics(value *DeviceMetrics) *DeviceMetrics {
	if value == nil {
		return &DeviceMetrics{GPUStatus: "unavailable"}
	}
	result := *value
	copyFloat := func(p *float64) *float64 {
		if p == nil {
			return nil
		}
		v := *p
		return &v
	}
	copyUint := func(p *uint64) *uint64 {
		if p == nil {
			return nil
		}
		v := *p
		return &v
	}
	result.CPUPercent = copyFloat(value.CPUPercent)
	result.MemoryUsedBytes = copyUint(value.MemoryUsedBytes)
	result.MemoryTotalBytes = copyUint(value.MemoryTotalBytes)
	result.GPUs = append([]GPUMetrics(nil), value.GPUs...)
	for i := range result.GPUs {
		gpu := &result.GPUs[i]
		gpu.Utilization = copyFloat(gpu.Utilization)
		gpu.MemoryUsedBytes = copyUint(gpu.MemoryUsedBytes)
		gpu.MemoryTotalBytes = copyUint(gpu.MemoryTotalBytes)
	}
	return &result
}

// Snapshot 先返回新鲜设备状态和已有指标，指标在独立的有界任务中刷新。
// 单个网页取消请求不会终止其他页面共享的采样；任务最多存活三秒。
func (c *meshClient) Snapshot(ctx context.Context) ([]Device, error) {
	devices, err := c.Devices(ctx)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	now := time.Now()
	c.metrics.mu.Lock()
	online := false
	for i := range devices {
		device := &devices[i]
		device.Metrics = &DeviceMetrics{GPUStatus: "unavailable"}
		if device.State != "online" {
			device.Metrics.GPUStatus = "offline"
			delete(c.metrics.samples, device.ID)
		} else if sample, ok := c.metrics.samples[device.ID]; ok && sample.nodeID == device.NodeID && now.Sub(c.metrics.completedAt) < metricsMaxAge {
			device.Metrics = cloneMetrics(sample.value)
		}
		online = online || device.State == "online"
	}
	refresh := online && !c.metrics.running && now.Sub(c.metrics.lastAttempt) >= metricsRefreshInterval
	if refresh {
		c.metrics.running = true
		c.metrics.lastAttempt = now
	}
	c.metrics.mu.Unlock()
	if refresh {
		// 后台采样独占自己的设备切片，绝不修改正在序列化的响应。
		go c.refreshMetrics(append([]Device(nil), devices...))
	}
	return devices, nil
}

func (c *meshClient) refreshMetrics(devices []Device) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	samples := make(map[string]metricsSample, len(devices))
	conn, err := c.dialControl(ctx, 2)
	if err == nil {
		// 正常关闭握手可能额外等待对端；只读采样结束后立即释放连接。
		defer conn.CloseNow()
		c.collectMetrics(ctx, conn, devices)
		for _, device := range devices {
			if device.State == "online" {
				samples[device.ID] = metricsSample{device.NodeID, device.Metrics}
			}
		}
	}
	c.metrics.mu.Lock()
	c.metrics.samples = samples
	c.metrics.completedAt = time.Now()
	c.metrics.running = false
	c.metrics.mu.Unlock()
}

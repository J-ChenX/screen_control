export type ClientDeviceId = Device["id"] | "xiaomi-15";

export type DeviceState = "online" | "connecting" | "offline" | "error";
export type ComponentState = "ready" | "degraded" | "unavailable" | "unknown";

export interface DeviceComponent {
  key: "host" | "desktop" | "files" | "clipboard";
  label: string;
  state: ComponentState;
  detail: string;
}

export interface Device {
  metrics?: {
    sampledAt?: string;
    cpuPercent: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    gpuStatus: "live" | "offline" | "unavailable" | "unsupported";
    gpus: { name: string; utilization: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; sampledAt: string }[] | null;
  };
  id: "echova" | "nix" | "jiang-chenx" | "lerrem";
  name: string;
  platform: "Ubuntu" | "Windows";
  role: string;
  state: DeviceState;
  observedAt: string;
  pathLabel: string;
	  nodeId?: string;
	  agentId?: number;
  components: DeviceComponent[];
}

export type DeviceFilter = "all" | "online" | "attention";

export type PortalRoute =
  | { page: "login" }
  | { page: "overview" }
  | { page: "security" }
  | { page: "desktop"; deviceId: Device["id"] }
  | { page: "files"; deviceId: Device["id"] };

export const registeredDevices: Device[] = [
  {
    id: "echova",
    name: "echova",
    platform: "Ubuntu",
    role: "常驻服务端",
    state: "offline",
    observedAt: "等待后端",
    pathLabel: "尚未取得权威路径",
    components: [
      { key: "host", label: "主机", state: "unknown", detail: "等待状态" },
      { key: "desktop", label: "桌面", state: "unknown", detail: "等待状态" },
      { key: "files", label: "文件", state: "unknown", detail: "等待状态" },
      { key: "clipboard", label: "剪贴板", state: "unavailable", detail: "策略禁用" },
    ],
  },
  {
    id: "nix",
    name: "nix",
    platform: "Ubuntu",
    role: "开发机",
    state: "offline",
    observedAt: "等待后端",
    pathLabel: "尚未取得权威路径",
    components: [
      { key: "host", label: "主机", state: "unknown", detail: "等待状态" },
      { key: "desktop", label: "桌面", state: "unknown", detail: "等待状态" },
      { key: "files", label: "文件", state: "unknown", detail: "等待状态" },
      { key: "clipboard", label: "剪贴板", state: "unavailable", detail: "策略禁用" },
    ],
  },
  {
    id: "jiang-chenx",
    name: "jiang-chenx",
    platform: "Windows",
    role: "个人电脑",
    state: "offline",
    observedAt: "等待后端",
    pathLabel: "尚未取得权威路径",
    components: [
      { key: "host", label: "主机", state: "unknown", detail: "等待状态" },
      { key: "desktop", label: "桌面", state: "unknown", detail: "等待状态" },
      { key: "files", label: "文件", state: "unknown", detail: "等待状态" },
      { key: "clipboard", label: "剪贴板", state: "unavailable", detail: "策略禁用" },
    ],
  },
  {
    id: "lerrem",
    name: "lerrem",
    platform: "Ubuntu",
    role: "开发机",
    state: "offline",
    observedAt: "等待后端",
    pathLabel: "尚未取得权威路径",
    components: [
      { key: "host", label: "主机", state: "unknown", detail: "等待状态" },
      { key: "desktop", label: "桌面", state: "unknown", detail: "等待状态" },
      { key: "files", label: "文件", state: "unknown", detail: "等待状态" },
      { key: "clipboard", label: "剪贴板", state: "unavailable", detail: "策略禁用" },
    ],
  },
];

const deviceIds = new Set<Device["id"]>(registeredDevices.map((device) => device.id));

export function isRegisteredDeviceId(value: unknown): value is Device["id"] {
  return typeof value === "string" && deviceIds.has(value as Device["id"]);
}

export function hydrateLiveDevice(device: Omit<Device, "components">): Device {
  const online = device.state === "online";
  return {
    ...device,
    components: [
      { key: "host", label: "主机", state: online ? "ready" : "unavailable", detail: online ? "在线" : "离线" },
      { key: "desktop", label: "桌面", state: online ? "ready" : "unavailable", detail: online ? "可连接" : "不可连接" },
      { key: "files", label: "文件", state: online ? "ready" : "unavailable", detail: online ? "可连接" : "不可连接" },
      { key: "clipboard", label: "剪贴板", state: online ? "ready" : "unavailable", detail: online ? "独立同步" : "设备离线" },
    ],
  };
}

export function parsePortalRoute(pathname: string): PortalRoute {
  if (pathname === "/login") return { page: "login" };
  if (pathname === "/settings/security") return { page: "security" };

  const match = pathname.match(/^\/devices\/([^/]+)\/(desktop|files)(?:\/.*)?$/);
  if (match) {
    const [, rawDeviceId, page] = match;
    if (deviceIds.has(rawDeviceId as Device["id"])) {
      return { page: page as "desktop" | "files", deviceId: rawDeviceId as Device["id"] };
    }
  }

  return { page: "overview" };
}

export function summarizeDevices(devices: Device[]) {
  return {
    total: devices.length,
    online: devices.filter((device) => device.state === "online").length,
    attention: devices.filter((device) => device.state !== "online").length,
  };
}

export function filterDevices(devices: Device[], filter: DeviceFilter) {
  if (filter === "all") return devices;
  return devices.filter((device) => filter === "online" ? device.state === "online" : device.state !== "online");
}

export const stateLabels: Record<DeviceState | ComponentState, string> = {
  online: "在线",
  connecting: "连接中",
  offline: "离线",
  error: "异常",
  ready: "正常",
  degraded: "需注意",
  unavailable: "不可用",
  unknown: "未知",
};

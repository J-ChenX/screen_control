import type { ClientDeviceId, Device } from "../app/model";

interface Envelope<T> {
  apiVersion: "v1";
  requestId: string;
  data?: T;
  error?: { code: string; message: string };
}

export interface ControlSnapshot {
  mode: "g0-live";
  generatedAt: string;
  devices: Array<Omit<Device, "components"> & { nodeId: string; agentId?: number }>;
}

export interface DeviceIdentity {
  deviceId: ClientDeviceId;
  accessMode?: "tailscale" | "gateway";
}

export interface DesktopSession {
  desktopSessionId: string;
  nodeId: string;
  tunnelId: string;
  relayPath: string;
  state: "connecting";
}

export interface FileSession {
  fileSessionId: string;
  nodeId: string;
  tunnelId: string;
  relayPath: string;
  state: "connecting";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  });
  if (response.status === 401) {
    window.location.assign("/auth/login");
    throw new Error("登录已过期，请重新登录");
  }
  if (!response.headers.get("Content-Type")?.includes("application/json")) throw new Error("入口未返回有效响应，请检查网络或代理后重试");
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || !payload.data) {
    throw new Error(payload.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return payload.data;
}

export async function getControlSnapshot(signal?: AbortSignal): Promise<ControlSnapshot> {
  return request<ControlSnapshot>("/api/v1/control/snapshot", { signal });
}

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  return request<DeviceIdentity>("/api/v1/identity/device");
}

export async function createDesktopSession(targetDeviceId: Device["id"]): Promise<DesktopSession> {
  return request<DesktopSession>("/api/v1/desktops", {
    method: "POST",
    body: JSON.stringify({ targetDeviceId }),
  });
}

export async function lockExitDesktopSession(sessionId: string): Promise<void> {
  await request(`/api/v1/desktops/${encodeURIComponent(sessionId)}/lock-exit`, { method: "POST", body: "{}" });
}

export async function endDesktopSession(sessionId: string): Promise<void> {
  await request(`/api/v1/desktops/${encodeURIComponent(sessionId)}/end`, { method: "POST", body: "{}" });
}

export async function createFileSession(targetDeviceId: Device["id"]): Promise<FileSession> {
  return request<FileSession>("/api/v1/files/sessions", {
    method: "POST",
    body: JSON.stringify({ targetDeviceId }),
  });
}

export async function endFileSession(sessionId: string): Promise<void> {
  await request(`/api/v1/files/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST", body: "{}" });
}

export interface FolderFavorites { paths: string[] }
export type FavoriteChange = { action: "add" | "remove" | "move"; path: string; before?: string } | { action: "import"; paths: string[]; importId: string };
export function getFolderFavorites(deviceId: string, signal?: AbortSignal) {
  return request<FolderFavorites>(`/api/v1/files/favorites/${encodeURIComponent(deviceId)}`, { signal });
}
export function changeFolderFavorites(deviceId: string, change: FavoriteChange) {
  return request<FolderFavorites>(`/api/v1/files/favorites/${encodeURIComponent(deviceId)}`, { method: "POST", body: JSON.stringify(change) });
}

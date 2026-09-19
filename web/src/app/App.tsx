import { Dropdown } from "../components/Dropdown";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { startVisiblePolling } from "../network/visiblePolling";
import { getControlSnapshot, getDeviceIdentity } from "../api/client";
import { MeshDesktop } from "../features/desktop/MeshDesktop";
import { MeshFiles, type FilePaneSelection, type MeshFilesHandle } from "../features/files/MeshFiles";
import {
  filterDevices,
  hydrateLiveDevice,
  parsePortalRoute,
  registeredDevices,
  stateLabels,
  summarizeDevices,
  type ClientDeviceId,
  type ComponentState,
  type Device,
  type DeviceState,
  type DeviceFilter,
} from "./model";

type IconName =
  | "activity"
  | "arrow"
  | "chevron"
  | "desktop"
  | "device"
  | "file"
  | "home"
  | "lock"
  | "route"
  | "server"
  | "settings"
  | "shield";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></>,
  device: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 17h6"/></>,
  desktop: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
  file: <path d="M4 4h6l2 3h8v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.09A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1.03-1.56V3h4v.09A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1.03H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  route: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h4a4 4 0 0 1 4 4v6M8 18h4a4 4 0 0 0 4-4v-4"/></>,
  activity: <path d="M3 12h4l2-7 4 14 2-7h6"/>,
  arrow: <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Modal({ title, description, children, onClose, actionLabel, onAction, actionDisabled = false, tone = "default" }: {
  title: string;
  description: string;
  children?: ReactNode;
  onClose: () => void;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
  tone?: "default" | "danger";
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-description">
        <button className="modal-close" onClick={onClose} aria-label="关闭对话框" autoFocus>×</button>
        <span className={`modal-icon ${tone}`}><Icon name={tone === "danger" ? "activity" : "shield"} size={22} /></span>
        <h2 id="modal-title">{title}</h2>
        <p id="modal-description">{description}</p>
        {children}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className={tone === "danger" ? "danger-button" : "primary-button"} onClick={onAction} disabled={actionDisabled}>{actionLabel}</button>
        </div>
      </section>
    </div>
  );
}

function Feedback({ title, children, tone = "info" }: { title: string; children: ReactNode; tone?: "info" | "warning" | "success" }) {
  return <div className={`feedback feedback-${tone}`} role="status"><Icon name={tone === "success" ? "shield" : "activity"} size={18} /><div><strong>{title}</strong><span>{children}</span></div></div>;
}

function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const navigate = (path: string) => {
    const destination = new URL(path, window.location.origin);
    window.history.pushState({}, "", `${destination.pathname}${destination.search}${destination.hash}`);
    setPathname(destination.pathname);
    if (destination.hash) {
      window.requestAnimationFrame(() => document.querySelector(destination.hash)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("/");
  };

  return { pathname, navigate, goBack };
}

function StatusPill({ state, detail }: { state: DeviceState | ComponentState; detail?: string }) {
  return <span className={`status-pill status-${state}`}><span className="status-dot" />{detail ?? stateLabels[state]}</span>;
}

function DeviceDropdown({ label, value, devices, disabledDeviceId, localDeviceId, locked, onChange }: {
  label: string;
  value: Device["id"];
  devices: Device[];
  disabledDeviceId: Device["id"];
  localDeviceId: ClientDeviceId;
  locked: boolean;
  onChange: (value: Device["id"]) => void;
}) {
  const current = devices.find((item) => item.id === value)!;
  const copy = (item: Device) => <><span className={`device-choice-dot status-${item.state}`} /><span className="device-choice-copy"><strong>{item.name}{item.id === localDeviceId ? "（本机）" : ""}</strong><small>{item.platform} · {item.role}</small></span></>;
  return <div className="device-dropdown">
    <Dropdown className="device-picker" label={label} value={value} disabled={locked} onChange={onChange} options={devices.map(item => ({ value: item.id, disabled: item.id === disabledDeviceId, label: <>{copy(item)}<span className="device-choice-state">{item.id === disabledDeviceId ? "已在另一侧" : stateLabels[item.state]}</span></> }))}>{copy(current)}</Dropdown>
  </div>;
}

function Sidebar({ active, navigate, deviceCount }: { active: "overview" | "security"; navigate: (path: string) => void; deviceCount: number }) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate("/")} aria-label="返回设备总览">
        <img className="brand-mark" src="/logo.svg" width="35" height="35" alt="" />
        <span className="brand-copy"><strong>Screen Control</strong><small>PRIVATE PORTAL</small></span>
      </button>
      <nav className="main-nav" aria-label="主要导航">
        <p className="nav-label">工作区</p>
        <button className={active === "overview" ? "active" : ""} onClick={() => navigate("/")}>
          <Icon name="home" /><span>设备总览</span><span className="nav-count">{deviceCount}</span>
        </button>
        <p className="nav-label nav-label-spaced">账户</p>
        <button className={active === "security" ? "active" : ""} onClick={() => navigate("/settings/security")}>
          <Icon name="settings" /><span>安全设置</span>
        </button>
      </nav>
      <div className="sidebar-bottom">
        <div className="gateway-card">
          <span className="gateway-icon"><Icon name="server" size={18} /></span>
          <div><strong>Portal gateway</strong><small><span className="live-dot" />G0 实机桥接</small></div>
        </div>
        <div className="profile">
          <span className="avatar">E</span>
          <div><strong>私人工作区</strong><small>仅限登记设备</small></div>
          <Icon name="chevron" size={16} />
        </div>
      </div>
    </aside>
  );
}

function Topbar({ title, navigate, backendState, devices, localDeviceId, showLogout = false }: {
  title: string;
  showLogout?: boolean;
  navigate: (path: string) => void;
  backendState: "loading" | "live" | "error";
  devices: Device[];
  localDeviceId: ClientDeviceId | null;
}) {
  const localDevice = devices.find((device) => device.id === localDeviceId);
  return (
    <header className="topbar">
      <div><span className="topbar-context">控制中心</span><span className="topbar-separator">/</span><strong>{title}</strong></div>
      <div className="topbar-actions">
        {showLogout && <form action="/auth/logout" method="post"><button className="file-logout-button" type="submit">退出登录</button></form>}
        <div className="local-device-picker" aria-label="自动识别的当前设备">
          <span>当前设备</span>
          <strong>{localDevice?.name ?? localDeviceId ?? "识别中"}</strong>
        </div>
        <span className={`preview-badge backend-${backendState}`}><span />{backendState === "live" ? "服务已连接" : backendState === "error" ? "服务不可用" : "连接中"}</span>
        <button className="icon-button" aria-label="打开安全设置" title="安全设置" onClick={() => navigate("/settings/security")}><Icon name="shield" size={19} /></button>
      </div>
    </header>
  );
}

function UsageBar({ value, label }: { value: number | null | undefined; label: string }) {
  return value != null ? <progress className={`usage-bar ${value >= 85 ? "usage-high" : ""}`} max={100} value={value} aria-label={label} /> : <span className="usage-bar usage-unknown" />;
}

function DeviceMetrics({ device, fresh }: { device: Device; fresh: boolean }) {
  const metrics = device.metrics;
  const available = fresh && device.state === "online";
  const recent = (sample?: string) => available && Boolean(sample) && Date.now() - Date.parse(sample!) < 15000;
  const cpu = recent(metrics?.sampledAt) ? metrics?.cpuPercent : null;
  const total = recent(metrics?.sampledAt) ? metrics?.memoryTotalBytes : null;
  const used = recent(metrics?.sampledAt) ? metrics?.memoryUsedBytes : null;
  const percent = total && used != null ? used / total * 100 : null;
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const missing = device.state !== "online" ? "设备离线" : !fresh ? "数据已过期" : "暂不可用";
  const gpus = available ? metrics?.gpus ?? [] : [];
  return <div className="device-live-metrics" aria-label={`${device.name} 实时状态`}>
    <div className="usage-cell"><div className="usage-heading"><span>CPU 使用率</span><strong>{cpu != null ? `${cpu.toFixed(1)}%` : missing}</strong></div><UsageBar value={cpu} label="CPU 使用率" /><small>{cpu != null ? "整体处理器负载" : "等待有效采样"}</small></div>
    <div className="usage-cell"><div className="usage-heading"><span>内存使用</span><strong>{percent != null ? `${percent.toFixed(1)}%` : missing}</strong></div><UsageBar value={percent} label="内存使用率" /><small>{total && used != null ? `${gib(used)} / ${gib(total)} GiB` : "等待有效采样"}</small></div>
    <div className="usage-cell gpu-usage">
      {gpus.length ? gpus.map((gpu) => { const live = recent(gpu.sampledAt); return <div className="gpu-sample" key={gpu.name}><div className="usage-heading"><span>GPU 使用率 / 显存</span><strong>{live && gpu.utilization != null ? `${gpu.utilization.toFixed(1)}%` : missing}</strong></div><UsageBar value={live ? gpu.utilization : null} label={`${gpu.name} 使用率`} /><small title={gpu.name}>{gpu.name} · {live && gpu.memoryUsedBytes != null && gpu.memoryTotalBytes != null ? `显存 ${gib(gpu.memoryUsedBytes)} / ${gib(gpu.memoryTotalBytes)} GiB` : "显存暂不可用"}</small></div>; }) : <><div className="usage-heading"><span>GPU 使用率 / 显存</span><strong>{available && metrics?.gpuStatus === "unsupported" ? "暂不支持采集" : missing}</strong></div><UsageBar value={null} label="GPU 使用率" /><small>无实时数据</small></>}
    </div>
  </div>;
}

function DeviceCard({ device, navigate, isLocal, identityReady, metricsFresh }: { device: Device; navigate: (path: string) => void; isLocal: boolean; identityReady: boolean; metricsFresh: boolean }) {
  const blocked = !identityReady || isLocal;
  return (
    <article className={`device-row${isLocal ? " device-row-local" : ""}`} id={`device-${device.id}`} aria-label={device.name}>
      <div className="device-identity">
        <span className={`device-icon device-${device.state}`}><Icon name={device.platform === "Windows" ? "desktop" : "device"} size={22} /></span>
        <div><h2>{device.name}{isLocal && <span className="local-device-label">本机</span>}</h2><p>{device.platform} · {device.role}</p></div>
      </div>
      <div className="device-availability"><StatusPill state={device.state} /><small>{device.observedAt}</small></div>
      <div className="device-capabilities">
        {device.components.filter((component) => component.key !== "host").map((component) => (
          <div key={component.key}><span>{component.label}</span><strong><i className={`mini-dot status-${component.state}`} />{component.detail}</strong></div>
        ))}
      </div>
      {!isLocal && <div className="device-actions">
        <button className="primary-button" onClick={() => navigate(`/devices/${device.id}/desktop`)} disabled={blocked} title={isLocal ? "不能控制当前设备" : "打开远程桌面"}><Icon name="desktop" size={16} />打开桌面</button>
        <button className="secondary-button" onClick={() => navigate(`/devices/${device.id}/files`)} disabled={!identityReady} title="管理文件"><Icon name="file" size={16} />文件</button>
      </div>}
      <DeviceMetrics device={device} fresh={metricsFresh} />
    </article>
  );
}

function Overview({ navigate, devices, localDeviceId, backendState, backendError }: { navigate: (path: string) => void; devices: Device[]; localDeviceId: ClientDeviceId | null; backendState: "loading" | "live" | "error"; backendError: string | null }) {
  const summary = useMemo(() => summarizeDevices(devices), [devices]);
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [query, setQuery] = useState("");
  const [, tick] = useState(0);
  useEffect(() => startVisiblePolling(async () => { tick((value) => value + 1); }, 1000), []);
  const visibleDevices = filterDevices(devices, filter).filter((device) => `${device.name} ${device.platform} ${device.role}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="overview-workspace">
      <section className="workspace-heading">
        <div><span className="eyebrow">WORKSPACE / DEVICES</span><h1>设备工作台</h1><p>查看设备状态，连接桌面或管理文件。</p></div>
        <span className={`sync-indicator backend-${backendState}`}><span className="status-dot" />{backendState === "live" ? "状态已同步 · 前台每 5 秒刷新" : backendState === "error" ? "状态同步中断" : "正在同步设备状态"}</span>
      </section>
      {backendState === "error" && <div className="notice notice-error" role="status"><Icon name="activity" size={19} /><div><strong>无法获取最新状态</strong><span>{backendError} · 以下可能为上次同步结果，正在自动重试。</span></div></div>}
      <section className="fleet-summary" aria-label="设备摘要">
        <div><span className="summary-symbol"><Icon name="device" /></span><strong>{summary.total}</strong><span>登记设备</span></div>
        <div><span className="summary-symbol green"><Icon name="activity" /></span><strong>{backendState === "live" ? summary.online : "—"}</strong><span>当前在线</span></div>
        <div><span className="summary-symbol amber"><Icon name="shield" /></span><strong>{backendState === "live" ? summary.attention : "—"}</strong><span>需要注意</span></div>
      </section>
      <section className="device-directory" aria-label="已登记设备">
        <div className="directory-toolbar">
          <div className="filter-group" aria-label="筛选设备">
            <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部设备 <span>{summary.total}</span></button>
            <button aria-pressed={filter === "online"} onClick={() => setFilter("online")}>在线 <span>{summary.online}</span></button>
            <button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>需注意 <span>{summary.attention}</span></button>
          </div>
          <label className="device-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设备、系统或用途" aria-label="搜索设备" /></label>
        </div>
        <div className="directory-columns" aria-hidden="true"><span>设备 / 系统</span><span>连接状态</span><span>可用能力</span><span>快捷操作</span></div>
        <div className="device-list">
          {visibleDevices.map((device) => <DeviceCard device={device} navigate={navigate} isLocal={device.id === localDeviceId} identityReady={Boolean(localDeviceId)} metricsFresh={backendState === "live"} key={device.id} />)}
          {visibleDevices.length === 0 && <div className="directory-empty" role="status"><Icon name="device" size={28} /><h2>没有符合条件的设备</h2><p>尝试其他关键词，或查看全部登记设备。</p><button className="secondary-button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button></div>}
        </div>
        <div className="directory-footer"><span aria-live="polite">显示 {visibleDevices.length} / {summary.total} 台设备</span><span>本机支持文件管理</span></div>
      </section>
      <div className="workspace-note"><Icon name="shield" size={16} /><span>仅限已登记设备访问</span><span className="note-divider">·</span><span>桌面、文件与剪贴板状态独立显示</span><button onClick={() => navigate("/settings/security")}>安全设置 <Icon name="chevron" size={14} /></button></div>
    </div>
  );
}

function Breadcrumb({ device, label, currentPath, navigate, goBack }: { device?: Device; label: string; currentPath: string; navigate: (path: string) => void; goBack: () => void }) {
  return <nav className="breadcrumb" aria-label="页面位置"><button className="back-button" onClick={goBack}><Icon name="arrow" size={16} />返回</button><span className="breadcrumb-divider" /><button onClick={() => navigate("/")}>设备总览</button><Icon name="chevron" size={14} />{device && <><button onClick={() => navigate(`/#device-${device.id}`)}>{device.name}</button><Icon name="chevron" size={14} /></>}<button className="breadcrumb-current" aria-current="page" onClick={() => navigate(currentPath)}>{label}</button></nav>;
}

function DesktopView({ device, devices, localDeviceId, goBack, blocked, navigate }: { device: Device; devices: Device[]; localDeviceId: ClientDeviceId; goBack: () => void; blocked: boolean; navigate: (path: string) => void }) {
  const [filesOpen, setFilesOpen] = useState(false);
  const desktop = device.components.find((component) => component.key === "desktop")!;
  const workspaceRef = useRef<HTMLElement>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    const update = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await workspaceRef.current?.requestFullscreen();
  };

  return (
    <section className="desktop-workspace" ref={workspaceRef}>
      <header className="desktop-commandbar">
        <button className="desktop-back" onClick={goBack}><Icon name="arrow" size={18} />返回</button>
        <div><strong>{device.name}</strong><span>{device.platform} · 主屏控制</span><StatusPill state={desktop.state} detail={desktop.detail} /></div>
        <div className="desktop-session-slot" ref={setToolbarTarget} />
        <button className="desktop-file-transfer" onClick={() => setFilesOpen(true)} aria-haspopup="dialog"><Icon name="file" size={16} />文件传输</button>
        <button onClick={() => void toggleFullscreen()}>{isFullscreen ? "退出全屏" : "进入全屏"}</button>
      </header>
      <div className="desktop-stage">{blocked ? <div className="self-target-blocked"><Icon name="shield" size={30} /><h2>不能控制当前设备</h2><p>你正在使用 {device.name}，为避免输入回环，已禁止对本机创建控屏会话。</p><button onClick={goBack}>返回设备总览</button></div> : <MeshDesktop key={device.id} device={device} toolbarTarget={toolbarTarget} inputSuspended={filesOpen} />}</div>
      {filesOpen && <DesktopFilesDialog device={device} devices={devices} localDeviceId={localDeviceId} onClose={() => setFilesOpen(false)} navigate={navigate} />}
    </section>
  );
}

function DesktopFilesDialog({ device, devices, localDeviceId, onClose, navigate }: { device: Device; devices: Device[]; localDeviceId: ClientDeviceId; onClose: () => void; navigate: (path: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog className="desktop-files-dialog" ref={dialogRef} aria-labelledby="desktop-files-title" onCancel={onClose}>
    <header><div><h2 id="desktop-files-title">文件传输 · {device.name}</h2><p>Ctrl/⌘ 多选 · Shift 连选；关闭弹窗会中断传输。</p></div><button autoFocus onClick={onClose} aria-label="关闭文件传输">关闭</button></header>
    <LiveFilesView device={device} devices={devices} localDeviceId={localDeviceId} navigate={path => { onClose(); navigate(path); }} goBack={onClose} embedded />
  </dialog>;
}

function LiveFilesView({ device, devices, localDeviceId, navigate, goBack, embedded = false }: { embedded?: boolean; device: Device; devices: Device[]; localDeviceId: ClientDeviceId; navigate: (path: string) => void; goBack: () => void }) {
  const fileDevices = devices;
  const initialDevice = fileDevices.find((item) => item.id === device.id) ?? fileDevices.find((item) => item.state === "online") ?? fileDevices[0];
  const firstTarget = fileDevices.find((item) => item.id !== initialDevice.id && item.id === localDeviceId) ?? fileDevices.find((item) => item.id !== initialDevice.id && item.state === "online") ?? fileDevices.find((item) => item.id !== initialDevice.id)!;
  const [leftDeviceId, setLeftDeviceId] = useState<Device["id"]>(initialDevice.id);
  const [rightDeviceId, setRightDeviceId] = useState<Device["id"]>(firstTarget.id);
  const [leftSelection, setLeftSelection] = useState<FilePaneSelection[]>([]);
  const [rightSelection, setRightSelection] = useState<FilePaneSelection[]>([]);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);
  const leftRef = useRef<MeshFilesHandle>(null);
  const rightRef = useRef<MeshFilesHandle>(null);
  const leftDevice = devices.find((item) => item.id === leftDeviceId) ?? device;
  const rightDevice = devices.find((item) => item.id === rightDeviceId) ?? firstTarget;

  const chooseLeft = (nextId: Device["id"]) => {
    setLeftDeviceId(nextId);
    if (nextId === rightDeviceId) setRightDeviceId(fileDevices.find((item) => item.id !== nextId)?.id ?? rightDeviceId);
    setTransferMessage(null);
  };

  const chooseRight = (nextId: Device["id"]) => {
    setRightDeviceId(nextId);
    if (nextId === leftDeviceId) setLeftDeviceId(fileDevices.find((item) => item.id !== nextId)?.id ?? leftDeviceId);
    setTransferMessage(null);
  };

  const transfer = async (direction: "left-to-right" | "right-to-left") => {
    const source = direction === "left-to-right" ? leftRef.current : rightRef.current;
    const target = direction === "left-to-right" ? rightRef.current : leftRef.current;
    const sourceDevice = direction === "left-to-right" ? leftDevice : rightDevice;
    const targetDevice = direction === "left-to-right" ? rightDevice : leftDevice;
    setTransferring(true);
    setTransferMessage(`正在从 ${sourceDevice.name} 读取文件…`);
    try {
      if (!source || !target) throw new Error("文件窗口尚未准备完成");
      const count = await source.transferSelected(target, (done, total, name) => setTransferMessage(`已完成 ${done}/${total} 个项目，正在传输 ${name} → ${targetDevice.name}`));
      setTransferMessage(`已将 ${count} 个项目复制到 ${targetDevice.name}`);
    } catch (caught) {
      setTransferMessage(caught instanceof Error ? caught.message : "设备间传输失败");
    } finally {
      setTransferring(false);
    }
  };

  return (
    <section className="detail-page file-workspace-page">
      {!embedded && <><Breadcrumb device={device.id === localDeviceId ? undefined : device} label="设备间文件管理" currentPath={`/devices/${initialDevice.id}/files`} navigate={navigate} goBack={goBack} />
      <div className="file-workspace-heading">
        <div><span className="eyebrow">TWO-DEVICE FILE WORKSPACE</span><h1>设备间文件管理</h1><p>同时打开两台设备，直接比较目录并将选中的多个项目发送到另一端当前目录，也可选择本机接收。</p></div>
        <span className="secure-label"><Icon name="shield" size={17} />端到端通过 G0 中继</span>
      </div>
      </>}
      <div className="device-pair-bar panel">
        <DeviceDropdown label="设备 A" value={leftDeviceId} devices={fileDevices} disabledDeviceId={rightDeviceId} localDeviceId={localDeviceId} locked={transferring} onChange={chooseLeft} />
        <div className="pair-transfer-actions" aria-label="设备间传输">
          <span className="pair-transfer-label">跨设备传输</span>
          <button onClick={() => void transfer("left-to-right")} disabled={!leftSelection.length || transferring || rightDevice.state !== "online"}>发送到 {rightDevice.name}{leftSelection.length ? `（${leftSelection.length}）` : ""} →</button>
          <button onClick={() => void transfer("right-to-left")} disabled={!rightSelection.length || transferring || leftDevice.state !== "online"}>← 发送到 {leftDevice.name}{rightSelection.length ? `（${rightSelection.length}）` : ""}</button>
        </div>
        <DeviceDropdown label="设备 B" value={rightDeviceId} devices={fileDevices} disabledDeviceId={leftDeviceId} localDeviceId={localDeviceId} locked={transferring} onChange={chooseRight} />
      </div>
      {transferMessage && <div className="pair-transfer-message" role="status">{transferMessage}</div>}
      <div className="file-pair-layout">
        <div className="file-browser panel"><MeshFiles key={leftDevice.id} ref={leftRef} device={leftDevice} paneLabel="设备 A" locked={transferring} onSelectionChange={setLeftSelection} onOpenDesktop={leftDevice.id === localDeviceId ? undefined : () => navigate(`/devices/${leftDevice.id}/desktop?directoryOpen=requested`)} /></div>
        <div className="file-browser panel"><MeshFiles key={rightDevice.id} ref={rightRef} device={rightDevice} paneLabel="设备 B" locked={transferring} onSelectionChange={setRightSelection} onOpenDesktop={rightDevice.id === localDeviceId ? undefined : () => navigate(`/devices/${rightDevice.id}/desktop?directoryOpen=requested`)} /></div>
      </div>
    </section>
  );
}

function SecurityView({ navigate, goBack, accessMode }: { navigate: (path: string) => void; goBack: () => void; accessMode: "tailscale" | "gateway" }) {
  const [preview, setPreview] = useState<"password" | "logout" | null>(null);
  if (accessMode === "gateway") return (
    <section className="detail-page security-page">
      <Breadcrumb label="安全设置" currentPath="/settings/security" navigate={navigate} goBack={goBack} />
      <div className="detail-title"><div><h1>访问与登录</h1><p>当前通过 HTTPS 入口访问。</p></div></div>
      <div className="settings-grid">
        <article className="panel setting-card"><div><h2>设备访问密钥</h2><p>由管理员为此设备签发。请勿分享；需要更换或撤销时联系管理员。</p></div></article>
        <article className="panel setting-card"><div><h2>当前登录</h2><p>登录 8 小时后到期。退出会立即关闭此登录下的桌面和文件连接，正在进行的传输将中断。</p><form action="/auth/logout" method="post"><button type="submit">退出登录</button></form></div></article>
      </div>
    </section>
  );
  return (
    <section className="detail-page security-page">
      <Breadcrumb label="安全设置" currentPath="/settings/security" navigate={navigate} goBack={goBack} />
      <div className="detail-title"><div><span className="eyebrow">ACCOUNT SECURITY</span><h1>安全设置</h1><p>管理密码与当前 Portal 会话</p></div><span className="secure-label"><Icon name="shield" size={17} />仅限登记设备</span></div>
      <div className="settings-grid">
        <article className="panel setting-card"><span className="setting-icon"><Icon name="lock" /></span><div><h2>登录密码</h2><p>密码变更将撤销相关会话与活动通道。</p><button onClick={() => setPreview("password")}>查看改密流程</button><small>等待 identity 模块接入</small></div></article>
        <article className="panel setting-card"><span className="setting-icon"><Icon name="device" /></span><div><h2>当前会话</h2><p>绝对有效期最长 7 天，主动退出立即撤销。</p><button onClick={() => setPreview("logout")}>查看退出流程</button><small>开发预览未创建会话</small></div></article>
      </div>
      <article className="panel principles"><h2>Portal 安全原则</h2><div className="principle-grid"><div><strong>无持久凭据</strong><p>Cookie、能力和启动值不会镜像到 Web Storage。</p></div><div><strong>服务端复核</strong><p>隐藏按钮不是授权，所有领域请求都要重新校验。</p></div><div><strong>结果不猜测</strong><p>失败、部分成功和未知结果分别呈现。</p></div></div></article>
      {preview === "password" && <Modal title="更改登录密码" description="正式改密需要验证当前密码，并撤销所有相关会话、能力和活动通道。" actionLabel="关闭流程预览" onClose={() => setPreview(null)} onAction={() => setPreview(null)}><Feedback title="尚未执行" tone="warning">Identity 服务未连接，界面不会收集或保存密码。</Feedback></Modal>}
      {preview === "logout" && <Modal title="退出当前会话？" description="正式退出会立即撤销当前 Portal 会话，并终止由它派生的控制与文件通道。" actionLabel="关闭流程预览" tone="danger" onClose={() => setPreview(null)} onAction={() => setPreview(null)}><Feedback title="尚未执行" tone="warning">开发预览没有创建会话，因此不会发送退出请求。</Feedback></Modal>}
    </section>
  );
}

function LoginView({ navigate }: { navigate: (path: string) => void }) {
  const [password, setPassword] = useState("");
  const [attempted, setAttempted] = useState(false);

  const submitPreview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password) return;
    setPassword("");
    setAttempted(true);
  };

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand"><img className="brand-mark" src="/logo.svg" width="35" height="35" alt="" /><div><strong>Screen Control</strong><small>PRIVATE PORTAL</small></div></div>
        <div className="login-message"><span className="eyebrow">ONE PRIVATE ENTRY</span><h1>你的三台电脑，<br />一个安全入口。</h1><p>查看状态、打开远程桌面，并在普通用户权限内管理文件。</p></div>
        <div className="login-guardrails"><span><Icon name="shield" size={17} />仅限已登记的 Tailscale 电脑与手机</span><span><Icon name="lock" size={17} />会话绝对有效期最长 7 天</span></div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={submitPreview}>
          <span className="login-lock"><Icon name="lock" size={24} /></span>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>登录私人 Portal</h2>
          <p>使用部署时设置的强密码继续。</p>
          <label htmlFor="portal-password">访问密码</label>
          <input id="portal-password" type="password" autoComplete="current-password" placeholder="输入访问密码" value={password} onChange={(event) => { setPassword(event.target.value); setAttempted(false); }} aria-describedby="login-preview-note" />
          <button type="submit" disabled={!password}>验证登录交互</button>
          {attempted && <div className="login-error" role="alert"><strong>登录未执行</strong><span>Identity 服务尚未连接；输入已从页面内存清除，也没有创建会话。</span></div>}
          <small id="login-preview-note"><span />基础界面预览：密码不会离开此页面</small>
          <button type="button" className="login-secondary" onClick={() => navigate("/")}>进入设备界面预览</button>
        </form>
      </section>
    </main>
  );
}

function DeviceIdentityStatus({ state, error, onRetry }: { state: "loading" | "error"; error: string | null; onRetry: () => void }) {
  return (
    <div className="identity-backdrop" role="presentation">
      <section className="identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-title" aria-describedby="identity-description">
        <span className="modal-icon"><Icon name="device" size={22} /></span>
        <span className="eyebrow">TAILSCALE DEVICE IDENTITY</span>
        <h2 id="identity-title">{state === "loading" ? "正在识别当前设备" : "无法验证当前设备"}</h2>
        <p id="identity-description">{state === "loading" ? "正在通过受信的 Tailscale 连接核对设备登记，无需手动选择。" : error}</p>
        {state === "loading" ? <span className="identity-progress" aria-label="正在识别" /> : <button className="primary-button identity-retry" type="button" onClick={onRetry}>重新识别</button>}
        <small><Icon name="lock" size={14} />设备身份来自连接本身，不读取浏览器指纹，也不接受客户端自报。</small>
      </section>
    </div>
  );
}

export function App() {
  const { pathname, navigate, goBack } = usePathname();
  const route = parsePortalRoute(pathname);
  const [devices, setDevices] = useState<Device[]>(registeredDevices);
  const [backendState, setBackendState] = useState<"loading" | "live" | "error">("loading");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<ClientDeviceId | null>(null);
  const [identityState, setIdentityState] = useState<"loading" | "ready" | "error">("loading");
  const [accessMode, setAccessMode] = useState<"tailscale" | "gateway">("tailscale");
  const [identityError, setIdentityError] = useState<string | null>(null);
  const device = "deviceId" in route ? devices.find((item) => item.id === route.deviceId) ?? registeredDevices.find((item) => item.id === route.deviceId)! : undefined;
  const pageTitle = route.page === "login" ? "登录" : route.page === "overview" ? "设备总览" : route.page === "security" ? "安全设置" : route.page === "desktop" ? "远程桌面" : "文件";

  useEffect(() => {
    document.title = `Screen Control · ${pageTitle}`;
  }, [pageTitle]);

  useEffect(() => {
    const refresh = async (signal: AbortSignal) => {
      try {
        const snapshot = await getControlSnapshot(signal);
        if (signal.aborted) return;
        const order = new Map(registeredDevices.map((item, index) => [item.id, index]));
        const liveDevices = snapshot.devices.map((item) => hydrateLiveDevice(item)).sort((left, right) => (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99));
        setDevices(liveDevices);
        setBackendState("live");
        setBackendError(null);
      } catch (caught) {
        if (signal.aborted) return;
        setBackendState("error");
        setBackendError(caught instanceof Error ? caught.message : "无法连接远控服务");
      }
    };
    return startVisiblePolling(refresh);
  }, []);

  const identifyDevice = async () => {
    setIdentityState("loading");
    setIdentityError(null);
    try {
      const identity = await getDeviceIdentity();
      setLocalDeviceId(identity.deviceId);
      setAccessMode(identity.accessMode ?? "tailscale");
      setIdentityState("ready");
      if (route.page === "desktop" && route.deviceId === identity.deviceId) navigate("/");
    } catch (caught) {
      setLocalDeviceId(null);
      setIdentityState("error");
      setIdentityError(caught instanceof Error ? caught.message : "设备身份验证失败");
    }
  };

  useEffect(() => { void identifyDevice(); }, []);

  if (route.page === "login") return <LoginView navigate={navigate} />;

  const active = route.page === "security" ? "security" : "overview";

  return (
    <div className={`app-shell ${route.page === "desktop" ? "desktop-mode" : route.page === "files" ? "files-mode" : ""}`}>
      <Sidebar active={active} navigate={navigate} deviceCount={devices.length} />
      <div className="app-main">
        <Topbar showLogout={route.page === "files" && accessMode === "gateway"} title={pageTitle} navigate={navigate} backendState={backendState} devices={devices} localDeviceId={localDeviceId} />
        <main className="content">
          {route.page === "overview" && <Overview navigate={navigate} devices={devices} localDeviceId={localDeviceId} backendState={backendState} backendError={backendError} />}
          {route.page === "desktop" && device && localDeviceId && <DesktopView device={device} devices={devices} localDeviceId={localDeviceId} goBack={goBack} blocked={device.id === localDeviceId} navigate={navigate} />}
          {route.page === "files" && device && localDeviceId && <LiveFilesView key={`${device.id}-${localDeviceId}`} device={device} devices={devices} localDeviceId={localDeviceId} navigate={navigate} goBack={goBack} />}
          {route.page === "security" && <SecurityView navigate={navigate} goBack={goBack} accessMode={accessMode} />}
        </main>
        {route.page !== "files" && <footer><span>Screen Control</span>{accessMode === "gateway" && <form action="/auth/logout" method="post"><button type="submit">退出登录</button></form>}<span>G0 实机桥接 · 非生产服务</span></footer>}
      </div>
      {identityState !== "ready" && <DeviceIdentityStatus state={identityState} error={identityError} onRetry={() => void identifyDevice()} />}
    </div>
  );
}

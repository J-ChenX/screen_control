import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createFileSession, endFileSession } from "../../api/client";
import type { Device } from "../../app/model";
import type { AgentRedirect, MeshCentralModule } from "../meshcentral";

interface RemoteFileModule extends MeshCentralModule {
  protocol: 5;
}

interface RemoteEntry {
  name: string;
  type: number;
  size: number;
  modified?: number | string;
  driveType?: string;
}

interface UploadState {
  file: File;
  offset: number;
  requestId: number;
}

interface DownloadState {
  id: number;
  name: string;
  chunks: Uint8Array[];
  received: number;
  size: number;
  deliver?: {
    resolve: (file: File) => void;
    reject: (error: Error) => void;
  };
}

export interface FilePaneSelection {
  name: string;
  size: number;
}

export interface MeshFilesHandle {
  transferSelected: () => Promise<File>;
  receiveTransferred: (file: File) => void;
}

type ConnectionState = "idle" | "starting" | "connected" | "ended" | "error";
type FileActionDialog = { type: "rename" | "delete"; entry: RemoteEntry } | null;
type ContextMenuState = { x: number; y: number; entry: RemoteEntry } | null;

const decoder = new TextDecoder();

function joinPath(parent: string, name: string) {
  return parent ? `${parent.replace(/\/$/, "")}/${name}` : name;
}

export function defaultDirectoryForDevice(device: Pick<Device, "id" | "platform">) {
  return device.platform === "Ubuntu" ? `home/${device.id}` : "";
}

export function validName(name: string) {
  return name.length > 0 && name.length <= 128 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function formatSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatModified(value: number | string | undefined) {
  if (value == null) return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function parseEntries(directory: unknown): RemoteEntry[] {
  if (!directory || typeof directory !== "object") return [];
  return Object.entries(directory as Record<string, unknown>).map(([key, raw]) => {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      name: typeof value.n === "string" ? value.n : key,
      type: typeof value.t === "number" ? value.t : 3,
      size: typeof value.s === "number" ? value.s : 0,
      modified: typeof value.d === "number" || typeof value.d === "string" ? value.d : undefined,
      driveType: typeof value.dt === "string" ? value.dt : undefined,
    };
  }).sort((left, right) => {
    const leftDirectory = left.type < 3 ? 0 : 1;
    const rightDirectory = right.type < 3 ? 0 : 1;
    return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

interface MeshFilesProps {
  device: Device;
  paneLabel: string;
  onSelectionChange?: (selection: FilePaneSelection | null) => void;
}

export const MeshFiles = forwardRef<MeshFilesHandle, MeshFilesProps>(function MeshFiles({ device, paneLabel, onSelectionChange }, ref) {
  const redirectRef = useRef<AgentRedirect<RemoteFileModule> | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pathRef = useRef("");
  const mountedRef = useRef(true);
  const autoStartAttemptedRef = useRef(false);
  const uploadRef = useRef<UploadState | null>(null);
  const downloadRef = useRef<DownloadState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [path, setPath] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [actionDialog, setActionDialog] = useState<FileActionDialog>(null);
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [transferProgress, setTransferProgress] = useState<{ label: string; value: number } | null>(null);

  const generation = useRef(0);
  const connecting = useRef(false);
  const handshakeTimer = useRef<number | undefined>(undefined);

  const send = (command: Record<string, unknown>) => redirectRef.current?.sendText(command);

  const requestDirectory = (nextPath: string) => {
    const normalized = nextPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    pathRef.current = normalized;
    setPath(normalized);
    setAddress(normalized);
    setLoading(true);
    setSelected([]);
    send({ action: "ls", reqid: Date.now(), path: normalized });
  };

  const stop = async (next: ConnectionState = "ended") => {
    generation.current++;
    connecting.current = false;
    window.clearTimeout(handshakeTimer.current);
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    const redirect = redirectRef.current;
    redirectRef.current = null;
    if (redirect) redirect.Stop();
    const interrupted = uploadRef.current !== null || downloadRef.current !== null;
    uploadRef.current = null;
    if (mountedRef.current) {
      setTransferProgress(null);
      if (interrupted) setError("传输已中断，未自动重试。上传可能留下不完整文件，请重新连接后检查并重新传输。");
    }
    const activeDownload = downloadRef.current;
    downloadRef.current = null;
    activeDownload?.deliver?.reject(new Error("文件会话已结束"));
    if (mountedRef.current) setConnection(next);
    if (sessionId) {
      try { await endFileSession(sessionId); } catch { /* 关闭中继也会使会话失效。 */ }
    }
  };

  const finishDownload = () => {
    const active = downloadRef.current;
    if (!active) return;
    if (active.received !== active.size) {
      downloadRef.current = null;
      setTransferProgress(null);
      const failure = new Error("下载大小与预期不符，未保存不完整文件，请刷新目录后重试。");
      active.deliver?.reject(failure);
      setError(failure.message);
      return;
    }
    const blob = new Blob(active.chunks.map((chunk) => new Uint8Array(chunk).buffer as ArrayBuffer), { type: "application/octet-stream" });
    downloadRef.current = null;
    setTransferProgress(null);
    if (active.deliver) {
      active.deliver.resolve(new File([blob], active.name, { type: "application/octet-stream" }));
      setMessage(`${active.name} 已从本设备读取，正在发送到另一台设备`);
    } else {
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = active.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      setMessage(`${active.name} 已接收 ${formatSize(active.received)}`);
    }
  };

  const handleBinary = (data: Uint8Array) => {
    if (data.length > 0 && data[0] === 123) {
      handleCommand(decoder.decode(data));
      return;
    }
    const active = downloadRef.current;
    if (!active || data.length < 4) return;
    const payload = data.slice(4);
    if (payload.length > 0) {
      active.chunks.push(payload);
      active.received += payload.length;
      setTransferProgress({ label: `下载 ${active.name}`, value: active.size > 0 ? active.received / active.size : 0 });
    }
    if ((data[3] & 1) !== 0) {
      finishDownload();
    } else {
      send({ action: "download", sub: "ack", id: active.id });
    }
  };

  const sendUploadChunk = async () => {
    const active = uploadRef.current;
    const redirect = redirectRef.current;
    if (!active || !redirect) return;
    if (active.offset >= active.file.size) {
      redirect.sendText({ action: "uploaddone", reqid: active.requestId });
      return;
    }
    const end = Math.min(active.offset + 64 * 1024, active.file.size);
    let chunk = new Uint8Array(await active.file.slice(active.offset, end).arrayBuffer());
    if (uploadRef.current !== active || redirectRef.current !== redirect) return;
    if (chunk[0] === 0 || chunk[0] === 123) {
      const escaped = new Uint8Array(chunk.length + 1);
      escaped.set(chunk, 1);
      chunk = escaped;
    }
    active.offset = end;
    redirect.send(chunk);
    setTransferProgress({ label: `上传 ${active.file.name}`, value: active.offset / active.file.size });
    if (active.offset >= active.file.size) redirect.sendText({ action: "uploaddone", reqid: active.requestId });
  };

  const handleCommand = (raw: string) => {
    let command: Record<string, unknown>;
    try { command = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const action = typeof command.action === "string" ? command.action : "";
    if (action === "refresh") {
      requestDirectory(pathRef.current);
      return;
    }
    if (action === "download") {
      const active = downloadRef.current;
      if (active && command.id === active.id && command.sub === "start") send({ action: "download", sub: "startack", id: active.id });
      if (active && command.id === active.id && command.sub === "cancel") {
        downloadRef.current = null;
        active.deliver?.reject(new Error("目标设备取消了下载"));
        setTransferProgress(null);
        setError("目标设备取消了下载");
      }
      return;
    }
    if (action === "uploadstart" || action === "uploadack") {
      void sendUploadChunk();
      return;
    }
    if (action === "uploaddone") {
      const name = uploadRef.current?.file.name;
      uploadRef.current = null;
      setTransferProgress(null);
      setMessage(name ? `${name} 上传完成` : "上传完成");
      requestDirectory(pathRef.current);
      return;
    }
    if (action === "uploaderror") {
      uploadRef.current = null;
      setTransferProgress(null);
      setError("目标设备拒绝了上传");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(command, "path")) {
      const responsePath = typeof command.path === "string" ? command.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : pathRef.current;
      pathRef.current = responsePath;
      setPath(responsePath);
      setAddress(responsePath);
      setEntries(parseEntries(command.dir));
      setLoading(false);
      setError(command.dir == null ? "无法访问该目录" : null);
    }
  };

  const start = async () => {
    if (connecting.current || redirectRef.current) return;
    connecting.current = true;
    const attempt = ++generation.current;
    handshakeTimer.current = window.setTimeout(() => {
      if (attempt !== generation.current) return;
      void stop("error"); setError("文件通道连接超时，请重试。");
    }, 20_000);
    setConnection("starting");
    setError(null);
    setMessage(null);
    try {
      if (!window.CreateAgentRedirect) throw new Error("文件协议组件未加载，请刷新后重试");
      const session = await createFileSession(device.id);
      if (!mountedRef.current || attempt !== generation.current) { await endFileSession(session.fileSessionId); return; }
      sessionRef.current = session.fileSessionId;
      const module: RemoteFileModule = {
        protocol: 5,
        xxStateChange: () => undefined,
        ProcessData: (data) => {
          if (data.length > 0 && data.charCodeAt(0) !== 123) {
            handleBinary(Uint8Array.from(data, (character) => character.charCodeAt(0)));
          } else {
            handleCommand(data);
          }
        },
        ProcessBinaryData: handleBinary,
      };
      const redirect = window.CreateAgentRedirect(null, module, window.location.host, "", "", "/");
      redirect.tunnelid = session.tunnelId;
      redirect.urlname = `../../../${session.relayPath.replace(/^\//, "")}`;
      redirect.attemptWebRTC = false;
      redirect.onStateChanged = (_active, state) => {
        if (!mountedRef.current || attempt !== generation.current) return;
        if (state === 3) {
          window.clearTimeout(handshakeTimer.current);
          connecting.current = false;
          setConnection("connected");
          requestDirectory(defaultDirectoryForDevice(device));
        }
        if (state === 0 && sessionRef.current) {
          void stop("ended");
        }
      };
      redirect.onConsoleMessageChange = (_active, consoleMessage) => { if (consoleMessage && attempt === generation.current && mountedRef.current) setError(consoleMessage); };
      redirectRef.current = redirect;
      redirect.Start(session.nodeId);
    } catch (caught) {
      if (attempt !== generation.current) return;
      void stop("error");
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "无法连接文件通道");
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; void stop(); };
  }, []);

  useEffect(() => {
    if (device.state !== "online" || connection !== "idle" || autoStartAttemptedRef.current) return;
    const timer = window.setTimeout(() => {
      autoStartAttemptedRef.current = true;
      void start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [connection, device.state]);

  useEffect(() => {
    if (!contextMenu && !createOpen) return;
    const closeMenus = () => {
      setContextMenu(null);
      setCreateOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    window.addEventListener("click", closeMenus);
    window.addEventListener("blur", closeMenus);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenus);
      window.removeEventListener("blur", closeMenus);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu, createOpen]);

  useEffect(() => {
    if (!actionDialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionDialog(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [actionDialog]);

  const beginUpload = (file: File) => {
    setPendingUpload(null);
    setError(null);
    setMessage(null);
    const requestId = Date.now();
    uploadRef.current = { file, offset: 0, requestId };
    setTransferProgress({ label: `上传 ${file.name}`, value: 0 });
    send({ action: "upload", reqid: requestId, path: pathRef.current, name: file.name, size: file.size });
  };

  const chooseUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (entries.some((entry) => entry.name.toLocaleLowerCase() === file.name.toLocaleLowerCase())) setPendingUpload(file);
    else beginUpload(file);
  };

  const selectedEntries = entries.filter((entry) => selected.includes(entry.name));
  const selectedFile = selectedEntries.length === 1 && selectedEntries[0].type >= 3 ? selectedEntries[0] : null;

  useEffect(() => {
    onSelectionChange?.(selectedFile ? { name: selectedFile.name, size: selectedFile.size } : null);
  }, [onSelectionChange, selectedFile?.name, selectedFile?.size]);

  const beginDownloadEntry = (entry: RemoteEntry | null, deliver?: DownloadState["deliver"]) => {
    if (!entry || entry.type < 3 || entry.size > 512 * 1024 * 1024) {
      const reason = entry && entry.size > 512 * 1024 * 1024 ? "当前 G0 传输上限为 512 MB" : "请选择一个文件";
      setError(reason);
      deliver?.reject(new Error(reason));
      return;
    }
    if (downloadRef.current) {
      const reason = "已有文件正在传输";
      setError(reason);
      deliver?.reject(new Error(reason));
      return;
    }
    const id = Date.now();
    downloadRef.current = { id, name: entry.name, chunks: [], received: 0, size: entry.size, deliver };
    setTransferProgress({ label: `读取 ${entry.name}`, value: 0 });
    send({ action: "download", sub: "start", id, path: joinPath(pathRef.current, entry.name) });
  };

  useImperativeHandle(ref, () => ({
    transferSelected: () => new Promise<File>((resolve, reject) => beginDownloadEntry(selectedFile, { resolve, reject })),
    receiveTransferred: (file) => {
      if (connection !== "connected") throw new Error(`${device.name} 文件通道尚未连接`);
      if (entries.some((entry) => entry.name.toLocaleLowerCase() === file.name.toLocaleLowerCase())) setPendingUpload(file);
      else beginUpload(file);
    },
  }), [connection, device.name, entries, selectedFile?.name, selectedFile?.size]);

  const createFolder = () => {
    if (!validName(folderName)) return;
    send({ action: "mkdir", reqid: Date.now(), path: joinPath(pathRef.current, folderName) });
    setFolderName("");
    setCreateOpen(false);
    setMessage("新建目录请求已发送，正在刷新");
    window.setTimeout(() => requestDirectory(pathRef.current), 350);
  };

  const rename = () => {
    if (!actionDialog || actionDialog.type !== "rename" || !validName(renameName)) return;
    send({ action: "rename", path: pathRef.current, oldname: actionDialog.entry.name, newname: renameName });
    setRenameName("");
    setActionDialog(null);
    setMessage("重命名请求已发送，正在刷新");
    window.setTimeout(() => requestDirectory(pathRef.current), 350);
  };

  const remove = () => {
    if (!actionDialog || actionDialog.type !== "delete" || deleteText !== "删除") return;
    send({ action: "rm", reqid: Date.now(), path: pathRef.current, delfiles: [actionDialog.entry.name], rec: true });
    setDeleteText("");
    setActionDialog(null);
    setMessage("永久删除请求已发送，正在刷新");
    window.setTimeout(() => requestDirectory(pathRef.current), 350);
  };

  const openAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    requestDirectory(address);
  };

  const goUp = () => {
    const parts = path.split("/").filter(Boolean);
    requestDirectory(parts.slice(0, -1).join("/"));
  };

  const openContextMenu = (event: ReactMouseEvent, entry: RemoteEntry) => {
    event.preventDefault();
    setSelected([entry.name]);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 190),
      entry,
    });
  };

  const openContextMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: RemoteEntry) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setSelected([entry.name]);
    setContextMenu({ x: Math.min(bounds.left + 14, window.innerWidth - 190), y: Math.min(bounds.top + 36, window.innerHeight - 190), entry });
  };

  const openRenameDialog = (entry: RemoteEntry) => {
    setRenameName(entry.name);
    setActionDialog({ type: "rename", entry });
    setContextMenu(null);
  };

  const openDeleteDialog = (entry: RemoteEntry) => {
    setDeleteText("");
    setActionDialog({ type: "delete", entry });
    setContextMenu(null);
  };

  if (connection !== "connected") {
    return <div className="live-files-connect"><div className="folder-hero" aria-hidden="true" /><h2>{connection === "starting" ? `正在连接 ${device.name}` : connection === "ended" ? "文件会话已结束" : connection === "error" ? "连接未成功" : device.state === "online" ? "正在准备文件通道" : "设备当前离线"}</h2><p>{paneLabel}窗口将在连接后直接读取设备目录。</p>{(connection === "ended" || connection === "error") && <button onClick={() => void start()} disabled={device.state !== "online"}>{device.state === "online" ? "重新连接" : "设备当前离线"}</button>}{error && <span className="inline-error">{error}</span>}</div>;
  }

  return (
    <div className="live-files">
      <div className="file-toolbar live-file-toolbar">
        <span className="file-pane-identity"><strong>{paneLabel}</strong><span>{device.name}</span></span>
        <button className="file-up-button" onClick={goUp} disabled={loading || !path} aria-label="返回上一级目录">← 上一级</button>
        <span className="file-toolbar-spacer" />
        <button onClick={() => requestDirectory(pathRef.current)} disabled={loading}>刷新</button>
        <button onClick={() => fileInputRef.current?.click()}>上传文件</button>
        <div className="file-create-wrap">
          <button className="file-create-button" onClick={(event) => { event.stopPropagation(); setCreateOpen((current) => !current); setContextMenu(null); }}>＋ 新建</button>
          {createOpen && <form className="file-create-popover" onSubmit={(event) => { event.preventDefault(); createFolder(); }} onClick={(event) => event.stopPropagation()}>
            <strong>新建文件夹</strong>
            <input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="文件夹名称" maxLength={128} autoFocus />
            <div><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button type="submit" disabled={!validName(folderName)}>创建</button></div>
          </form>}
        </div>
        <input ref={fileInputRef} className="visually-hidden" type="file" onChange={chooseUpload} />
      </div>
      <form className="file-address" onSubmit={openAddress}>
        <button type="button" onClick={() => requestDirectory("")} aria-label="打开设备根目录">根目录</button>
        <span className="file-address-device">{device.name}:</span>
        <input aria-label={`${paneLabel}地址`} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入目录地址" spellCheck={false} />
        <button type="submit" disabled={loading}>转到</button>
        <small>{loading ? "读取中" : `${entries.length} 项`}</small>
      </form>
      {(message || error) && <div className={error ? "file-message file-message-error" : "file-message"}>{error ?? message}</div>}
      {transferProgress && <div className="file-transfer"><span>{transferProgress.label}</span><progress max={1} value={transferProgress.value} /><strong>{Math.round(transferProgress.value * 100)}%</strong></div>}
      {pendingUpload && <div className="file-confirm"><div><strong>覆盖已有文件？</strong><span>{pendingUpload.name}</span></div><button onClick={() => setPendingUpload(null)}>取消</button><button className="danger-inline" onClick={() => beginUpload(pendingUpload)}>确认覆盖</button></div>}
      <div className="file-icon-grid" role="listbox" aria-label={`${device.name} 实机文件`}>
        {entries.map((entry) => <button className={`file-icon-item ${selected.includes(entry.name) ? "selected" : ""}`} type="button" role="option" aria-selected={selected.includes(entry.name)} key={entry.name} title={`${entry.name}\n${entry.type < 3 ? "文件夹" : formatSize(entry.size)}\n${formatModified(entry.modified)}`} onClick={() => setSelected([entry.name])} onDoubleClick={() => { if (entry.type < 3) requestDirectory(joinPath(pathRef.current, entry.name)); }} onContextMenu={(event) => openContextMenu(event, entry)} onKeyDown={(event) => openContextMenuFromKeyboard(event, entry)}>
          <span className={`entry-icon ${entry.type < 3 ? "entry-folder-icon" : "entry-file-icon"}`} aria-hidden="true">{entry.type < 3 ? <svg viewBox="0 0 32 26"><path d="M2 6.5h11l3-4h6.5c2 0 3.5 1.5 3.5 3.5v2H2Z"/><path d="M2 7h27a2 2 0 0 1 2 2.3l-2 12.2a3 3 0 0 1-3 2.5H5a3 3 0 0 1-3-3Z"/></svg> : <svg viewBox="0 0 26 32"><path d="M4 1h11l7 7v21a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"/><path d="M15 1v8h7"/></svg>}</span>
          <span className="entry-name">{entry.name}</span>
          <small>{entry.driveType ?? (entry.type < 3 ? "文件夹" : formatSize(entry.size))}</small>
        </button>)}
        {!loading && entries.length === 0 && <div className="file-empty"><strong>此目录为空</strong><span>可上传文件或新建目录。</span></div>}
      </div>
      {contextMenu && <div className="file-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <strong>{contextMenu.entry.name}</strong>
        {contextMenu.entry.type < 3 && <button role="menuitem" onClick={() => { requestDirectory(joinPath(pathRef.current, contextMenu.entry.name)); setContextMenu(null); }}>打开文件夹</button>}
        {contextMenu.entry.type >= 3 && <button role="menuitem" onClick={() => { beginDownloadEntry(contextMenu.entry); setContextMenu(null); }}>下载</button>}
        <button role="menuitem" onClick={() => openRenameDialog(contextMenu.entry)}>重命名</button>
        <button className="context-danger" role="menuitem" onClick={() => openDeleteDialog(contextMenu.entry)}>删除</button>
      </div>}
      {actionDialog && <div className="file-action-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActionDialog(null); }}>
        <form className="file-action-dialog" onSubmit={(event) => { event.preventDefault(); if (actionDialog.type === "rename") rename(); else remove(); }}>
          <strong>{actionDialog.type === "rename" ? "重命名" : "永久删除"}</strong>
          <p>{actionDialog.type === "rename" ? actionDialog.entry.name : `将永久删除“${actionDialog.entry.name}”，此操作无法撤销。`}</p>
          <input value={actionDialog.type === "rename" ? renameName : deleteText} onChange={(event) => actionDialog.type === "rename" ? setRenameName(event.target.value) : setDeleteText(event.target.value)} placeholder={actionDialog.type === "rename" ? "输入新名称" : "输入：删除"} autoFocus />
          <div><button type="button" onClick={() => setActionDialog(null)}>取消</button><button className={actionDialog.type === "delete" ? "dialog-danger" : ""} type="submit" disabled={actionDialog.type === "rename" ? !validName(renameName) : deleteText !== "删除"}>{actionDialog.type === "rename" ? "保存" : "永久删除"}</button></div>
        </form>
      </div>}
    </div>
  );
});

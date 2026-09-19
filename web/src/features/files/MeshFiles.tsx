import { Dropdown } from "../../components/Dropdown";
import { createUploadPump, transferLimits } from "./transferUpload";
import { VirtualFileGrid } from "./VirtualFileGrid";
import { FilePreview, previewLimit } from "./FilePreview";
import { useFavoriteDrag } from "./useFavoriteDrag";
import { FileIcon, fileKind } from "./FileIcon";
import { useFolderFavorites } from "./favorites";
import { createTransferPipe, isTransferSource, type TransferSource, type TransferPipe } from "./transferStream";
import { createDownloadStorage, type DownloadStorage, type DownloadArtifact } from "./downloadStorage";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createFileSession, endFileSession } from "../../api/client";
import type { Device } from "../../app/model";
import type { AgentRedirect, MeshCentralModule } from "../meshcentral";

interface RemoteFileModule extends MeshCentralModule {
  protocol: 5;
}

export interface RemoteEntry {
  name: string;
  type: number;
  size: number;
  modified?: number | string;
  driveType?: string;
}

interface UploadState {
  pump?: ReturnType<typeof createUploadPump>;
  folder?: boolean;
  file: File | TransferSource;
  offset: number;
  requestId: number;
}

interface DownloadState {
  window?: number;
  frames?: number;
  queued?: number;
  writes?: Promise<void>;
  maxSize?: number;
  folder?: boolean;
  sourceEnded?: boolean;
  id: number;
  name: string;
  storage?: DownloadStorage;
  pipe?: TransferPipe;
  streamReady?: { resolve: (source: TransferSource) => void; reject: (error: Error) => void };
  received: number;
  size: number;
  deliver?: {
    resolve: (artifact: DownloadArtifact) => void;
    reject: (error: Error) => void;
  };
}

export interface FilePaneSelection {
  name: string;
  size: number;
}

export interface MeshFilesHandle {
  transferSelected: (target: MeshFilesHandle | null, onProgress?: (done: number, total: number, name: string) => void) => Promise<number>;
  receiveTransferred: (file: File | TransferSource, folder?: boolean) => Promise<void>;
}

type ConnectionState = "idle" | "starting" | "connected" | "ended" | "error";
type FileActionDialog = { type: "rename" | "delete"; entry: RemoteEntry } | null;
type ContextMenuState = { x: number; y: number; entry: RemoteEntry } | null;

const decoder = new TextDecoder();

function joinPath(parent: string, name: string) {
  return parent ? `${parent.replace(/\/$/, "")}/${name}` : name;
}

// Windows 的盘符根目录必须保留斜杠，C: 是驱动器相对路径。
export function normalizeDirectoryPath(value: string, windows = false) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return windows && /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized;
}

export function defaultDirectoryForDevice(device: Pick<Device, "id" | "platform">) {
  return device.platform === "Ubuntu" ? `home/${device.id}` : "";
}

export function validName(name: string) {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
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

export function sortEntries(entries: RemoteEntry[], key: "name" | "modified" | "size", descending = false) {
  const timestamp = (value: RemoteEntry["modified"]) => {
    if (value == null) return 0;
    const number = Number(value);
    return Number.isFinite(number) ? (number < 10_000_000_000 ? number * 1000 : number) : (Date.parse(String(value)) || 0);
  };
  return [...entries].sort((a,b) => {
    const names = a.name.localeCompare(b.name,"zh-CN",{numeric:true,sensitivity:"base"});
    const compared = key === "size" ? a.size-b.size : key === "modified" ? timestamp(a.modified)-timestamp(b.modified) : names;
    return ((a.type<3?0:1)-(b.type<3?0:1)) || ((compared || names)*(descending?-1:1));
  });
}

interface MeshFilesProps {
  device: Device;
  paneLabel: string;
  locked?: boolean;
  onOpenDesktop?: () => void;
  onSelectionChange?: (selection: FilePaneSelection[]) => void;
}

export const MeshFiles = forwardRef<MeshFilesHandle, MeshFilesProps>(function MeshFiles({ device, paneLabel, locked = false, onSelectionChange, onOpenDesktop }, ref) {
  const openDirectoryRequest = useRef<number | null>(null);
  const [openingDirectory, setOpeningDirectory] = useState(false);
  const [preview, setPreview] = useState<{ name: string; load: () => Promise<DownloadArtifact> } | null>(null);
  const { favorites, toggle, place, syncError, syncing } = useFolderFavorites(device.id);
  const toggleFavorite = (folderPath: string) => {
    void toggle(folderPath);
  };
  const redirectRef = useRef<AgentRedirect<RemoteFileModule> | null>(null);
  const sessionRef = useRef<string | null>(null);
  const pathRef = useRef("");
  const folderTransferRef = useRef(false);
  const mountedRef = useRef(true);
  const autoStartAttemptedRef = useRef(false);
  const uploadRef = useRef<UploadState | null>(null);
  const downloadRef = useRef<DownloadState | null>(null);
  const pendingSourceRef = useRef<File | TransferSource | null>(null);
  const uploadResultRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const transferTimer = useRef<number | undefined>(undefined);
  const requestSequence = useRef(Date.now());
  const directoryRequest = useRef<{ id: number; page: number; entries: RemoteEntry[]; publishedAt: number } | null>(null);
  const directoryTimer = useRef<number | undefined>(undefined);
  const batchRef = useRef(false);
  const anchorRef = useRef<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [sortKey, setSortKey] = useState<"name" | "modified" | "size">("name");
  const [descending, setDescending] = useState(false);
  const [compressNames, setCompressNames] = useState<string[] | null>(null);
  const [archiveName, setArchiveName] = useState("");
  const [compressing, setCompressing] = useState(false);
  const compressRequest = useRef<number | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const entriesRef = useRef<RemoteEntry[]>([]);
  const [path, setPath] = useState("");
  const [confirmedDirectory, setConfirmedDirectory] = useState<string | null>(null);
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
  const [pendingUpload, setPendingUpload] = useState<File | TransferSource | null>(null);
  const [transferProgress, publishTransferProgress] = useState<{ label: string; value: number } | null>(null);

  const progressUpdate = useRef<{ at: number; label: string; pending: { label: string; value: number } | null; timer?: number }>({ at: 0, label: "", pending: null });
  const setTransferProgress = (value: { label: string; value: number } | null) => {
    const update = progressUpdate.current;
    if (value === null) {
      window.clearTimeout(update.timer); update.timer = undefined; update.pending = null; update.label = "";
      publishTransferProgress(null); return;
    }
    const now = performance.now();
    if (value.label !== update.label || now - update.at >= 100) {
      window.clearTimeout(update.timer); update.timer = undefined; update.pending = null;
      update.at = now; update.label = value.label; publishTransferProgress(value); return;
    }
    update.pending = value;
    update.timer ??= window.setTimeout(() => {
      update.timer = undefined;
      const pending = update.pending; update.pending = null;
      if (pending && mountedRef.current) { update.at = performance.now(); update.label = pending.label; publishTransferProgress(pending); }
    }, 100 - (now - update.at));
  };
  useEffect(() => () => { window.clearTimeout(progressUpdate.current.timer); progressUpdate.current.timer = undefined; progressUpdate.current.pending = null; }, []);

  const generation = useRef(0);
  const connecting = useRef(false);
  const handshakeTimer = useRef<number | undefined>(undefined);

  const send = (command: Record<string, unknown>) => redirectRef.current?.sendText(command);

  const watchDirectory = () => {
    window.clearTimeout(directoryTimer.current);
    directoryTimer.current = window.setTimeout(() => {
      directoryRequest.current = null;
      setLoading(false); setConfirmedDirectory(null);
      setError("目录读取超时，请重新打开目录；未自动重试。");
    }, 15_000);
  };

  const requestDirectory = (nextPath: string) => {
    const normalized = normalizeDirectoryPath(nextPath, device.platform === "Windows");
    pathRef.current = normalized;
    setPath(normalized);
    setAddress(normalized);
    setLoading(true);
    setConfirmedDirectory(null);
    setSelected([]);
    anchorRef.current = null;
    const id = ++requestSequence.current;
    directoryRequest.current = { id, page: 0, entries: [], publishedAt: 0 };
    entriesRef.current = [];
    setEntries([]);
    watchDirectory();
    send({ action: "ls", reqid: id, path: normalized, paged: true, page: 0 });
  };

  const stop = async (next: ConnectionState = "ended") => {
    generation.current++;
    directoryRequest.current = null;
    window.clearTimeout(directoryTimer.current);
    if (mountedRef.current) setLoading(false);
    openDirectoryRequest.current = null;
    setOpeningDirectory(false);
    folderTransferRef.current = false;
    connecting.current = false;
    window.clearTimeout(handshakeTimer.current);
    window.clearTimeout(transferTimer.current);
    if (compressRequest.current !== null) { compressRequest.current = null; setCompressing(false); setError("压缩结果未确认，请重新连接后检查当前目录；未自动重试。"); }
    uploadResultRef.current?.reject(new Error("文件会话已结束，上传结果未确认"));
    uploadResultRef.current = null;
    pendingSourceRef.current = null;
    setPendingUpload(null);
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
    activeDownload?.streamReady?.reject(new Error("文件会话已结束"));
    activeDownload?.pipe?.source.abort(new Error("来源文件会话已结束"));
    void activeDownload?.storage?.dispose().catch(() => undefined);
    if (mountedRef.current) setConnection(next);
    if (sessionId) {
      try { await endFileSession(sessionId); } catch { /* 关闭中继也会使会话失效。 */ }
    }
  };

  // 只延长正在推进的单次传输等待；超时关闭通道，禁止重放未确认操作。
  const touchTransfer = () => {
    window.clearTimeout(transferTimer.current);
    transferTimer.current = window.setTimeout(() => {
      void stop("error");
      setError("文件传输长时间无响应，已停止；上传结果未确认，请检查目标目录。");
    }, downloadRef.current?.folder || uploadRef.current?.folder ? 180_000 : 60_000);
  };

  const saveToBrowser = (file: File, dispose?: () => Promise<void>) => {
    const href = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => { URL.revokeObjectURL(href); void dispose?.().catch(() => undefined); }, 30_000);
  };

  const failDownload = (active: DownloadState, caught: unknown) => {
    if (downloadRef.current !== active) return;
    window.clearTimeout(transferTimer.current);
    downloadRef.current = null;
    if (!active.sourceEnded) send({ action: "download", sub: "stop", id: active.id });
    void active.storage?.dispose().catch(() => undefined);
    const failure = caught instanceof Error ? caught : new Error("读取来源文件失败");
    active.deliver?.reject(failure);
    active.streamReady?.reject(failure);
    active.pipe?.source.abort(failure);
    setTransferProgress(null);
    setError(failure.message);
  };

  const finishDownload = async (active: DownloadState) => {
    if (active.received !== active.size) throw new Error("下载大小与预期不符，未保存不完整文件，请刷新目录后重试。");
    if (!active.storage) throw new Error("下载暂存尚未就绪");
    const artifact = await active.storage.finish(active.name);
    if (downloadRef.current !== active) { await artifact.dispose(); return; }
    window.clearTimeout(transferTimer.current);
    downloadRef.current = null;
    setTransferProgress(null);
    if (active.deliver) {
      active.deliver.resolve(artifact);
      setMessage(`${active.name} 已读取`);
    } else {
      saveToBrowser(artifact.file, artifact.dispose);
      setMessage(`${active.name} 已接收 ${formatSize(active.received)}`);
    }
  };

  const handleBinary = (data: Uint8Array) => {
    if (data.length > 0 && data[0] === 123) { handleCommand(decoder.decode(data)); return; }
    const active = downloadRef.current;
    if (!active || data.length < 4) return;
    if (active.window === undefined) return;
    const headerSize = active.window > 1 ? 12 : 4;
    if (data.length < headerSize) { failDownload(active, new Error("下载帧头不完整")); return; }
    // 取消或切换文件后丢弃旧窗口中仍在途的正文，禁止混入下一文件。
    if (headerSize === 12 && new DataView(data.buffer, data.byteOffset + 4, 8).getBigUint64(0) !== BigInt(active.id)) return;
    const last = (data[3] & 1) !== 0;
    if (active.sourceEnded || (active.window > 1 && data.length > 256 * 1024 + headerSize) || (active.queued ?? 0) >= active.window) {
      failDownload(active, new Error("来源数据超出传输窗口或结束边界")); return;
    }
    active.sourceEnded = last;
    active.queued = (active.queued ?? 0) + 1;
    // 磁盘写入和完成确认严格串行；排队帧数不超过已协商窗口。
    active.writes = (active.writes ?? Promise.resolve()).then(async () => {
      if (downloadRef.current !== active) return;
      touchTransfer();
      const payload = data.slice(headerSize);
      active.received += payload.length;
      active.frames = (active.frames ?? 0) + 1;
      if (active.received > active.size) throw new Error("读取内容超过预期大小，已停止传输");
      if (active.pipe) {
        window.clearTimeout(transferTimer.current);
        active.pipe.accept(payload, last);
        if (downloadRef.current !== active) return;
        setTransferProgress({ label: `转发 ${active.name}`, value: active.size > 0 ? active.received / active.size : 0 });
        if (last) { downloadRef.current = null; setTransferProgress(null); }
        return;
      }
      if (!active.storage) throw new Error("下载暂存尚未就绪");
      if (payload.length) await active.storage.write(payload);
      if (downloadRef.current !== active) return;
      setTransferProgress({ label: `下载 ${active.name}`, value: active.size > 0 ? active.received / active.size : 0 });
      if (last) await finishDownload(active);
      else send({ action: "download", sub: "ack", id: active.id, ...(active.window! > 1 ? { ack: active.frames } : {}) });
    }).catch((caught: unknown) => failDownload(active, caught)).finally(() => { active.queued!--; });
  };

  const uploadPump = (upload: UploadState) => {
    if (upload.pump) return upload.pump;
    upload.pump = createUploadPump(upload.file.size, async limit => {
      touchTransfer();
      if (isTransferSource(upload.file)) return upload.file.read();
      const end = Math.min(upload.offset + limit, upload.file.size);
      return upload.offset >= upload.file.size ? null : new Uint8Array(await upload.file.slice(upload.offset, end).arrayBuffer());
    }, chunk => {
      upload.offset += chunk.length;
      if (chunk[0] === 0 || chunk[0] === 123) {
        const escaped = new Uint8Array(chunk.length + 1); escaped.set(chunk, 1); chunk = escaped;
      }
      redirectRef.current!.send(chunk);
    }, () => send({ action: "uploaddone", reqid: upload.requestId }), bytes => {
      setTransferProgress({ label: `上传 ${upload.file.name}`, value: upload.file.size ? bytes / upload.file.size : 0 });
    }, () => uploadRef.current === upload && redirectRef.current !== null);
    return upload.pump;
  };

  const handleCommand = (raw: string) => {
    let command: Record<string, unknown>;
    try { command = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const action = typeof command.action === "string" ? command.action : "";
    if (openDirectoryRequest.current !== null && command.reqid === openDirectoryRequest.current && (action === "directory-open-requested" || action === "error")) {
      openDirectoryRequest.current = null; setOpeningDirectory(false); window.clearTimeout(transferTimer.current);
      if (action === "directory-open-requested") { onOpenDesktop?.(); return; }
    }
    if ((action === "compressed" || action === "error") && compressRequest.current !== null && command.reqid === compressRequest.current) {
      compressRequest.current = null; setCompressing(false); window.clearTimeout(transferTimer.current);
      if (action === "compressed") { setMessage(`已在当前设备目录生成 ${String(command.name)}`); requestDirectory(pathRef.current); return; }
    }
    if (action === "error") { setError(typeof command.message === "string" ? command.message : "文件操作失败"); setLoading(false); return; }
    if (action === "refresh") {
      requestDirectory(pathRef.current);
      return;
    }
    if (action === "download") {
      const active = downloadRef.current;
      if (active && command.id === active.id && command.sub === "progress") {
        touchTransfer(); setTransferProgress({ label: "正在打包文件夹", value: 0 });
      }
      if (active && command.id === active.id && command.sub === "start") {
        const size = typeof command.size === "number" ? command.size : active.folder ? NaN : active.size;
        if (active.maxSize !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > active.maxSize)) { failDownload(active, new Error("临时预览仅支持 16 MiB 以内的文件，请下载查看。")); return; }
        try { active.window = transferLimits(command).window; }
        catch (caught) { failDownload(active, caught); return; }
        if (active.streamReady) {
          try {
            active.size = size;
            active.pipe = createTransferPipe(active.name, size, (first, ack) => {
              if (downloadRef.current !== active) throw new Error("来源文件会话已结束");
              touchTransfer();
              send({ action: "download", sub: first ? "startack" : "ack", id: active.id, ack });
            }, failure => failDownload(active, failure), active.window);
            window.clearTimeout(transferTimer.current);
            active.streamReady.resolve(active.pipe.source);
          } catch (caught) { failDownload(active, caught); }
          return;
        }
        void createDownloadStorage(size).then(async storage => {
          if (downloadRef.current !== active) { await storage.dispose(); return; }
          active.size = size;
          active.storage = storage;
          touchTransfer(); send({ action: "download", sub: "startack", id: active.id });
        }).catch((caught: unknown) => failDownload(active, caught));
      }
      if (active && command.id === active.id && command.sub === "cancel") {
        active.sourceEnded = true;
        failDownload(active, new Error(typeof command.message === "string" ? command.message : "来源设备未能完成文件读取"));
      }
      return;
    }
    if (action === "uploadprogress" && uploadRef.current?.requestId === command.reqid) {
      touchTransfer(); setTransferProgress({ label: "正在解压文件夹", value: 1 }); return;
    }
    if (action === "uploadstart" || action === "uploadack") {
      if (!uploadRef.current || command.reqid !== uploadRef.current.requestId) return;
      const pump = uploadPump(uploadRef.current);
      void Promise.resolve().then(() => action === "uploadstart" ? pump.start(command) : pump.acknowledge(command.ack)).catch((caught: unknown) => {
        const failure = caught instanceof Error ? caught : new Error("文件转发失败");
        uploadResultRef.current?.reject(failure);
        void stop("error"); setError(failure.message);
      });
      return;
    }
    if (action === "uploaddone") {
      if (!uploadRef.current || command.reqid !== uploadRef.current.requestId) return;
      window.clearTimeout(transferTimer.current);
      const result = uploadResultRef.current;
      uploadResultRef.current = null;
      const file = uploadRef.current.file;
      const name = file.name;
      // 队列持有的接收句柄也要看到刚确认的文件，避免大小写同名文件静默覆盖。
      entriesRef.current = [...entriesRef.current.filter((entry) => entry.name.toLocaleLowerCase() !== name.toLocaleLowerCase()), { name, type: uploadRef.current.folder ? 2 : 3, size: file.size }];
      uploadRef.current = null;
      setTransferProgress(null);
      setMessage(name ? `${name} 上传完成` : "上传完成");
      requestDirectory(pathRef.current);
      result?.resolve();
      return;
    }
    if (action === "uploaderror") {
      if (!uploadRef.current || command.reqid !== uploadRef.current.requestId) return;
      window.clearTimeout(transferTimer.current);
      uploadResultRef.current?.reject(new Error(typeof command.message === "string" ? command.message : "目标设备拒绝了上传"));
      uploadResultRef.current = null;
      uploadRef.current = null;
      setTransferProgress(null);
      setError(typeof command.message === "string" ? command.message : "目标设备拒绝了上传");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(command, "path")) {
      const responsePath = typeof command.path === "string" ? normalizeDirectoryPath(command.path, device.platform === "Windows") : pathRef.current;
      const request = directoryRequest.current;
      if (!request || responsePath !== pathRef.current || (command.reqid !== undefined && command.reqid !== request.id)) return;
      window.clearTimeout(directoryTimer.current);
      if (command.page !== undefined && command.page !== request.page) {
        directoryRequest.current = null; setLoading(false); setError("目录分页顺序无效，请重新打开目录"); return;
      }
      pathRef.current = responsePath;
      setPath(responsePath);
      setAddress(responsePath);
      folderTransferRef.current = command.folderTransfer === true;
      if (command.dir == null) {
        directoryRequest.current = null; entriesRef.current = []; setEntries([]);
        setLoading(false); setConfirmedDirectory(null);
        setError(typeof command.message === "string" ? command.message : "无法访问该目录"); return;
      }
      request.entries.push(...parseEntries(command.dir));
      const more = command.more === true;
      const now = performance.now();
      if (!more || request.page === 0 || now - request.publishedAt >= 150) {
        entriesRef.current = [...request.entries];
        setEntries(entriesRef.current);
        request.publishedAt = now;
      }
      setLoading(more);
      setConfirmedDirectory(more ? null : responsePath);
      setError(null);
      if (more) {
        request.page++;
        watchDirectory();
        send({ action: "ls", reqid: request.id, path: responsePath, paged: true, page: request.page });
      } else directoryRequest.current = null;
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
          if (!mountedRef.current || attempt !== generation.current) return;
          if (data.length > 0 && data.charCodeAt(0) !== 123) {
            handleBinary(Uint8Array.from(data, (character) => character.charCodeAt(0)));
          } else {
            handleCommand(data);
          }
        },
        ProcessBinaryData: data => { if (mountedRef.current && attempt === generation.current) handleBinary(data); },
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

  const beginUpload = (file: File | TransferSource, folder = false) => {
    pendingSourceRef.current = null;
    setPendingUpload(null);
    setError(null);
    setMessage(null);
    const requestId = ++requestSequence.current;
    touchTransfer();
    uploadRef.current = { file, folder, offset: 0, requestId };
    setTransferProgress({ label: `上传 ${file.name}`, value: 0 });
    send({ action: "upload", reqid: requestId, path: pathRef.current, name: file.name, size: file.size, folder, window: 8 });
  };

  const chooseUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void receiveTransferred(file).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "上传失败"));
  };

  const visibleEntries = useMemo(() => sortEntries(entries, sortKey, descending), [entries, sortKey, descending]);
  const selectedNames = useMemo(() => new Set(selected), [selected]);
  const selectedEntries = useMemo(() => visibleEntries.filter((entry) => selectedNames.has(entry.name)), [visibleEntries, selectedNames]);
  const selectedFiles = selectedEntries.filter((entry) => entry.type >= 3);
  const selectionKey = JSON.stringify(selectedEntries.filter((entry) => entry.type !== 1).map(({ name, size }) => ({ name, size })));
  const busy = openingDirectory || compressing || locked || batchBusy || pendingUpload !== null || transferProgress !== null;

  const placeFolder = (folderPath: string, index?: number) => {
    void place(folderPath, index);
  };
  const favoriteDrag = useFavoriteDrag(syncing || busy || loading || connection !== "connected", favorites.length, placeFolder);

  useEffect(() => {
    onSelectionChange?.(connection === "connected" && !loading ? JSON.parse(selectionKey) as FilePaneSelection[] : []);
  }, [onSelectionChange, selectionKey, selectedEntries.length, selectedFiles.length, connection, loading]);

  const beginDownloadEntry = (entry: RemoteEntry | null, deliver?: DownloadState["deliver"], streamReady?: DownloadState["streamReady"], maxSize?: number) => {
    if (!entry || entry.type === 1) {
      const reason = "请选择文件或文件夹";
      setError(reason);
      deliver?.reject(new Error(reason));
      streamReady?.reject(new Error(reason));
      return;
    }
    if (!redirectRef.current || downloadRef.current || uploadRef.current) {
      const reason = "文件通道未连接或已有文件正在传输";
      setError(reason);
      deliver?.reject(new Error(reason));
      streamReady?.reject(new Error(reason));
      return;
    }
    if (entry.type === 2 && !folderTransferRef.current) {
      const failure = new Error("来源设备文件进程尚未升级，不支持文件夹传输");
      deliver?.reject(failure); streamReady?.reject(failure); return;
    }
    const id = ++requestSequence.current;
    downloadRef.current = { id, folder: entry.type === 2, name: entry.name, received: 0, size: entry.size, deliver, streamReady, maxSize };
    touchTransfer();
    setTransferProgress({ label: `读取 ${entry.name}`, value: 0 });
    send({ action: "download", sub: "start", id, path: joinPath(pathRef.current, entry.name), folder: entry.type === 2, window: 8 });
  };

  const openInDesktop = (directory: string) => {
    if (!onOpenDesktop || busy || loading) return;
    const reqid = ++requestSequence.current;
    openDirectoryRequest.current = reqid; setOpeningDirectory(true); setContextMenu(null); setError(null);
    setMessage("正在请求系统文件管理器，收到启动回执后连接控屏；窗口是否显示需在桌面确认。");
    send({ action: "open-directory", reqid, path: directory });
    window.clearTimeout(transferTimer.current);
    transferTimer.current = window.setTimeout(() => {
      openDirectoryRequest.current = null; setOpeningDirectory(false); setError("打开目录结果未确认，未自动重试；请检查目标桌面或升级文件进程。");
    }, 15_000);
  };

  const openPreview = (entry: RemoteEntry) => {
    setContextMenu(null);
    setPreview({ name: entry.name, load: () => {
      if (entry.size > previewLimit) return Promise.reject(new Error("临时预览仅支持 16 MiB 以内的文件，请下载查看。"));
      return new Promise<DownloadArtifact>((resolve, reject) => beginDownloadEntry(entry, { resolve, reject }, undefined, previewLimit));
    } });
  };
  const closePreview = () => {
    const active = downloadRef.current;
    if (active?.maxSize !== undefined) failDownload(active, new Error("已取消预览读取"));
    setPreview(null);
  };

  const receiveTransferred = (file: File | TransferSource, folder = false) => {
    const result = new Promise<void>((resolve, reject) => {
      if (folder && !folderTransferRef.current) { reject(new Error("目标设备文件进程尚未升级，不支持文件夹传输")); return; }
      if (!redirectRef.current || connection !== "connected" || loading || pendingUpload || uploadRef.current || uploadResultRef.current || downloadRef.current) {
        reject(new Error(`${device.name} 文件通道尚未连接或正在传输`));
        return;
      }
      if (!Number.isSafeInteger(file.size) || file.size < 0 || !validName(file.name)) {
        reject(new Error("文件名称或大小无效"));
        return;
      }
      const existing = entriesRef.current.find((entry) => entry.name.toLocaleLowerCase() === file.name.toLocaleLowerCase());
      if (existing && (folder || existing.type < 3)) {
        reject(new Error(`${file.name} 与目标项目同名，未上传；请改名后重新传输`));
        return;
      }
      uploadResultRef.current = { resolve, reject };
      if (existing) { pendingSourceRef.current = file; setPendingUpload(file); }
      else beginUpload(file, folder);
    });
    if (!isTransferSource(file)) return result;
    return Promise.race([result, file.failed]).catch((caught: unknown) => {
      const failure = caught instanceof Error ? caught : new Error("设备间复制失败");
      file.abort(failure);
      // 失败同时关闭接收端活动上传或覆盖对话框，避免悬挂及迟到确认。
      if (uploadRef.current?.file === file || pendingSourceRef.current === file) void stop("error");
      throw failure;
    });
  };

  const transferSelected: MeshFilesHandle["transferSelected"] = async (target, onProgress) => {
    if (batchRef.current || uploadRef.current || downloadRef.current || pendingUpload) throw new Error("已有文件正在传输");
    if (!selectedEntries.length || selectedEntries.some((entry) => entry.type === 1)) throw new Error("请选择文件或文件夹，不能传输整个磁盘");
    const attempt = generation.current;
    batchRef.current = true;
    setBatchBusy(true);
    let completed = 0;
    try {
      for (const entry of selectedEntries) {
        if (!mountedRef.current || attempt !== generation.current) throw new Error("源文件会话已结束");
        onProgress?.(completed, selectedEntries.length, entry.name);
        if (target) {
          const source = await new Promise<TransferSource>((resolve, reject) => beginDownloadEntry(entry, undefined, { resolve, reject }));
          try { await target.receiveTransferred(source, entry.type === 2); }
          catch (caught) { source.abort(caught instanceof Error ? caught : new Error("设备间复制失败")); throw caught; }
        } else {
          const artifact = await new Promise<DownloadArtifact>((resolve, reject) => beginDownloadEntry(entry, { resolve, reject }));
          saveToBrowser(entry.type === 2 ? new File([artifact.file], `${artifact.file.name}.tar.gz`) : artifact.file, artifact.dispose);
        }
        completed++;
      }
      return completed;
    } catch (caught) {
      throw new Error(`已${target ? "完成" : "交给浏览器下载"} ${completed}/${selectedEntries.length} 个文件；${caught instanceof Error ? caught.message : "传输失败"}。后续文件未继续传输。`);
    } finally {
      batchRef.current = false;
      setBatchBusy(false);
    }
  };

  const cancelUpload = () => {
    pendingSourceRef.current = null;
    setPendingUpload(null);
    uploadResultRef.current?.reject(new Error("已取消覆盖，文件未上传"));
    uploadResultRef.current = null;
  };

  const selectEntry = (event: ReactMouseEvent, entry: RemoteEntry) => {
    if (busy || loading) return;
    if (event.shiftKey && anchorRef.current) {
      const start = visibleEntries.findIndex((item) => item.name === anchorRef.current);
      const end = visibleEntries.indexOf(entry);
      const range = visibleEntries.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.name);
      setSelected((previous) => event.ctrlKey || event.metaKey ? [...new Set([...previous, ...range])] : range);
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((previous) => previous.includes(entry.name) ? previous.filter((name) => name !== entry.name) : [...previous, entry.name]);
      anchorRef.current = entry.name;
    } else {
      setSelected([entry.name]);
      anchorRef.current = entry.name;
    }
  };

  useImperativeHandle(ref, () => ({ transferSelected, receiveTransferred }));

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
    if (busy || loading) return;
    if (!selected.includes(entry.name)) setSelected([entry.name]);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 280),
      entry,
    });
  };

  const openContextMenuFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: RemoteEntry) => {
    if (busy || loading) return;
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!selected.includes(entry.name)) setSelected([entry.name]);
    setContextMenu({ x: Math.min(bounds.left + 14, window.innerWidth - 190), y: Math.min(bounds.top + 36, window.innerHeight - 280), entry });
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
      <fieldset className="file-controls" disabled={busy}>
      <div className="file-desktop-entry">
        <div><span className="file-pane-eyebrow">{device.name}{onOpenDesktop ? " · 远程设备" : " · 当前设备"}</span><strong title={path || "根目录"}>{path.split("/").filter(Boolean).at(-1) || (device.platform === "Windows" ? "磁盘列表" : "根目录")}</strong><small>{!onOpenDesktop ? "当前设备不支持控屏" : device.platform === "Windows" && !path ? "选择磁盘后可在控屏中打开" : "浏览远程文件"}</small></div>
        <button type="button" disabled={!onOpenDesktop || loading || confirmedDirectory !== path || (device.platform === "Windows" && !path)} onClick={() => openInDesktop(path)} title={!onOpenDesktop ? "禁止控制当前设备，避免输入回环" : "连接控屏并打开当前目录"}>在控屏中打开目录 <span aria-hidden="true">↗</span></button>
      </div>
      <form className="file-address" onSubmit={openAddress}>
        <button type="button" className="file-up-button" onClick={goUp} disabled={loading || !path} aria-label="返回上一级目录" title="返回上一级目录"><span aria-hidden="true" className="file-up-arrow">↑</span><span>返回上一级</span></button>
        <button type="button" className="file-root-button" onClick={() => requestDirectory(defaultDirectoryForDevice(device))} disabled={loading} aria-label="返回初始目录" title="返回文件窗口首次打开的目录">根目录</button>
        <input aria-label={`${paneLabel}地址`} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="输入目录地址" spellCheck={false} />
        <button type="submit" className="file-go-button" disabled={loading}>转到</button>
      </form>
      <div className="file-toolbar live-file-toolbar">
<div className="file-sort-controls">        <span>排序</span><Dropdown label={`${paneLabel}排序方式`} value={sortKey} disabled={busy} options={[{ value: "name", label: "名称" }, { value: "modified", label: "时间" }, { value: "size", label: "大小" }]} onChange={value => { setSortKey(value); anchorRef.current = null; }}>{sortKey === "name" ? "名称" : sortKey === "modified" ? "时间" : "大小"}</Dropdown>
        <button disabled={busy} onClick={() => { setDescending(!descending); anchorRef.current = null; }} aria-label={`${paneLabel}排序方向`}>{descending ? "降序 ↓" : "升序 ↑"}</button></div>
        <small className="file-entry-count" title="Ctrl/⌘ 点选增减选择，Shift 连选；文件夹不能批量复制">{loading ? "读取中" : `${entries.length} 项 · 已选 ${selected.length}`}{selectedEntries.some(entry => entry.type < 3) ? "（含文件夹）" : ""}</small>
        <div className="file-action-controls">
        <button onClick={() => requestDirectory(pathRef.current)} disabled={loading}>刷新</button>
        <button disabled={loading} onClick={() => fileInputRef.current?.click()}>上传文件</button>
        <div className="file-create-wrap">
          <button className="file-create-button" onClick={(event) => { event.stopPropagation(); setCreateOpen((current) => !current); setContextMenu(null); }}>＋ 新建</button>
          {createOpen && <form className="file-create-popover" onSubmit={(event) => { event.preventDefault(); createFolder(); }} onClick={(event) => event.stopPropagation()}>
            <strong>新建文件夹</strong>
            <input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="文件夹名称" maxLength={128} autoFocus />
            <div><button type="button" onClick={() => setCreateOpen(false)}>取消</button><button type="submit" disabled={!validName(folderName)}>创建</button></div>
          </form>}
        </div>
        </div>
        <input ref={fileInputRef} className="visually-hidden" type="file" onChange={chooseUpload} />
      </div>
      </fieldset>

      {(message || error) && <div className={error ? "file-message file-message-error" : "file-message"}>{error ?? message}</div>}
      {transferProgress && <div className="file-transfer"><span>{transferProgress.label}</span><progress max={1} value={transferProgress.value} /><strong>{Math.round(transferProgress.value * 100)}%</strong></div>}
      {pendingUpload && <div className="file-confirm"><div><strong>覆盖已有文件？</strong><span>{pendingUpload.name} → {path || "根目录"}</span></div><button onClick={cancelUpload}>取消</button><button className="danger-inline" onClick={() => beginUpload(pendingUpload)}>确认覆盖</button></div>}
      <fieldset className="file-controls" disabled={busy || loading}>
      <div className="file-content-layout">
      <aside ref={favoriteDrag.pane} className={`file-favorites ${favoriteDrag.dragging ? "favorite-drop-ready" : ""} ${favoriteDrag.target !== null ? "favorite-drop-active" : ""}`} onDragEnter={favoriteDrag.over} onDragOver={favoriteDrag.over} onDrop={favoriteDrag.drop} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) favoriteDrag.leave(); }} aria-label={`${paneLabel}文件夹收藏`}>
        <div className="file-favorites-scroll">
        {syncError && <p className="favorites-sync-error" role="status">{syncError}</p>}
        <div className="file-favorites-heading"><strong>★ 文件夹收藏</strong><small>{syncing ? "正在同步收藏…" : "已启用跨设备同步"}</small></div>
        <button className="favorite-current" disabled={syncing || !path || confirmedDirectory !== path || /^[A-Za-z]:\/?$/.test(path)} onClick={() => toggleFavorite(path)}>{favorites.includes(path) ? "★ 取消当前收藏" : "☆ 收藏当前目录"}</button>
        {favorites.length === 0 && <p className="favorites-empty">右键或拖入文件夹添加收藏，拖动收藏项调整顺序。</p>}
        <p className="favorites-drag-hint">拖入添加 · 拖动排序</p>
        <ul>{favorites.map((folderPath, index) => <li key={folderPath} data-favorite-index={index} draggable={!busy && !loading} onDragStart={event => favoriteDrag.start(event, folderPath)} onDragEnd={favoriteDrag.reset} className={`${path === folderPath ? "active" : ""} ${favoriteDrag.target === index ? "favorite-insert-before" : ""}`}>
          <button className="favorite-drag-handle" disabled={syncing} aria-label={`拖动排序 ${folderPath}`} title="拖动排序，也可按上下方向键" onPointerDown={event => favoriteDrag.touchStart(event, folderPath)} onPointerMove={favoriteDrag.touchMove} onPointerUp={favoriteDrag.touchEnd} onPointerCancel={favoriteDrag.cancelTouch} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); placeFolder(folderPath, event.key === "ArrowUp" ? Math.max(0, index - 1) : Math.min(favorites.length, index + 2)); } }}>⠿</button>
          <button className="favorite-open" title={folderPath} aria-label={`打开收藏 ${folderPath}`} aria-current={path === folderPath ? "location" : undefined} onClick={() => { if (!favoriteDrag.suppressClick()) requestDirectory(folderPath); }}><FileIcon name="" folder favorite /><span><strong>{folderPath.split("/").at(-1)}</strong><small>{folderPath}</small></span></button>
          <button className="favorite-remove" disabled={syncing} title="取消收藏" aria-label={`取消收藏 ${folderPath}`} onClick={() => toggleFavorite(folderPath)}>×</button>
        </li>)}</ul>
        <div className={`favorite-drop-end ${favoriteDrag.target === favorites.length ? "favorite-insert-before" : ""}`} aria-hidden="true" />
        </div>
        {favoriteDrag.dragging && <div className="favorite-drop-surface" style={{ pointerEvents: favoriteDrag.cover ? "auto" : "none" }} aria-hidden="true"><span>{favoriteDrag.target !== null ? "松开即可收藏 / 排序" : "拖到此栏任意位置"}</span></div>}
      </aside>
      <VirtualFileGrid count={visibleEntries.length} label={`${device.name} 实机文件`} resetKey={`${path}:${sortKey}:${descending}`} render={(index, tabIndex) => {
        const entry = visibleEntries[index];
        return <button data-file-index={index} aria-posinset={index + 1} aria-setsize={visibleEntries.length} tabIndex={tabIndex} className={`file-icon-item ${selectedNames.has(entry.name) ? "selected" : ""}`} type="button" role="option" aria-selected={selectedNames.has(entry.name)} key={entry.name} title={`${entry.name}\n${entry.type < 3 ? "文件夹" : `${fileKind(entry.name)[1]} · ${formatSize(entry.size)}`}\n${formatModified(entry.modified)}`} draggable={entry.type === 2 && !busy && !loading} onDragStart={event => { if (entry.type !== 2) { event.preventDefault(); return; } favoriteDrag.start(event, joinPath(path, entry.name)); }} onDragEnd={favoriteDrag.reset} onClick={(event) => { if (!favoriteDrag.suppressClick()) selectEntry(event, entry); }} onDoubleClick={() => { if (!favoriteDrag.suppressClick() && !busy && !loading) { if (entry.type < 3) requestDirectory(joinPath(pathRef.current, entry.name)); else openPreview(entry); } }} onContextMenu={(event) => openContextMenu(event, entry)} onKeyDown={(event) => openContextMenuFromKeyboard(event, entry)}>
          <span className={entry.type === 2 ? "folder-touch-drag" : ""} onPointerDown={event => { if (entry.type === 2) favoriteDrag.touchStart(event, joinPath(path, entry.name)); }} onPointerMove={favoriteDrag.touchMove} onPointerUp={favoriteDrag.touchEnd} onPointerCancel={favoriteDrag.cancelTouch}><FileIcon name={entry.name} folder={entry.type < 3} favorite={entry.type === 2 && favorites.includes(joinPath(path, entry.name))} /></span>
          <span className="entry-name">{entry.name}</span>
          <small>{entry.driveType ?? (entry.type < 3 ? "文件夹" : `${fileKind(entry.name)[1]} · ${formatSize(entry.size)}`)}</small>
        </button>;
      }} empty={!loading && confirmedDirectory === path && entries.length === 0 ? <div className="file-empty"><strong>此目录为空</strong><span>可上传文件或新建目录。</span></div> : null} />
      </div>
      {contextMenu && <div className="file-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <strong>{contextMenu.entry.name}</strong>
        {onOpenDesktop && <button role="menuitem" onClick={() => openInDesktop(contextMenu.entry.type < 3 ? joinPath(pathRef.current, contextMenu.entry.name) : pathRef.current)}>在控屏中打开所在目录</button>}
        {contextMenu.entry.type < 3 && <button role="menuitem" onClick={() => { requestDirectory(joinPath(pathRef.current, contextMenu.entry.name)); setContextMenu(null); }}>打开文件夹</button>}
        {contextMenu.entry.type === 2 && <button role="menuitem" disabled={syncing} onClick={() => { toggleFavorite(joinPath(path, contextMenu.entry.name)); setContextMenu(null); }}>{favorites.includes(joinPath(path, contextMenu.entry.name)) ? "取消收藏文件夹" : "收藏文件夹"}</button>}
        {contextMenu.entry.type >= 3 && <button role="menuitem" onClick={() => openPreview(contextMenu.entry)}>预览</button>}
        {contextMenu.entry.type >= 3 && <button role="menuitem" onClick={() => { beginDownloadEntry(contextMenu.entry); setContextMenu(null); }}>下载</button>}
        <button role="menuitem" onClick={() => { const names = selected.includes(contextMenu.entry.name) ? selected : [contextMenu.entry.name]; setCompressNames(names); setArchiveName(`${names.length === 1 ? names[0] : "压缩包"}.tar.gz`); setContextMenu(null); }}>压缩选中项（当前设备）</button>
        <button role="menuitem" onClick={() => openRenameDialog(contextMenu.entry)}>重命名</button>
        <button className="context-danger" role="menuitem" onClick={() => openDeleteDialog(contextMenu.entry)}>删除</button>
      </div>}
      </fieldset>
      {preview && <FilePreview name={preview.name} load={preview.load} onClose={closePreview} />}
      {compressing && <div className="file-message">正在当前设备压缩，请稍候…</div>}
      {compressNames && <div className="file-action-backdrop"><form className="file-action-dialog" onSubmit={event => {
        event.preventDefault(); if (!validName(archiveName) || !archiveName.endsWith(".tar.gz")) return;
        if (entries.some(entry => entry.name.toLocaleLowerCase() === archiveName.toLocaleLowerCase())) { setError("同名文件已存在，请更换压缩包名称"); return; }
        const reqid = ++requestSequence.current; compressRequest.current = reqid; setCompressing(true); setError(null); setMessage(null);
        send({action:"compress",reqid,path:pathRef.current,name:archiveName,names:compressNames}); setCompressNames(null);
        window.clearTimeout(transferTimer.current); transferTimer.current = window.setTimeout(() => { void stop("error"); },150_000);
      }}><strong>压缩选中项</strong><p>将 {compressNames.length} 项压缩为 .tar.gz，保存到 {device.name} 当前目录，不跨设备传输。支持文件和文件夹，输入总大小上限 512 MB。</p><input aria-label="压缩包名称" value={archiveName} onChange={event => setArchiveName(event.target.value)} /><div><button type="button" onClick={() => setCompressNames(null)}>取消</button><button type="submit" disabled={!validName(archiveName) || !archiveName.endsWith(".tar.gz")}>开始压缩</button></div></form></div>}
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

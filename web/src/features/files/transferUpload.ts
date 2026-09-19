export interface TransferLimits { window: number; chunkSize: number }

export function transferLimits(value: Record<string, unknown>): TransferLimits {
  if (value.window === undefined) return { window: 1, chunkSize: 64 * 1024 };
  if (!Number.isInteger(value.window) || Number(value.window) < 2 || Number(value.window) > 8 || value.chunkSize !== 256 * 1024) throw new Error("远端返回了无效传输窗口");
  return { window: Number(value.window), chunkSize: Number(value.chunkSize) };
}

// 一个异步读取器、一个有界发送窗口；最后确认到齐后才允许提交。
export function createUploadPump(size: number, read: (limit: number) => Promise<Uint8Array | null>, send: (chunk: Uint8Array) => void, commit: () => void, progress: (bytes: number) => void, active: () => boolean) {
  let limits: TransferLimits = { window: 1, chunkSize: 64 * 1024 };
  let started = false, running = false, ended = false, committed = false;
  let sent = 0, acknowledged = 0, bytes = 0;
  const pump = async () => {
    if (running || committed || !active()) return;
    running = true;
    try {
      while (active() && !ended && sent - acknowledged < limits.window) {
        const chunk = await read(limits.chunkSize);
        if (!active()) return;
        if (chunk === null) {
          if (bytes !== size) throw new Error("上传内容不完整，未提交目标文件");
          ended = true; break;
        }
        if (!chunk.length || chunk.length > 256 * 1024 || bytes + chunk.length > size) throw new Error("上传分块长度无效，未提交目标文件");
        bytes += chunk.length; sent++;
        send(chunk); progress(bytes);
      }
      if (active() && ended && acknowledged === sent && !committed) { committed = true; commit(); }
    } finally { running = false; }
  };
  return {
    start(value: Record<string, unknown>) {
      if (started) return Promise.reject(new Error("上传开始确认重复"));
      started = true; limits = transferLimits(value);
      return pump();
    },
    acknowledge(value: unknown) {
      if (!started) return Promise.reject(new Error("上传尚未开始"));
      const ack = limits.window > 1 ? value : acknowledged + 1;
      if (typeof ack !== "number" || !Number.isSafeInteger(ack) || ack < 0 || ack > sent) return Promise.reject(new Error("上传累计确认无效"));
      if (ack <= acknowledged) return Promise.resolve();
      acknowledged = ack;
      return pump();
    },
  };
}

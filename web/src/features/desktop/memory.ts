import type { MeshDesktopModule } from '../meshcentral';

// 增量图块按序解码、绘制、释放。高水位暂停采集，低水位恢复；
// 来不及施加背压时清理积压并请求完整画面，保持会话和输入连接。
export function manageDesktopMemory(module: MeshDesktopModule, canvas: HTMLCanvasElement) {
  const highBytes = 8 * 1024 * 1024;
  const maxBytes = 16 * 1024 * 1024;
  let disposed = false;
  let encodedBytes = 0;
  let decoding = false;
  let paused = false;
  let refreshing = false;
  let generation = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: { id: number; blob: Blob; x: number; y: number }[] = [];
  const pending = new Map<number, { bytes: number; bitmap?: ImageBitmap }>();
  const drain = module.DoPendingOperations?.bind(module);
  const release = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    encodedBytes -= entry.bytes;
    entry.bitmap?.close();
    pending.delete(id);
  };
  const pause = () => {
    if (paused) return;
    paused = true;
    module.SendPause?.();
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    module.SendUnPause?.();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(resumeTimer);
    module.onScreenSizeChange = null;
    module.accumulator = null;
    module.PendingOperations = [];
    queue.length = 0;
    for (const id of pending.keys()) release(id);
    // clearRect 仅清像素，不归还画布的后备存储。
    canvas.width = canvas.height = 1;
  };
  const scheduleRefresh = () => {
    if (disposed || decoding || resumeTimer !== undefined) return;
    // 合并同一批突发消息，避免坏图块导致刷新请求忙循环。
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (disposed) return;
      refreshing = false;
      resume();
      module.SendRefresh?.();
    }, 250);
  };
  const recover = () => {
    if (disposed || refreshing) return;
    refreshing = true;
    generation++;
    pause();
    queue.length = 0;
    module.PendingOperations = [];
    // 已丢弃图块不再等待绘制；旧解码结果通过代次隔离，不能污染新画面。
    module.TilesDrawn = module.tilesReceived;
    for (const id of pending.keys()) release(id);
    scheduleRefresh();
  };
  if (module.ProcessPictureMsg && drain) {
    module.DoPendingOperations = () => {
      const result = drain();
      for (const id of pending.keys()) {
        if (pending.get(id)?.bitmap && !module.PendingOperations?.some(op => op[0] === id)) release(id);
      }
      return result;
    };
    const pump = () => {
      if (disposed || decoding || refreshing) return;
      const next = queue.shift();
      if (!next) { resume(); return; }
      const { id, blob, x, y } = next;
      const epoch = generation;
      decoding = true;
      // 串行解码使位图在下一次解码前完成绘制与释放，避免乱序结果堆积。
      void Promise.resolve().then(() => disposed || epoch !== generation ? null : createImageBitmap(blob)).then(bitmap => {
        if (!bitmap) return;
        if (disposed || epoch !== generation) { bitmap.close(); return; }
        const entry = pending.get(id)!;
        entry.bitmap = bitmap;
        if (module.State !== 0 && module.KillDraw! < id) {
          module.PendingOperations!.push([id, 2, bitmap, x, y]);
        } else {
          module.PendingOperations!.push([id, 0]);
        }
        while (module.DoPendingOperations!()) { /* 按协议序号绘制。 */ }
        // 协议尺寸切换可能清空旧操作并留下序号缺口，不能继续累积位图。
        if (pending.has(id)) recover();
      }).catch(() => {
        if (!disposed && epoch === generation) recover();
      }).finally(() => {
        decoding = false;
        if (disposed) return;
        if (refreshing) { scheduleRefresh(); return; }
        if (pending.size <= 16 && encodedBytes <= 2 * 1024 * 1024) resume();
        pump();
      });
    };
    module.ProcessPictureMsg = (data, x, y) => {
      if (disposed || refreshing) return;
      const bytes = data.byteLength - 4;
      // 预算限制排队积压；单张合法大图允许独占解码，避免完整刷新反复被拒绝。
      // 64 MiB 与中继消息上限一致，不允许异常单图无限扩大。
      if (bytes <= 0 || bytes > 64 * 1024 * 1024 || pending.size >= 128 ||
          (pending.size > 0 && encodedBytes + bytes > maxBytes)) {
        recover();
        return;
      }
      const id = ++module.tilesReceived!;
      encodedBytes += bytes;
      pending.set(id, { bytes });
      // Blob 构造时已保存字节快照；普通 ArrayBuffer 无需预复制，共享缓冲仍先转成独立内存。
      const jpeg = data.subarray(4);
      const snapshot: Uint8Array<ArrayBuffer> = jpeg.buffer instanceof ArrayBuffer
        ? jpeg as Uint8Array<ArrayBuffer> : new Uint8Array(jpeg);
      queue.push({ id, blob: new Blob([snapshot], { type: 'image/jpeg' }), x, y });
      if (pending.size >= 64 || encodedBytes >= highBytes) pause();
      pump();
    };
  }
  return dispose;
}

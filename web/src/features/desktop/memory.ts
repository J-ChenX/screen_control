import type { MeshDesktopModule } from '../meshcentral';

// MeshCentral 的增量图块必须有序绘制，不能通过丢帧释放积压，否则画面会损坏。
// 超出预算或解码失败时结束连接，由用户重新连接取得完整画面。
export function manageDesktopMemory(module: MeshDesktopModule, canvas: HTMLCanvasElement, fail: (message: string) => void) {
  let disposed = false;
  let encodedBytes = 0;
  let decodedBytes = 0;
  let decoding = 0;
  const queue: { id: number; blob: Blob; x: number; y: number }[] = [];
  const pending = new Map<number, { bytes: number; bitmap?: ImageBitmap }>();
  const drain = module.DoPendingOperations?.bind(module);
  const release = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    encodedBytes -= entry.bytes;
    if (entry.bitmap) {
      decodedBytes -= entry.bitmap.width * entry.bitmap.height * 4;
      entry.bitmap.close();
    }
    pending.delete(id);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    module.onScreenSizeChange = null;
    module.accumulator = null;
    module.PendingOperations = [];
    queue.length = 0;
    for (const id of pending.keys()) release(id);
    // clearRect 仅清像素，不归还画布的后备存储。
    canvas.width = canvas.height = 1;
  };
  const abort = () => {
    if (disposed) return;
    dispose();
    fail('桌面图像解码失败或积压超过内存预算，连接已结束，请重新连接。');
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
      while (!disposed && decoding < 2 && queue.length) {
        const { id, blob, x, y } = queue.shift()!;
        decoding++;
        void createImageBitmap(blob).then(bitmap => {
          if (disposed) { bitmap.close(); return; }
          const entry = pending.get(id)!;
          entry.bitmap = bitmap;
          decodedBytes += bitmap.width * bitmap.height * 4;
          if (decodedBytes > 64 * 1024 * 1024) { abort(); return; }
          if (module.State !== 0 && module.KillDraw! < id) {
            module.PendingOperations!.push([id, 2, bitmap, x, y]);
          } else {
            module.PendingOperations!.push([id, 0]);
          }
          while (module.DoPendingOperations!()) { /* 按协议序号绘制。 */ }
        }).catch(abort).finally(() => { decoding--; pump(); });
      }
    };
    module.ProcessPictureMsg = (data, x, y) => {
      if (disposed) return;
      const bytes = data.byteLength - 4;
      if (bytes <= 0 || pending.size >= 128 || encodedBytes + bytes > 16 * 1024 * 1024) { abort(); return; }
      const id = ++module.tilesReceived!;
      encodedBytes += bytes;
      pending.set(id, { bytes });
      // 避免二进制字符串与 base64 的多份临时副本；位图在绘制/断线后显式释放。
      queue.push({ id, blob: new Blob([new Uint8Array(data.subarray(4))], { type: 'image/jpeg' }), x, y });
      pump();
    };
  }
  return dispose;
}

// 小文件暂存在内存，大文件逐块写入浏览器私有磁盘，避免按文件大小占用堆内存。
export interface DownloadArtifact {
  file: File;
  dispose: () => Promise<void>;
}

export interface DownloadStorage {
  write: (chunk: Uint8Array) => Promise<void>;
  finish: (name: string) => Promise<DownloadArtifact>;
  dispose: () => Promise<void>;
}

export async function createDownloadStorage(size: number): Promise<DownloadStorage> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("来源设备返回了无效文件大小");
  if (size <= 16 * 1024 * 1024) {
    let chunks: ArrayBuffer[] = [];
    const dispose = async () => { chunks = []; };
    return {
      async write(chunk) { chunks.push(new Uint8Array(chunk).buffer); },
      async finish(name) {
        const file = new File(chunks, name, { type: "application/octet-stream" });
        chunks = [];
        return { file, dispose };
      },
      dispose,
    };
  }
  if (!navigator.storage?.getDirectory) throw new Error("此浏览器无法暂存大文件，请通过 HTTPS 门户使用支持私有文件存储的浏览器");
  const root = await navigator.storage.getDirectory();
  const key = `screen-control-transfer-${crypto.randomUUID()}`;
  const handle = await root.getFileHandle(key, { create: true });
  let writer: FileSystemWritableFileStream;
  try { writer = await handle.createWritable(); }
  catch (error) { await root.removeEntry(key); throw error; }
  let closed = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (!closed) { await writer.abort().catch(() => undefined); closed = true; }
    await root.removeEntry(key);
  };
  return {
    async write(chunk) {
      if (disposed) throw new Error("下载已取消");
      await writer.write(new Uint8Array(chunk).buffer);
    },
    async finish(name) {
      if (disposed) throw new Error("下载已取消");
      await writer.close();
      closed = true;
      const file = new File([await handle.getFile()], name, { type: "application/octet-stream" });
      return { file, dispose };
    },
    dispose,
  };
}

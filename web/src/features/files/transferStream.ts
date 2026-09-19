export interface TransferSource {
  name: string;
  size: number;
  read: () => Promise<Uint8Array | null>;
  abort: (error: Error) => void;
  failed: Promise<never>;
}

export interface TransferPipe {
  source: TransferSource;
  accept: (chunk: Uint8Array, last: boolean) => void;
}

export function isTransferSource(file: File | TransferSource): file is TransferSource {
  return "read" in file;
}

// 未协商窗口时保持逐块拉取；协商后最多缓存一个窗口，消费才释放额度。
export function createTransferPipe(name: string, size: number, request: (first: boolean, ack?: number) => void, cancel: (error: Error) => void, window = 1): TransferPipe {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("来源设备返回了无效文件大小");
  if (!Number.isInteger(window) || window < 1 || window > 8) throw new Error("传输窗口无效");
  let pending: { resolve: (chunk: Uint8Array | null) => void; reject: (error: Error) => void } | null = null;
  const queue: (Uint8Array | null)[] = [];
  let received = 0, frames = 0, consumed = 0, granted = 0;
  let ended = false, started = false;
  let failure: Error | null = null;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failed.catch(() => undefined);
  const abort = (error: Error) => {
    if (failure) return;
    failure = error; queue.length = 0;
    pending?.reject(error); pending = null;
    rejectFailure(error); cancel(error);
  };
  const deliver = () => {
    if (!pending || !queue.length) return;
    const reader = pending; pending = null; consumed++;
    reader.resolve(queue.shift()!);
  };
  return {
    source: {
      name, size, failed, abort,
      read() {
        if (failure) return Promise.reject(failure);
        if (pending) return Promise.reject(new Error("传输不能并行读取多个数据块"));
        if (ended && !queue.length) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
          if (!ended) {
            const first = !started; started = true;
            granted = consumed + window;
            try { if (window > 1) request(first, consumed); else request(first); }
            catch (error) { abort(error instanceof Error ? error : new Error("读取来源失败")); }
          }
          deliver();
        });
      },
    },
    accept(chunk, last) {
      if (failure) return;
      if (!started || ended || frames >= granted || (window > 1 && chunk.length > 256 * 1024)) {
        abort(new Error("来源设备超出传输窗口或分块上限")); return;
      }
      received += chunk.length;
      if (received > size || (last && received !== size) || (!last && chunk.length === 0)) {
        abort(new Error("来源文件长度与声明不一致，未提交目标文件")); return;
      }
      frames++; ended = last;
      queue.push(chunk.length ? chunk : null);
      deliver();
    },
  };
}

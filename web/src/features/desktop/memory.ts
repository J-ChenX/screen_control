import type { MeshDesktopModule } from '../meshcentral';
import { DESKTOP_FRAME, desktopFrameAck, desktopMouse, parseDesktopFrame, type DesktopFrame } from './frame';
import { DesktopAdaptation, type DesktopResolution } from './quality';
import { DesktopMotion } from './motion';

// 只预读 JPEG 尺寸来预算并行解码像素；解码及格式合法性仍由浏览器检查。
function picturePixels(data: Uint8Array, fallback: number, expected?: DesktopFrame) {
  const invalid = expected ? 0 : fallback;
  if (data[4] !== 0xff || data[5] !== 0xd8) return invalid;
  let offset = 6;
  while (offset + 3 < data.length) {
    if (data[offset++] !== 0xff) return invalid;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = data[offset] * 256 + data[offset + 1];
    if (length < 2 || offset + length > data.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
      const height = data[offset + 3] * 256 + data[offset + 4];
      const width = data[offset + 5] * 256 + data[offset + 6];
      return width && height && (!expected || (width === expected.width && height === expected.height)) ? width * height : invalid;
    }
    offset += length;
  }
  return invalid;
}

type Picture = {
  id: number; blob: Blob; x: number; y: number; bytes: number; pixels: number; receivedAt: number;
  phase: 'queued' | 'decoding' | 'ready'; bitmap?: ImageBitmap; descriptor?: DesktopFrame; startedAt?: number; consumed?: boolean;
};

// 小图块有界并行解码、按协议顺序批量绘制；大图独占预算。
// 内存与等待时间共同施加背压；丢弃增量时必须请求完整画面。
export function manageDesktopMemory(module: MeshDesktopModule, canvas: HTMLCanvasElement, options?: { platform: string; smooth: boolean; resolution?: DesktopResolution }) {
  const highBytes = 8 * 1024 * 1024;
  const maxBytes = 16 * 1024 * 1024;
  const pixelBudget = 8 * 1024 * 1024;
  let disposed = false;
  let encodedBytes = 0;
  let decoding = 0;
  let ready = 0;
  let reservedPixels = 0;
  let paused = false;
  let refreshing = false;
  let generation = 0;
  let lastRefresh = -Infinity;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let latencyTimer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let flushScheduled = false;
  const queue: Picture[] = [];
  const pending = new Map<number, Picture>();
  const drain = module.DoPendingOperations?.bind(module);
  const processCommand = module.ProcessBinaryCommand?.bind(module);
  let nextDescriptor: DesktopFrame | null = null;
  let framed = false;
  let invalidDescriptor = false;
  let sourceWidth = 0, sourceHeight = 0;
  let displaySourceChanged = false;
  let captureScaling = module.ScalingLevel || 1024;
  let displaySourceSize: { width: number; height: number } | undefined;
  let presentedEpoch = 0, presentedSequence = 0, receivingEpoch = 0;
  let presentedDescriptor: DesktopFrame | null = null;
  let lastHandshake = -Infinity;
  const originalSend = module.send?.bind(module);
  let smooth = options?.smooth ?? false;
  let adaptationTimer: ReturnType<typeof setInterval> | undefined;
  const profile = (tier: 1440 | 1080 | 720 | 540) => {
    if (disposed || !options) return;
    const scaling = framed ? tier : sourceWidth && sourceHeight
      ? Math.max(64, Math.floor(Math.min(1, tier * 16 / 9 / sourceWidth, tier / sourceHeight) * 1024)) : 1024;
    if (framed) lastHandshake = performance.now();
    module.SendCompressionLevel(framed ? 129 : 1, adaptation.quality(smooth), scaling, 40);
    module.SendRefresh?.();
  };
  const adaptation = new DesktopAdaptation(profile, smooth, options?.resolution);
  const motion = new DesktopMotion();
  const age = () => pending.size ? performance.now() - pending.values().next().value!.receivedAt : 0;
  const release = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    encodedBytes -= entry.bytes;
    if (!disposed && entry.descriptor && !entry.consumed) module.send?.(desktopFrameAck(entry.descriptor, true));
    if (entry.phase === 'ready') {
      entry.bitmap?.close();
      ready--;
      reservedPixels -= entry.pixels;
    }
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
    clearTimeout(latencyTimer);
    clearInterval(adaptationTimer);
    motion.dispose();
    delete module.SetDesktopPriority;
    delete module.SetDesktopResolution;
    delete module.ResetDesktopDisplay;
    if (originalSend) module.send = originalSend;
    if (frame !== undefined) cancelAnimationFrame(frame);
    module.onScreenSizeChange = null;
    module.accumulator = null;
    module.PendingOperations = [];
    queue.length = 0;
    for (const id of pending.keys()) release(id);
    canvas.width = canvas.height = 1;
  };
  const scheduleRefresh = () => {
    if (disposed || decoding || resumeTimer !== undefined) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (disposed) return;
      refreshing = false;
      lastRefresh = performance.now();
      // 先刷新再恢复，避免继续发送已作废基线上的增量。
      module.SendRefresh?.();
      resume();
    }, Math.max(250, lastRefresh + 2000 - performance.now()));
  };
  const recover = () => {
    if (disposed || refreshing) return;
    refreshing = true;
    generation++;
    pause();
    queue.length = 0;
    module.PendingOperations = [];
    module.TilesDrawn = module.tilesReceived;
    for (const id of pending.keys()) release(id);
    scheduleRefresh();
  };
  const checkLatency = () => {
    if (disposed || refreshing || !pending.size) return;
    const waiting = age();
    if (waiting >= 150) pause();
    // 单张大图允许完成；连续增量过期时重建画面，刷新至少间隔两秒。
    if (waiting >= 750 && pending.size > 1 && reservedPixels <= pixelBudget) recover();
    if (!refreshing && latencyTimer === undefined) {
      latencyTimer = setTimeout(() => { latencyTimer = undefined; checkLatency(); }, 50);
    }
  };
  // 同尺寸显示器切换也要作废旧解码，不能只依赖尺寸消息清空画面。
  module.ResetDesktopDisplay = (sourceChanged = false, sourceSize) => {
    generation++;
    queue.length = 0;
    module.PendingOperations = [];
    module.TilesDrawn = module.tilesReceived;
    for (const id of pending.keys()) release(id);
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    if (sourceChanged) { displaySourceChanged = true; displaySourceSize = sourceSize; }
  };
  if (processCommand) module.ProcessBinaryCommand = (command, size, data) => {
    if (disposed) return;
    if (command === DESKTOP_FRAME) {
      const descriptor = parseDesktopFrame(data);
      invalidDescriptor = !descriptor; nextDescriptor = descriptor;
      if (descriptor) {
        const first = !framed;
        framed = true; receivingEpoch = descriptor.epoch; sourceWidth = descriptor.sourceWidth; sourceHeight = descriptor.sourceHeight;
        if (first || (!descriptor.feedback && performance.now() - lastHandshake >= 2000)) profile(adaptation.tier);
      }
      return;
    }
    if (command === 7 && data.length >= 8) {
      if (framed) return;
      const encodedWidth = data[4] * 256 + data[5], encodedHeight = data[6] * 256 + data[7];
      const changedDisplay = displaySourceChanged;
      if (displaySourceSize) {
        sourceWidth = displaySourceSize.width; sourceHeight = displaySourceSize.height;
        displaySourceChanged = false;
      }
      else if (changedDisplay) {
        const applied = captureScaling;
        sourceWidth = Math.ceil(encodedWidth * 1024 / applied); sourceHeight = Math.ceil(encodedHeight * 1024 / applied);
        displaySourceChanged = false;
      }
      else if (!sourceWidth) { sourceWidth = encodedWidth; sourceHeight = encodedHeight; }
      else if (encodedWidth > 2560 || encodedHeight > 1440) {
        const applied = module.ScalingLevel || 1024;
        sourceWidth = Math.ceil(encodedWidth * 1024 / applied); sourceHeight = Math.ceil(encodedHeight * 1024 / applied);
      }
      if (options && sourceWidth && sourceHeight) module.ScalingLevel = Math.max(64, Math.floor(Math.min(1, adaptation.tier * 16 / 9 / sourceWidth, adaptation.tier / sourceHeight) * 1024));
      processCommand(command, size, data);
      if (changedDisplay && options && module.ScalingLevel !== captureScaling) profile(adaptation.tier);
      return;
    }
    processCommand(command, size, data);
  };
  if (originalSend) module.send = packet => {
    if (packet.length >= 10 && packet.charCodeAt(0) === 0 && packet.charCodeAt(1) === 5 && packet.charCodeAt(4) === 1) {
      captureScaling = packet.charCodeAt(6) * 256 + packet.charCodeAt(7);
    }
    if (framed && packet.charCodeAt(0) === 0 && packet.charCodeAt(1) === 2) {
      if (!presentedDescriptor) return;
      const tagged = desktopMouse(packet, presentedDescriptor);
      if (tagged) originalSend(tagged);
      return;
    }
    originalSend(packet);
  };
  if (options) {
    module.SetDesktopPriority = value => { smooth = value; adaptation.priority(value); };
    module.SetDesktopResolution = value => adaptation.setResolution(value);
    adaptationTimer = setInterval(() => adaptation.tick(performance.now(), age()), 200);
  }
  if (module.ProcessPictureMsg && drain) {
    module.DoPendingOperations = () => {
      const operation = module.PendingOperations?.find(op => op[0] === module.TilesDrawn! + 1);
      const current = operation ? pending.get(operation[0] as number) : undefined;
      const descriptor = current?.descriptor;
      if (descriptor && operation?.[1] === 2) {
        if (descriptor.epoch !== receivingEpoch || (descriptor.epoch === presentedEpoch && descriptor.sequence <= presentedSequence)) operation[1] = 0;
        else if (current!.bitmap!.width !== descriptor.width || current!.bitmap!.height !== descriptor.height) { recover(); return false; }
        else {
          // 完整 JPEG 已解码才改变尺寸；清空和绘制在同一刷新周期内完成。
          const resized = canvas.width !== descriptor.width || canvas.height !== descriptor.height;
          if (canvas.width !== descriptor.width) canvas.width = descriptor.width;
          if (canvas.height !== descriptor.height) canvas.height = descriptor.height;
          module.ScreenWidth = module.width = descriptor.width; module.ScreenHeight = module.height = descriptor.height;
          if (resized) module.onScreenSizeChange?.(module, descriptor.width, descriptor.height, canvas);
        }
      }
      const result = drain();
      if (result && current && operation?.[1] === 2) {
        const now = performance.now();
        adaptation.observe({ queueMs: now - current.receivedAt, decodeMs: now - current.startedAt!, processingMs: descriptor?.processingMs ?? 0, ackMs: descriptor?.ackMs ?? 0, motionRatio: options ? motion.sample(canvas, now) : undefined }, now);
        if (descriptor) {
          presentedEpoch = descriptor.epoch; presentedSequence = descriptor.sequence;
          presentedDescriptor = descriptor; current.consumed = true;
          module.send?.(desktopFrameAck(descriptor));
        }
      }
      for (const [id, entry] of pending) {
        if (entry.phase === 'ready' && !module.PendingOperations?.some(op => op[0] === id)) release(id);
      }
      return result;
    };
    const flush = () => {
      flushScheduled = false;
      frame = undefined;
      if (disposed || refreshing) return;
      try {
        while (module.DoPendingOperations!()) { /* 保持重叠图块的协议顺序。 */ }
        // 正常乱序解码会等待较早图块；真正的协议序号缺口需要重建画面。
        if (ready && !pending.has(module.TilesDrawn! + 1)) { recover(); return; }
      } catch { recover(); return; }
      if (pending.size <= 16 && encodedBytes <= 2 * 1024 * 1024 && age() < 50) resume();
      pump();
    };
    const scheduleFlush = () => {
      if (flushScheduled || disposed) return;
      flushScheduled = true;
      if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush);
      else queueMicrotask(flush);
    };
    const pump = () => {
      if (disposed || refreshing) return;
      while (queue.length && decoding + ready < 4) {
        const next = queue[0];
        // 未知尺寸按完整画布预算；超过预算的单张合法图片仍可独占处理。
        if (decoding + ready > 0 && reservedPixels + next.pixels > pixelBudget) break;
        queue.shift();
        const epoch = generation;
        next.phase = 'decoding';
        next.startedAt = performance.now();
        decoding++;
        reservedPixels += next.pixels;
        void Promise.resolve().then(() => disposed || epoch !== generation ? null : createImageBitmap(next.blob)).then(bitmap => {
          if (!bitmap) return;
          if (disposed || epoch !== generation) { bitmap.close(); return; }
          next.phase = 'ready';
          next.bitmap = bitmap;
          decoding--;
          ready++;
          if (module.State !== 0 && module.KillDraw! < next.id) {
            module.PendingOperations!.push([next.id, 2, bitmap, next.x, next.y]);
          } else {
            module.PendingOperations!.push([next.id, 0]);
          }
          scheduleFlush();
        }).catch(() => {
          if (!disposed && epoch === generation) recover();
        }).finally(() => {
          if (next.phase === 'decoding') { decoding--; reservedPixels -= next.pixels; }
          if (disposed) return;
          if (refreshing) { scheduleRefresh(); return; }
          pump();
        });
      }
      checkLatency();
    };
    module.ProcessPictureMsg = (data, x, y) => {
      if (disposed || refreshing) {
        if (!disposed && nextDescriptor) module.send?.(desktopFrameAck(nextDescriptor, true));
        nextDescriptor = null; return;
      }
      if (invalidDescriptor || (framed && !nextDescriptor)) { invalidDescriptor = false; nextDescriptor = null; recover(); return; }
      const descriptor = nextDescriptor; nextDescriptor = null;
      const pixels = picturePixels(data, Math.max(1, canvas.width * canvas.height), descriptor ?? undefined);
      if (descriptor && (x !== 0 || y !== 0 || pixels === 0)) {
        module.send?.(desktopFrameAck(descriptor, true)); recover(); return;
      }
      // 独立整帧允许跳过尚未开始的旧采样；增量图块继续严格保留。
      if (descriptor) {
        for (let index = queue.length - 1; index >= 0; index--) {
          const previous = queue[index];
          if (!previous.descriptor) continue;
          queue.splice(index, 1); module.PendingOperations!.push([previous.id, 0]); release(previous.id);
        }
      }
      const bytes = data.byteLength - 4;
      if (bytes <= 0 || bytes > 64 * 1024 * 1024 || pending.size >= 128 ||
          (pending.size > 0 && encodedBytes + bytes > maxBytes)) {
        recover();
        return;
      }
      const id = ++module.tilesReceived!;
      const jpeg = data.subarray(4);
      const snapshot: Uint8Array<ArrayBuffer> = jpeg.buffer instanceof ArrayBuffer
        ? jpeg as Uint8Array<ArrayBuffer> : new Uint8Array(jpeg);
      const picture: Picture = {
        id, blob: new Blob([snapshot], { type: 'image/jpeg' }), x, y, bytes,
        pixels,
        receivedAt: performance.now(), phase: 'queued', descriptor: descriptor ?? undefined,
      };
      encodedBytes += bytes;
      pending.set(id, picture);
      queue.push(picture);
      if (pending.size >= 64 || encodedBytes >= highBytes) pause();
      pump();
    };
  }
  return dispose;
}

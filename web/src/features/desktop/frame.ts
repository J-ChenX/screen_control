// 既有桌面通道的完整帧／矩形增量；一条元数据对应紧随其后的一张 JPEG。
export const DESKTOP_FRAME = 0x7f00;
export const DESKTOP_ACK = 0x7f01;
export const DESKTOP_MOUSE = 2;
export const DESKTOP_DISCARD = 0x7f03;
export const DESKTOP_CAPABILITY = 0x7f04;
export const DESKTOP_RESET = 0x7f05;
export type DesktopTier = 1440 | 1080 | 720 | 540;
export type DesktopFrame = {
  version: 1 | 2; full: boolean; baseEpoch: number; baseSequence: number;
  x: number; y: number; patchWidth: number; patchHeight: number;
  epoch: number; sequence: number; feedback: boolean; sourceWidth: number; sourceHeight: number;
  width: number; height: number; tier: DesktopTier; quality: number; processingMs: number; ackMs: number;
};
export function parseDesktopFrame(data: Uint8Array): DesktopFrame | null {
  if (data.byteLength !== 40 && data.byteLength !== 56) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(4), flags = view.getUint16(6), full = !!(flags & 1);
  if (version !== 1 && version !== 2) return null;
  if (view.getUint16(0) !== DESKTOP_FRAME || view.getUint16(2) !== data.byteLength) return null;
  if (version === 1 ? data.byteLength !== 40 || !full || (flags & ~3) !== 0 || view.getUint32(36) !== 0
    : version !== 2 || data.byteLength !== 56 || (flags & ~7) !== 0 || full === !!(flags & 4) || view.getUint32(52) !== 0) return null;
  const frame: DesktopFrame = { version, full, baseEpoch: version === 2 ? view.getUint32(48) : 0, baseSequence: version === 2 ? view.getUint32(36) : 0,
    x: version === 2 ? view.getUint16(40) : 0, y: version === 2 ? view.getUint16(42) : 0,
    patchWidth: version === 2 ? view.getUint16(44) : view.getUint16(20), patchHeight: version === 2 ? view.getUint16(46) : view.getUint16(22),
    feedback: !!(flags & 2), epoch: view.getUint32(8), sequence: view.getUint32(12), sourceWidth: view.getUint16(16), sourceHeight: view.getUint16(18), width: view.getUint16(20), height: view.getUint16(22), tier: view.getUint16(24) as DesktopTier, quality: view.getUint16(26), processingMs: view.getUint32(28), ackMs: view.getUint32(32) };
  if (!frame.epoch || !frame.sequence || !frame.sourceWidth || !frame.sourceHeight || !frame.width || !frame.height || frame.width > 2560 || frame.height > 1440 || frame.width > frame.sourceWidth || frame.height > frame.sourceHeight || ![1440,1080,720,540].includes(frame.tier) || frame.quality < 1 || frame.quality > 100 || frame.processingMs > 60000 || frame.ackMs > 60000) return null;
  const maximumWidth = frame.tier * 16 / 9;
  const expectedWidth = frame.sourceWidth * frame.tier > frame.sourceHeight * maximumWidth
    ? Math.min(frame.sourceWidth, maximumWidth)
    : Math.max(1, Math.floor(frame.sourceWidth * Math.min(frame.sourceHeight, frame.tier) / frame.sourceHeight));
  const expectedHeight = frame.sourceWidth * frame.tier > frame.sourceHeight * maximumWidth
    ? Math.max(1, Math.floor(frame.sourceHeight * expectedWidth / frame.sourceWidth))
    : Math.min(frame.sourceHeight, frame.tier);
  if (frame.width !== expectedWidth || frame.height !== expectedHeight) return null;
  if (!frame.patchWidth || !frame.patchHeight || frame.x + frame.patchWidth > frame.width || frame.y + frame.patchHeight > frame.height) return null;
  if (full ? frame.baseEpoch !== 0 || frame.baseSequence !== 0 || frame.x !== 0 || frame.y !== 0 || frame.patchWidth !== frame.width || frame.patchHeight !== frame.height
    : frame.baseEpoch !== frame.epoch || !frame.baseSequence || frame.baseSequence >= frame.sequence) return null;
  return frame;
}
export function parseDesktopCapability(data: Uint8Array): boolean | null {
  if (data.byteLength !== 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(0) !== DESKTOP_CAPABILITY || view.getUint16(2) !== 8 || view.getUint16(4) !== 2 || (view.getUint16(6) & ~1) !== 0) return null;
  return !!(view.getUint16(6) & 1);
}
export function desktopFrameAck(frame: DesktopFrame, discarded = false) {
  const packet = new Uint8Array(12), view = new DataView(packet.buffer);
  view.setUint16(0, discarded ? DESKTOP_DISCARD : DESKTOP_ACK); view.setUint16(2, 12); view.setUint32(4, frame.epoch); view.setUint32(8, frame.sequence);
  return String.fromCharCode(...packet);
}

export function desktopMouse(packet: string, frame: DesktopFrame) {
  if ((packet.length !== 10 && packet.length !== 12) || packet.charCodeAt(0) !== 0 || packet.charCodeAt(1) !== 2) return null;
  const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
  view.setUint16(0, DESKTOP_MOUSE); view.setUint16(2, 20); view.setUint32(12, frame.epoch); view.setUint32(16, frame.sequence);
  for (let i = 0; i < 4; i++) bytes[6+i] = packet.charCodeAt(6+i);
  bytes[5] = packet.charCodeAt(5);
  if (packet.length === 12) { bytes[10] = packet.charCodeAt(10); bytes[11] = packet.charCodeAt(11); }
  return String.fromCharCode(...bytes);
}

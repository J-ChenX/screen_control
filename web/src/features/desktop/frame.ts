// 既有桌面二进制通道的整帧扩展；一条元数据对应紧随其后的一张完整 JPEG。
export const DESKTOP_FRAME = 0x7f00;
export const DESKTOP_ACK = 0x7f01;
export const DESKTOP_MOUSE = 2;
export const DESKTOP_DISCARD = 0x7f03;
export type DesktopTier = 1440 | 1080 | 720 | 540;
export type DesktopFrame = {
  epoch: number; sequence: number; feedback: boolean; sourceWidth: number; sourceHeight: number;
  width: number; height: number; tier: DesktopTier; quality: number; processingMs: number; ackMs: number;
};
export function parseDesktopFrame(data: Uint8Array): DesktopFrame | null {
  if (data.byteLength !== 40) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(0) !== DESKTOP_FRAME || view.getUint16(2) !== 40 || view.getUint16(4) !== 1 || (!(view.getUint16(6) & 1) || (view.getUint16(6) & ~3) !== 0) || view.getUint32(36) !== 0) return null;
  const frame = { feedback: !!(view.getUint16(6) & 2), epoch: view.getUint32(8), sequence: view.getUint32(12), sourceWidth: view.getUint16(16), sourceHeight: view.getUint16(18), width: view.getUint16(20), height: view.getUint16(22), tier: view.getUint16(24) as DesktopTier, quality: view.getUint16(26), processingMs: view.getUint32(28), ackMs: view.getUint32(32) };
  if (!frame.epoch || !frame.sequence || !frame.sourceWidth || !frame.sourceHeight || !frame.width || !frame.height || frame.width > 2560 || frame.height > 1440 || frame.width > frame.sourceWidth || frame.height > frame.sourceHeight || ![1440,1080,720,540].includes(frame.tier) || frame.quality < 1 || frame.quality > 100 || frame.processingMs > 60000 || frame.ackMs > 60000) return null;
  const maximumWidth = frame.tier * 16 / 9;
  const expectedWidth = frame.sourceWidth * frame.tier > frame.sourceHeight * maximumWidth
    ? Math.min(frame.sourceWidth, maximumWidth)
    : Math.max(1, Math.floor(frame.sourceWidth * Math.min(frame.sourceHeight, frame.tier) / frame.sourceHeight));
  const expectedHeight = frame.sourceWidth * frame.tier > frame.sourceHeight * maximumWidth
    ? Math.max(1, Math.floor(frame.sourceHeight * expectedWidth / frame.sourceWidth))
    : Math.min(frame.sourceHeight, frame.tier);
  if (frame.width !== expectedWidth || frame.height !== expectedHeight) return null;
  return frame;
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

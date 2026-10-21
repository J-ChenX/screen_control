import { expect, it } from 'vitest';
import { DESKTOP_CAPABILITY, DESKTOP_FRAME, parseDesktopCapability, parseDesktopFrame, desktopFrameAck } from './frame';

function framePacket(sequence = 1, tier = 1080, epoch = 2) {
  const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
  for (const [offset,value] of [[0,DESKTOP_FRAME],[2,40],[4,1],[6,3],[16,2560],[18,1440],[20,tier*16/9],[22,tier],[24,tier],[26,85]]) view.setUint16(offset,value);
  view.setUint32(8,epoch); view.setUint32(12,sequence); view.setUint32(28,12);
  return bytes;
}
it('三档完整帧只接受合法尺寸、版本和保留位', () => {
  for (const tier of [1440,1080,720,540]) {
    const bytes = framePacket(1,tier);
    expect(parseDesktopFrame(bytes)?.width).toBe(tier*16/9);
    for (let length=0;length<40;length++) expect(parseDesktopFrame(bytes.subarray(0,length))).toBeNull();
  }
  for (const [offset,value] of [[4,2],[6,7],[20,3000],[22,1800],[24,999],[26,0],[36,1]]) {
    const bytes=framePacket();new DataView(bytes.buffer).setUint16(offset,value);expect(parseDesktopFrame(bytes)).toBeNull();
  }
});
it('带偏移的元数据仍正确解析，展示确认绑定代次和真实帧序号', () => {
  const storage=new Uint8Array(50);storage.set(framePacket(42,720,5),7);
  const frame=parseDesktopFrame(storage.subarray(7,47))!;expect(frame.epoch).toBe(5);
  expect([...desktopFrameAck(frame)].map(char=>char.charCodeAt(0))).toEqual([127,1,0,12,0,0,0,5,0,0,0,42]);
});
it('鼠标消息携带当前展示帧，滚轮和按钮语义保持原值', async () => {
  const {desktopMouse}=await import('./frame');const frame=parseDesktopFrame(framePacket(42,720,5))!;
  const mouse=String.fromCharCode(0,2,0,12,0,2,2,128,1,104,255,136);
  expect([...desktopMouse(mouse,frame)!].map(c=>c.charCodeAt(0))).toEqual([0,2,0,20,0,2,2,128,1,104,255,136,0,0,0,5,0,0,0,42]);
  expect(desktopMouse(String.fromCharCode(0,1,0,6,0,65),frame)).toBeNull();
});

function rectanglePacket(full = false) {
  const bytes = new Uint8Array(56); bytes.set(framePacket(8, 720, 5));
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 56); view.setUint16(4, 2); view.setUint16(6, full ? 3 : 6);
  view.setUint32(36, full ? 0 : 7); view.setUint32(48, full ? 0 : 5);
  view.setUint16(40, full ? 0 : 16); view.setUint16(42, full ? 0 : 32);
  view.setUint16(44, full ? 1280 : 64); view.setUint16(46, full ? 720 : 48);
  return bytes;
}
it('v2完整帧与依赖矩形规范化为同一展示描述', () => {
  expect(parseDesktopFrame(rectanglePacket())).toMatchObject({ version: 2, full: false, baseEpoch: 5, baseSequence: 7, x: 16, y: 32, patchWidth: 64, patchHeight: 48 });
  expect(parseDesktopFrame(rectanglePacket(true))).toMatchObject({ version: 2, full: true, baseEpoch: 0, baseSequence: 0, patchWidth: 1280, patchHeight: 720 });
  expect(parseDesktopFrame(framePacket())).toMatchObject({ version: 1, full: true, baseEpoch: 0, baseSequence: 0, x: 0, y: 0, patchWidth: 1920, patchHeight: 1080 });
});
it('拒绝v2未知标志、越界矩形、空依赖、未来依赖及完整帧伪依赖', () => {
  for (const full of [true, false]) {
    const invalid = full ? [[6, 7], [36, 1], [48, 5], [40, 1], [42, 1], [44, 64], [46, 48]]
      : [[6, 2], [6, 7], [6, 14], [36, 0], [36, 8], [48, 0], [48, 6], [40, 1280], [42, 720], [44, 0], [46, 0]];
    for (const [offset, value] of [...invalid, [52, 1], [2, 40], [4, 1]]) {
      const bytes = rectanglePacket(full), view = new DataView(bytes.buffer);
      if ([36, 48, 52].includes(offset)) view.setUint32(offset, value); else view.setUint16(offset, value);
      expect(parseDesktopFrame(bytes), `完整=${full}, 字段=${offset}`).toBeNull();
    }
  }
  for (let length = 0; length < 56; length++) expect(parseDesktopFrame(rectanglePacket().subarray(0, length))).toBeNull();
});
it('能力仅接受确定的版本、长度和允许标志，兼容回退不可误认为未知能力', () => {
  const packet = new Uint8Array([DESKTOP_CAPABILITY >> 8, DESKTOP_CAPABILITY & 255, 0, 8, 0, 2, 0, 1]);
  expect(parseDesktopCapability(packet)).toBe(true);
  packet[7] = 0; expect(parseDesktopCapability(packet)).toBe(false);
  for (const [offset, value] of [[0, 0], [3, 7], [5, 1], [7, 2]]) {
    const invalid = packet.slice(); invalid[offset] = value; expect(parseDesktopCapability(invalid)).toBeNull();
  }
  expect(parseDesktopCapability(packet.subarray(0, 7))).toBeNull();
});

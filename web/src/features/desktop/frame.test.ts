import { expect, it } from 'vitest';
import { DESKTOP_FRAME, parseDesktopFrame, desktopFrameAck } from './frame';

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

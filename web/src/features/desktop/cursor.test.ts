import { expect, it } from 'vitest';
import { normalizeCursorCommand } from './cursor';
it('问号和未知光标回退箭头，保留原消息', () => {
  for (const id of [4,21,255]) {
    const data=new Uint8Array([0,88,0,5,id]);
    expect(normalizeCursorCommand(88,5,data)[4]).toBe(0);
    expect(data[4]).toBe(id);
  }
});
it('正常光标和其他协议消息保持不变', () => {
  for (const id of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]) {
    const data=new Uint8Array([0,88,0,5,id]);expect(normalizeCursorCommand(88,5,data)).toBe(data);
  }
  const data=new Uint8Array([0,88,0,5,4]);expect(normalizeCursorCommand(3,5,data)).toBe(data);expect(normalizeCursorCommand(88,4,data)).toBe(data);
});

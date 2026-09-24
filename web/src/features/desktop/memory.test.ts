import { afterEach, expect, it, vi } from 'vitest';
import type { MeshDesktopModule } from '../meshcentral';
import { manageDesktopMemory } from './memory';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const drawn: number[] = [];
  let last = 0;
  const module = {
    State: 3, tilesReceived: 0, KillDraw: 0, accumulator: new Uint8Array(1024),
    PendingOperations: [] as unknown[][], ProcessPictureMsg: vi.fn(),
    DoPendingOperations(this: { PendingOperations: unknown[][] }) {
      const index = this.PendingOperations.findIndex(op => op[0] === last + 1);
      if (index < 0) return false;
      const [op] = this.PendingOperations.splice(index, 1);
      last++; drawn.push(op[0] as number); return true;
    },
  } as unknown as MeshDesktopModule;
  const canvas = { width: 3840, height: 2160 } as HTMLCanvasElement;
  const fail = vi.fn();
  const dispose = manageDesktopMemory(module, canvas, fail);
  return { module, canvas, fail, dispose, drawn };
}
const picture = new Uint8Array([0,0,0,0,1,2,3]);
const bitmap = () => ({width:10,height:10,close:vi.fn()}) as unknown as ImageBitmap;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('乱序解码仍按顺序绘制，绘制完成即释放位图', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap',vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const state=setup();
  state.module.ProcessPictureMsg!(picture,0,0);state.module.ProcessPictureMsg!(picture,0,0);
  const first=bitmap(),second=bitmap();resolves[1](second);await flush();
  expect(state.drawn).toEqual([]);expect(second.close).not.toHaveBeenCalled();
  resolves[0](first);await flush();
  expect(state.drawn).toEqual([1,2]);expect(first.close).toHaveBeenCalledOnce();expect(second.close).toHaveBeenCalledOnce();
  state.dispose();expect(first.close).toHaveBeenCalledOnce();
});
it('断线释放已解码和迟到位图、积压和画布', async () => {
  const resolves: ((value:ImageBitmap)=>void)[]=[];
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>resolves.push(resolve))));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);state.module.ProcessPictureMsg!(picture,0,0);
  const first=bitmap(),second=bitmap();resolves[1](second);await flush();state.dispose();state.dispose();
  resolves[0](first);await flush();
  expect(first.close).toHaveBeenCalledOnce();expect(second.close).toHaveBeenCalledOnce();
  expect(state.module.PendingOperations).toEqual([]);expect(state.module.accumulator).toBeNull();
  expect(state.canvas.width*state.canvas.height).toBe(1);expect(state.drawn).toEqual([]);
});
it('解码失败结束连接，避免后续图块永久等候缺失序号', async () => {
  vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.reject(new Error('decode'))));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);await flush();
  expect(state.fail).toHaveBeenCalledOnce();expect(state.canvas.width).toBe(1);
});
it('压缩字节、未完成数量和解码像素预算分别生效', async () => {
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(()=>{})));
  const bytes=setup();bytes.module.ProcessPictureMsg!(new Uint8Array(16*1024*1024+5),0,0);
  expect(bytes.fail).toHaveBeenCalledOnce();expect(createImageBitmap).not.toHaveBeenCalled();
  const count=setup();for(let i=0;i<129;i++) count.module.ProcessPictureMsg!(picture,0,0);
  expect(count.fail).toHaveBeenCalledOnce();
  expect(createImageBitmap).toHaveBeenCalledTimes(2);
  const large={width:8192,height:4096,close:vi.fn()} as unknown as ImageBitmap;
  vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(large)));
  const pixels=setup();pixels.module.ProcessPictureMsg!(picture,0,0);await flush();
  expect(pixels.fail).toHaveBeenCalledOnce();expect(large.close).toHaveBeenCalledOnce();
});

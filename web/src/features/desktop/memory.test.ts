import { afterEach, expect, it, vi } from 'vitest';
import type { MeshDesktopModule } from '../meshcentral';
import { manageDesktopMemory } from './memory';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const drawn: number[] = [];
  const module = {
    State: 3, tilesReceived: 0, TilesDrawn: 0, KillDraw: 0, accumulator: new Uint8Array(1024),
    PendingOperations: [] as unknown[][], ProcessPictureMsg: vi.fn(),
    SendPause: vi.fn(), SendUnPause: vi.fn(), SendRefresh: vi.fn(),
    DoPendingOperations(this: MeshDesktopModule) {
      const index = this.PendingOperations!.findIndex(op => op[0] === this.TilesDrawn! + 1);
      if (index < 0) return false;
      const [op] = this.PendingOperations!.splice(index, 1);
      this.TilesDrawn!++;
      if (op[1] === 2) drawn.push(op[0] as number);
      if (this.TilesDrawn === this.tilesReceived && this.KillDraw! < this.TilesDrawn!) {
        this.KillDraw = this.TilesDrawn = this.tilesReceived = 0;
      }
      return true;
    },
  } as unknown as MeshDesktopModule;
  const canvas = { width: 3840, height: 2160 } as HTMLCanvasElement;
  const dispose = manageDesktopMemory(module, canvas);
  return { module, canvas, dispose, drawn };
}
const picture = new Uint8Array([0,0,0,0,1,2,3]);
const bitmap = () => ({width:10,height:10,close:vi.fn()}) as unknown as ImageBitmap;
const flush = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };

it('串行解码并按序绘制，下一块开始前释放位图', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap',vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const state=setup();
  state.module.ProcessPictureMsg!(picture,0,0); state.module.ProcessPictureMsg!(picture,0,0);
  await flush(); expect(resolves).toHaveLength(1);
  const first=bitmap(),second=bitmap(); resolves[0](first); await flush();
  expect(state.drawn).toEqual([1]); expect(first.close).toHaveBeenCalledOnce();
  expect(resolves).toHaveLength(2); resolves[1](second); await flush();
  expect(state.drawn).toEqual([1,2]); expect(second.close).toHaveBeenCalledOnce();
  state.dispose(); expect(first.close).toHaveBeenCalledOnce();
});
it('图块在输入缓冲被复用后仍保留构造时的图像字节', async () => {
  const blobs: Blob[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn((blob: Blob) => {
    blobs.push(blob);
    return Promise.resolve(bitmap());
  }));
  const state = setup();
  const input = new Uint8Array([0, 0, 0, 0, 11, 22, 33]);
  state.module.ProcessPictureMsg!(input, 0, 0);
  input.fill(99, 4);
  await flush();
  expect(blobs).toHaveLength(1);
  expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(new Uint8Array([11, 22, 33]));
  expect(state.drawn).toEqual([1]);
  state.dispose();
});
it('共享输入缓冲也生成独立的图像快照', async () => {
  const blobs: Blob[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn((blob: Blob) => {
    blobs.push(blob);
    return Promise.resolve(bitmap());
  }));
  const state = setup();
  const input = new Uint8Array(new SharedArrayBuffer(7));
  input.set([0, 0, 0, 0, 44, 55, 66]);
  state.module.ProcessPictureMsg!(input, 0, 0);
  input.fill(99, 4);
  await flush();
  expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(new Uint8Array([44, 55, 66]));
  expect(state.drawn).toEqual([1]);
  state.dispose();
});
it('结束连接释放迟到位图、积压和画布', async () => {
  let resolve!: (value: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(r=>{resolve=r;})));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);await flush();
  state.dispose();state.dispose();const late=bitmap();resolve(late);await flush();
  expect(late.close).toHaveBeenCalledOnce();expect(state.drawn).toEqual([]);
  expect(state.module.PendingOperations).toEqual([]);expect(state.module.accumulator).toBeNull();
  expect(state.canvas.width*state.canvas.height).toBe(1);
  expect(state.module.SendUnPause).not.toHaveBeenCalled();
});
it('解码失败自动刷新，保持连接和画布，后续图块继续绘制', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('createImageBitmap',vi.fn().mockRejectedValueOnce(new Error('decode')).mockImplementation(()=>Promise.resolve(bitmap())));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);await flush();
  expect(state.module.SendPause).toHaveBeenCalledOnce();expect(state.canvas.width).toBe(3840);
  await vi.advanceTimersByTimeAsync(250);
  expect(state.module.SendUnPause).toHaveBeenCalledOnce();expect(state.module.SendRefresh).toHaveBeenCalledOnce();
  state.module.ProcessPictureMsg!(picture,0,0);await flush();expect(state.drawn).toEqual([2]);
  expect(state.module.State).toBe(3);state.dispose();
});
it('高水位暂停采集，队列回落后恢复且不丢图块', async () => {
  const resolves: ((value: ImageBitmap) => void)[]=[];
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>resolves.push(resolve))));
  const state=setup();for(let i=0;i<64;i++) state.module.ProcessPictureMsg!(picture,0,0);
  expect(state.module.SendPause).toHaveBeenCalledOnce();await flush();
  for(let i=0;i<64;i++) {resolves[i](bitmap());await flush();}
  expect(state.drawn).toHaveLength(64);expect(state.module.SendUnPause).toHaveBeenCalledOnce();
  expect(state.module.SendRefresh).not.toHaveBeenCalled();state.dispose();
});
it('突发超量清理旧队列和迟到结果，合并刷新后恢复序号', async () => {
  vi.useFakeTimers();
  let resolve!: (value: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(r=>{resolve=r;})));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);await flush();
  for(let i=0;i<1000;i++) state.module.ProcessPictureMsg!(picture,0,0);
  expect(createImageBitmap).toHaveBeenCalledOnce();expect(state.module.SendPause).toHaveBeenCalledOnce();
  const late=bitmap();resolve(late);await flush();expect(late.close).toHaveBeenCalledOnce();
  expect(state.drawn).toEqual([]);await vi.advanceTimersByTimeAsync(250);
  expect(state.module.SendRefresh).toHaveBeenCalledOnce();
  state.module.ProcessPictureMsg!(picture,0,0);await flush();resolve(bitmap());await flush();
  expect(state.drawn).toEqual([129]);expect(state.canvas.width).toBe(3840);state.dispose();
});
it('压缩字节超量自动回收，停止后取消刷新定时器', async () => {
  vi.useFakeTimers();vi.stubGlobal('createImageBitmap',vi.fn());
  const state=setup();state.module.ProcessPictureMsg!(new Uint8Array(64*1024*1024+5),0,0);
  expect(createImageBitmap).not.toHaveBeenCalled();expect(state.canvas.width).toBe(3840);
  state.dispose();await vi.advanceTimersByTimeAsync(1000);
  expect(state.module.SendRefresh).not.toHaveBeenCalled();expect(state.module.SendUnPause).not.toHaveBeenCalled();
});
it('合法大位图绘制后立即释放，不因像素预算拒绝连接', async () => {
  const large={width:8192,height:4096,close:vi.fn()} as unknown as ImageBitmap;
  vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(large)));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);await flush();
  expect(state.drawn).toEqual([1]);expect(large.close).toHaveBeenCalledOnce();
  expect(state.module.SendPause).not.toHaveBeenCalled();state.dispose();
});
it('尺寸切换清空操作造成序号缺口时自动刷新而非积累位图', async () => {
  vi.useFakeTimers();vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(bitmap())));
  const state=setup();state.module.tilesReceived=2;state.module.TilesDrawn=0;
  state.module.ProcessPictureMsg!(picture,0,0);await flush();
  expect(state.module.PendingOperations).toEqual([]);await vi.advanceTimersByTimeAsync(250);
  expect(state.module.SendRefresh).toHaveBeenCalledOnce();
  state.module.ProcessPictureMsg!(picture,0,0);await flush();expect(state.drawn).toEqual([4]);state.dispose();
});
it('单张合法大压缩图允许独占处理，完成后释放并恢复采集', async () => {
  const large=bitmap();vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(large)));
  const state=setup();state.module.ProcessPictureMsg!(new Uint8Array(17*1024*1024+4),0,0);await flush();
  expect(state.drawn).toEqual([1]);expect(large.close).toHaveBeenCalledOnce();
  expect(state.module.SendPause).toHaveBeenCalledOnce();expect(state.module.SendUnPause).toHaveBeenCalledOnce();
  expect(state.module.SendRefresh).not.toHaveBeenCalled();state.dispose();
});
it('结束后不再启动尚未进入解码器的任务', async () => {
  vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(bitmap())));
  const state=setup();state.module.ProcessPictureMsg!(picture,0,0);state.dispose();await flush();
  expect(createImageBitmap).not.toHaveBeenCalled();expect(state.drawn).toEqual([]);
});
it('重复绘制两千张图块后位图归零且序号重置仍可继续', async () => {
  let live=0,peak=0;
  vi.stubGlobal('createImageBitmap',vi.fn(()=>{live++;peak=Math.max(peak,live);return Promise.resolve({width:100,height:100,close:()=>{live--;}});}));
  const state=setup();
  for(let round=0;round<100;round++) {
    for(let i=0;i<20;i++) state.module.ProcessPictureMsg!(picture,0,0);
    for(let i=0;i<20;i++) await flush();
    expect(live).toBe(0);expect(state.module.PendingOperations).toEqual([]);
  }
  expect(peak).toBe(1);expect(state.drawn).toHaveLength(2000);expect(state.module.SendRefresh).not.toHaveBeenCalled();state.dispose();
});

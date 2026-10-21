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

// 最小 SOF 头用于模拟有明确尺寸的小图块；实际 JPEG 解码由测试替身完成。
const smallPicture = new Uint8Array([0, 0, 0, 0, 255, 216, 255, 192, 0, 11, 8, 0, 32, 0, 32, 1, 1, 17, 0]);
it('同尺寸屏幕切换丢弃旧屏迟到解码，并允许新屏继续绘制', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const s = setup();
  const clear = vi.fn(); s.canvas.getContext = vi.fn(() => ({ clearRect: clear })) as unknown as HTMLCanvasElement['getContext'];
  s.module.ProcessPictureMsg!(smallPicture, 0, 0); await flush();
  s.module.ResetDesktopDisplay!(true);
  const old = bitmap(); resolves[0](old); await flush();
  expect(old.close).toHaveBeenCalledOnce(); expect(s.drawn).toEqual([]); expect(clear).toHaveBeenCalledOnce();
  s.module.ProcessPictureMsg!(smallPicture, 0, 0); await flush(); resolves[1](bitmap()); await flush();
  expect(s.drawn).toHaveLength(1); s.dispose();
});
it('切换后按代理实际缩放还原新屏尺寸，固定分辨率不沿用合并桌面宽度', () => {
  vi.useFakeTimers();
  const s = setup(); s.dispose(); s.canvas.width = 1920; s.canvas.height = 1080;
  s.canvas.getContext = vi.fn(() => ({ clearRect() {} })) as unknown as HTMLCanvasElement['getContext'];
  s.module.ProcessBinaryCommand = vi.fn(); s.module.SendCompressionLevel = vi.fn(); s.module.ScalingLevel = 512;
  const dispose = manageDesktopMemory(s.module, s.canvas, { platform: 'Windows', smooth: false });
  s.module.ResetDesktopDisplay!(true);
  s.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 7, 128, 4, 56]));
  s.module.SetDesktopResolution!(1080);
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(1, 85, 512, 40);
  dispose();
});
it('选屏还原尺寸使用已发送的缩放值，不使用尚未下发的下一档配置', async () => {
  vi.useFakeTimers();
  const s = setup(); s.dispose();
  s.canvas.getContext = vi.fn(() => ({ clearRect() {} })) as unknown as HTMLCanvasElement['getContext'];
  s.module.ProcessBinaryCommand = vi.fn(); s.module.SendCompressionLevel = vi.fn(); s.module.send = vi.fn(); s.module.ScalingLevel = 512;
  const dispose = manageDesktopMemory(s.module, s.canvas, { platform: 'Windows', smooth: false });
  s.module.ScalingLevel = 341;
  s.module.ResetDesktopDisplay!(true);
  s.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 3, 192, 2, 28]));
  s.module.ProcessPictureMsg!(picture, 0, 0); await flush();
  s.module.SetDesktopResolution!(1080);
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(1, 85, 1024, 40); dispose();
});
it('有物理尺寸时切换不从尚在途的旧缩放帧推算新屏尺寸', () => {
  vi.useFakeTimers();
  const s = setup(); s.dispose();
  s.canvas.getContext = vi.fn(() => ({ clearRect() {} })) as unknown as HTMLCanvasElement['getContext'];
  s.module.ProcessBinaryCommand = vi.fn(); s.module.SendCompressionLevel = vi.fn(); s.module.ScalingLevel = 341;
  const dispose = manageDesktopMemory(s.module, s.canvas, { platform: 'Windows', smooth: false });
  s.module.ResetDesktopDisplay!(true, { width: 3840, height: 2160 });
  s.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 3, 192, 2, 28]));
  expect(s.module.ScalingLevel).toBe(682);
  s.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 15, 0, 8, 112]));
  s.module.SetDesktopResolution!(1080);
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(1, 85, 512, 40); dispose();
});
it('实际解码队列严重过期时仍快速降档，不被防抖观察期延迟', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(() => {})));
  const state = setup(); state.dispose();
  state.canvas.width = 3840; state.canvas.height = 2160;
  state.module.ProcessBinaryCommand = vi.fn(); state.module.SendCompressionLevel = vi.fn();
  const dispose = manageDesktopMemory(state.module, state.canvas, { platform: 'Ubuntu', smooth: false });
  state.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 15, 0, 8, 112]));
  state.module.ProcessPictureMsg!(smallPicture, 0, 0); await flush();
  await vi.advanceTimersByTimeAsync(400);
  expect(state.module.SendCompressionLevel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(state.module.SendCompressionLevel).toHaveBeenCalledWith(1, 75, 256, 40);
  expect(state.module.SendPause).toHaveBeenCalledOnce();
  dispose();
});
it('四路小图块乱序完成仍按协议顺序绘制并释放', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const state = setup();
  for (let i = 0; i < 4; i++) state.module.ProcessPictureMsg!(smallPicture, i * 32, 0);
  await flush(); expect(resolves).toHaveLength(4);
  const images = Array.from({ length: 4 }, bitmap);
  resolves[2](images[2]); await flush(); expect(state.drawn).toEqual([]);
  resolves[0](images[0]); await flush(); expect(state.drawn).toEqual([1]);
  resolves[3](images[3]); await flush(); expect(state.drawn).toEqual([1]);
  resolves[1](images[1]); await flush(); expect(state.drawn).toEqual([1, 2, 3, 4]);
  for (const image of images) expect(image.close).toHaveBeenCalledOnce();
  expect(state.module.SendRefresh).not.toHaveBeenCalled(); state.dispose();
});
it('同一浏览器刷新周期批量绘制，尚未绘制的位图也占用并行预算', async () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { callbacks.push(callback); return callbacks.length; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap())));
  const state = setup();
  for (let i = 0; i < 8; i++) state.module.ProcessPictureMsg!(smallPicture, i * 32, 0);
  await flush(); expect(createImageBitmap).toHaveBeenCalledTimes(4);
  expect(state.drawn).toEqual([]); expect(callbacks).toHaveLength(1);
  callbacks[0](0); await flush(); expect(state.drawn).toEqual([1, 2, 3, 4]);
  expect(createImageBitmap).toHaveBeenCalledTimes(8);
  callbacks[1](16); await flush(); expect(state.drawn).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  state.dispose();
});
it('高压缩率的大画面仍独占像素预算，不能并行扩大解码内存', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const state = setup(); const large = smallPicture.slice();
  large[11] = 16; large[12] = 0; large[13] = 32; large[14] = 0;
  state.module.ProcessPictureMsg!(large, 0, 0); state.module.ProcessPictureMsg!(smallPicture, 0, 0);
  await flush(); expect(resolves).toHaveLength(1);
  const first = bitmap(); resolves[0](first); await flush();
  expect(first.close).toHaveBeenCalledOnce(); expect(resolves).toHaveLength(2);
  resolves[1](bitmap()); await flush(); expect(state.drawn).toEqual([1, 2]); state.dispose();
});
it('少量小图块等待过久也施加背压，过期后刷新且丢弃迟到结果', async () => {
  vi.useFakeTimers();
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const state = setup();
  state.module.ProcessPictureMsg!(smallPicture, 0, 0); state.module.ProcessPictureMsg!(smallPicture, 32, 0);
  await flush(); await vi.advanceTimersByTimeAsync(150);
  expect(state.module.SendPause).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(600); const late = [bitmap(), bitmap()];
  resolves.forEach((resolve, index) => resolve(late[index])); await flush();
  expect(state.drawn).toEqual([]); late.forEach(image => expect(image.close).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(250);
  expect(state.module.SendRefresh).toHaveBeenCalledOnce(); expect(state.module.SendUnPause).toHaveBeenCalledOnce();
  expect(vi.mocked(state.module.SendRefresh!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(state.module.SendUnPause!).mock.invocationCallOrder[0]);
  state.dispose();
});
it('关闭会话取消等待时间检查和浏览器绘制回调', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 9)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap())));
  const state = setup(); state.module.ProcessPictureMsg!(smallPicture, 0, 0); await flush(); state.dispose();
  await vi.advanceTimersByTimeAsync(2000); expect(cancelAnimationFrame).toHaveBeenCalledWith(9);
  expect(state.module.SendPause).not.toHaveBeenCalled(); expect(state.drawn).toEqual([]);
});

function framePicture(width: number,height: number) {
  const data=smallPicture.slice();data[11]=height>>8;data[12]=height&255;data[13]=width>>8;data[14]=width&255;return data;
}
function completeFrame(sequence: number, width: number, height: number, epoch = 2) {
  const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
  for (const [offset,value] of [[0,0x7f00],[2,40],[4,1],[6,3],[16,2560],[18,1440],[20,width],[22,height],[24,height],[26,85]]) view.setUint16(offset,value);
  view.setUint32(8,epoch); view.setUint32(12,sequence);
  return bytes;
}
it('分辨率选择同时应用于整帧握手和旧代理缩放，销毁后移除入口', () => {
  vi.useFakeTimers();
  for (const framed of [true, false]) {
    const state = setup(); state.dispose();
    state.module.ProcessBinaryCommand = vi.fn(); state.module.SendCompressionLevel = vi.fn();
    const dispose = manageDesktopMemory(state.module, state.canvas, { platform: 'Ubuntu', smooth: false, resolution: 720 });
    if (framed) state.module.ProcessBinaryCommand!(0x7f00, 40, completeFrame(1, 1280, 720));
    else state.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 10, 0, 5, 160]));
    for (const tier of [720, 1080, 1440] as const) {
      state.module.SetDesktopResolution!(tier);
      const scaling = framed ? tier : Math.floor(tier / 1440 * 1024);
      const quality = tier === 720 ? 80 : tier === 1080 ? 85 : 90;
      expect(state.module.SendCompressionLevel).toHaveBeenLastCalledWith(framed ? 129 : 1, quality, scaling, 40);
    }
    dispose(); expect(state.module.SetDesktopResolution).toBeUndefined();
  }
});
it('完整新尺寸解码前保持旧画面，绘制后才确认并更新输入尺寸', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>resolves.push(resolve))));
  const state = setup(); state.dispose();
  state.module.ProcessBinaryCommand = vi.fn(); const sent = vi.fn(); state.module.send = sent;
  state.canvas.width=1920;state.canvas.height=1080;
  const dispose=manageDesktopMemory(state.module,state.canvas);
  state.module.ProcessBinaryCommand!(0x7f00,40,completeFrame(1,1280,720));
  state.module.ProcessPictureMsg!(framePicture(1280,720),0,0);await flush();
  expect(state.canvas.width).toBe(1920);expect(sent).not.toHaveBeenCalled();
  const image={width:1280,height:720,close:vi.fn()} as unknown as ImageBitmap;
  resolves[0](image);await flush();
  expect(state.canvas.width).toBe(1280);expect(state.module.ScreenWidth).toBe(1280);
  expect(sent).toHaveBeenCalledOnce();expect(image.close).toHaveBeenCalledOnce();dispose();
});
it('整帧尺寸不匹配时不展示也不确认，转为完整刷新', async () => {
  vi.useFakeTimers(); vi.stubGlobal('createImageBitmap',vi.fn(()=>Promise.resolve(bitmap())));
  const state=setup();state.dispose();state.module.ProcessBinaryCommand=vi.fn();const sent=vi.fn();state.module.send=sent;
  state.canvas.width=1920;state.canvas.height=1080;
  const dispose=manageDesktopMemory(state.module,state.canvas);
  state.module.ProcessBinaryCommand!(0x7f00,40,completeFrame(1,1280,720));state.module.ProcessPictureMsg!(framePicture(1280,720),0,0);await flush();
  expect(sent.mock.calls.every(([packet])=>packet.charCodeAt(1)===3)).toBe(true);expect(state.canvas.width).toBe(1920);
  await vi.advanceTimersByTimeAsync(250);expect(state.module.SendRefresh).toHaveBeenCalledOnce();dispose();
});
it('旧代理的首次尺寸在编码前限制到2K，后续缩放通知不误当物理尺寸', () => {
  const state=setup();state.dispose();state.module.ProcessBinaryCommand=vi.fn();state.module.SendCompressionLevel=vi.fn();
  const dispose=manageDesktopMemory(state.module,state.canvas,{platform:'Windows',smooth:false});
  const resolution=(w:number,h:number)=>new Uint8Array([0,7,0,8,w>>8,w&255,h>>8,h&255]);
  state.module.ProcessBinaryCommand!(7,8,resolution(3840,2160));expect(state.module.ScalingLevel).toBe(682);
  state.module.ProcessBinaryCommand!(7,8,resolution(1920,1080));expect(state.module.ScalingLevel).toBe(682);dispose();
});
it('整帧拒绝非零原点和伪造 JPEG 尺寸，解码前释放流控窗口', async () => {
  vi.useFakeTimers();vi.stubGlobal('createImageBitmap',vi.fn());
  for (const [data,x] of [[framePicture(1280,720),10],[smallPicture,0]] as const) {
    const state=setup();state.dispose();state.module.ProcessBinaryCommand=vi.fn();const sent=vi.fn();state.module.send=sent;
    const dispose=manageDesktopMemory(state.module,state.canvas);
    state.module.ProcessBinaryCommand!(0x7f00,40,completeFrame(1,1280,720));state.module.ProcessPictureMsg!(data,x,0);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledOnce();expect(sent.mock.calls[0][0].charCodeAt(1)).toBe(3);
    dispose();
  }
});
it('旧代理桌面扩容后重新限制编码上限', () => {
  const state=setup();state.dispose();state.module.ProcessBinaryCommand=vi.fn();
  const dispose=manageDesktopMemory(state.module,state.canvas,{platform:'Windows',smooth:false});
  const resolution=(w:number,h:number)=>new Uint8Array([0,7,0,8,w>>8,w&255,h>>8,h&255]);
  state.module.ProcessBinaryCommand!(7,8,resolution(3840,2160));expect(state.module.ScalingLevel).toBe(682);
  state.module.ProcessBinaryCommand!(7,8,resolution(3840,2160));expect(state.module.ScalingLevel).toBeLessThan(682);dispose();
});
it('原生子进程重启的新代次不按数值大小判旧，旧解码结果不覆盖新画面', async () => {
  const resolves: ((value: ImageBitmap)=>void)[]=[];
  vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>resolves.push(resolve))));
  const state=setup();state.dispose();state.module.ProcessBinaryCommand=vi.fn();const sent=vi.fn();state.module.send=sent;
  state.canvas.width=1920;state.canvas.height=1080;
  const dispose=manageDesktopMemory(state.module,state.canvas);
  state.module.ProcessBinaryCommand!(0x7f00,40,completeFrame(40,1920,1080,100));
  state.module.ProcessPictureMsg!(framePicture(1920,1080),0,0);await flush();
  state.module.ProcessBinaryCommand!(0x7f00,40,completeFrame(1,1280,720,3));
  state.module.ProcessPictureMsg!(framePicture(1280,720),0,0);await flush();
  const old={width:1920,height:1080,close:vi.fn()} as unknown as ImageBitmap;
  const fresh={width:1280,height:720,close:vi.fn()} as unknown as ImageBitmap;
  resolves[1](fresh);await flush();resolves[0](old);await flush();
  expect(state.canvas.width).toBe(1280);expect(old.close).toHaveBeenCalledOnce();expect(fresh.close).toHaveBeenCalledOnce();
  const acks=sent.mock.calls.map(([packet])=>[...packet].map(c=>(c as string).charCodeAt(0))).filter(packet=>packet[0]===127&&packet[1]===1);
  expect(acks).toHaveLength(1);expect(acks[0].slice(4,8)).toEqual([0,0,0,3]);dispose();
});

function deltaFrame(sequence: number, baseSequence = sequence - 1, full = false) {
  const bytes = new Uint8Array(56); bytes.set(completeFrame(sequence, 1280, 720));
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 56); view.setUint16(4, 2); view.setUint16(6, full ? 3 : 6);
  view.setUint32(36, full ? 0 : baseSequence); view.setUint32(48, full ? 0 : 2);
  view.setUint16(40, full ? 0 : 16); view.setUint16(42, full ? 0 : 32);
  view.setUint16(44, full ? 1280 : 32); view.setUint16(46, full ? 720 : 32);
  return bytes;
}
function deltaSetup(options?: Parameters<typeof manageDesktopMemory>[2]) {
  const drawn: number[] = [], sent: number[][] = [];
  const module = {
    State: 3, tilesReceived: 0, TilesDrawn: 0, KillDraw: 0, PendingOperations: [] as unknown[][],
    ProcessPictureMsg: vi.fn(), ProcessBinaryCommand: vi.fn(), SendCompressionLevel: vi.fn(),
    SendPause: vi.fn(), SendUnPause: vi.fn(), SendRefresh: vi.fn(),
    send(packet: string) { sent.push([...packet].map(char => char.charCodeAt(0))); },
    DoPendingOperations(this: MeshDesktopModule) {
      const index = this.PendingOperations!.findIndex(op => op[0] === this.TilesDrawn! + 1);
      if (index < 0) return false;
      const [op] = this.PendingOperations!.splice(index, 1); this.TilesDrawn!++;
      if (op[1] === 2) drawn.push(op[0] as number);
      if (this.TilesDrawn === this.tilesReceived) this.KillDraw = this.TilesDrawn = this.tilesReceived = 0;
      return true;
    },
  } as unknown as MeshDesktopModule;
  const canvas = { width: 1280, height: 720, getContext: () => ({ clearRect: vi.fn() }) } as unknown as HTMLCanvasElement;
  const dispose = manageDesktopMemory(module, canvas, options);
  const receive = (metadata: Uint8Array) => {
    const view = new DataView(metadata.buffer), v2 = view.getUint16(4) === 2;
    module.ProcessBinaryCommand!(0x7f00, metadata.length, metadata);
    module.ProcessPictureMsg!(framePicture(view.getUint16(v2 ? 44 : 20), view.getUint16(v2 ? 46 : 22)), v2 ? view.getUint16(40) : 0, v2 ? view.getUint16(42) : 0);
  };
  const capability = (enabled = true) => module.ProcessBinaryCommand!(0x7f04, 8, new Uint8Array([127, 4, 0, 8, 0, 2, 0, +enabled]));
  const acknowledgements = () => sent.filter(packet => packet[0] === 127 && packet[1] === 1).map(packet => new DataView(new Uint8Array(packet).buffer).getUint32(8));
  return { module, canvas, dispose, drawn, sent, receive, capability, acknowledgements };
}
const sizedBitmap = (width = 32, height = 32) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
it('增量乱序解码仍按依赖链展示并确认，不跳过尚在排队的矩形', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const s = deltaSetup(); s.capability();
  s.receive(deltaFrame(1, 0, true));
  for (let sequence = 2; sequence <= 6; sequence++) s.receive(deltaFrame(sequence));
  await flush(); expect(resolves).toHaveLength(4);
  resolves[3](sizedBitmap()); resolves[2](sizedBitmap()); resolves[1](sizedBitmap()); await flush();
  expect(s.drawn).toEqual([]); expect(s.acknowledgements()).toEqual([]);
  resolves[0](sizedBitmap(1280, 720)); await flush(); expect(resolves).toHaveLength(6);
  resolves[5](sizedBitmap()); await flush(); expect(s.acknowledgements()).toEqual([1, 2, 3, 4]);
  resolves[4](sizedBitmap()); await flush();
  expect(s.acknowledgements()).toEqual([1, 2, 3, 4, 5, 6]); expect(s.module.SendPause).not.toHaveBeenCalled();
  s.dispose();
});
it.each(['Ubuntu', 'Windows'])('%s 能力和首个完整基准展示前不发送旧式启动参数，协商130不附带旧式刷新', async (platform) => {
  let resolve!: (value: ImageBitmap) => void;
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(r => { resolve = r; })));
  const s = deltaSetup({ platform, smooth: false });
  s.module.send!(String.fromCharCode(0, 5, 0, 10, 1, 90, 4, 0, 0, 40));
  s.module.send!(String.fromCharCode(0, 6, 0, 4)); expect(s.sent).toEqual([]);
  s.capability(); s.receive(completeFrame(1, 1280, 720)); await flush();
  expect(s.module.SendCompressionLevel).not.toHaveBeenCalled();
  resolve(sizedBitmap(1280, 720)); await flush();
  expect(s.module.SendCompressionLevel).toHaveBeenCalledExactlyOnceWith(130, 90, 1440, 40);
  expect(s.module.SendRefresh).not.toHaveBeenCalled(); expect(s.acknowledgements()).toEqual([1]);
  s.module.send!(String.fromCharCode(0, 6, 0, 4)); expect(s.sent.at(-1)).toEqual([127, 5, 0, 4]);
  s.dispose();
});
it('共享流拒绝增量后重新协商129，后续能力不能造成重复争抢', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(sizedBitmap(1280, 720))));
  const s = deltaSetup({ platform: 'Ubuntu', smooth: false }); s.capability(); s.receive(completeFrame(1, 1280, 720)); await flush();
  s.capability(false); s.receive(completeFrame(2, 1280, 720)); await flush();
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(129, 90, 1440, 40);
  s.receive(completeFrame(3, 1280, 720)); await flush(); expect(s.module.SendCompressionLevel).toHaveBeenCalledTimes(2);
  expect(s.sent.some(packet => packet[0] === 0 && packet[1] === 6)).toBe(false); s.dispose();
});
it('缺失依赖或源尺寸不匹配时保留旧画面、不确认增量，使用独立命令恢复', async () => {
  vi.useFakeTimers();
  for (const mismatch of ['sequence', 'source', 'canvas']) {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(sizedBitmap(1280, 720)).mockResolvedValue(sizedBitmap()));
    const s = deltaSetup(); s.capability(); s.receive(deltaFrame(1, 0, true)); await flush();
    const next = deltaFrame(mismatch === 'sequence' ? 3 : 2);
    if (mismatch === 'source') { const view = new DataView(next.buffer); view.setUint16(16, 3840); view.setUint16(18, 2160); }
    if (mismatch === 'canvas') s.canvas.width = 1000;
    s.receive(next); await flush(); expect(s.acknowledgements()).toEqual([1]); expect(s.drawn).toHaveLength(1);
    expect(s.module.SendPause).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(250);
    expect(s.sent.at(-1)).toEqual([127, 5, 0, 4]); expect(s.module.SendRefresh).not.toHaveBeenCalled(); s.dispose();
  }
});
it('切屏作废展示与待用元数据，增量不得画到空画布或继续发送旧标识输入', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(sizedBitmap(1280, 720)).mockResolvedValue(sizedBitmap()));
  const s = deltaSetup(); s.capability(); s.receive(deltaFrame(1, 0, true)); await flush();
  s.module.ResetDesktopDisplay!();
  const count = s.sent.length; s.module.send!(String.fromCharCode(0, 2, 0, 10, 0, 1, 0, 0, 0, 0)); expect(s.sent).toHaveLength(count);
  s.receive(deltaFrame(2)); await flush(); expect(s.acknowledgements()).toEqual([1]); expect(s.drawn).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(250);
  vi.mocked(createImageBitmap).mockResolvedValueOnce(sizedBitmap(1280, 720));
  s.receive(deltaFrame(3, 0, true)); await flush(); expect(s.acknowledgements()).toEqual([1, 3]); s.dispose();
});
it.each([2, 8, 32])('鼠标按下%i后恢复或清屏仍允许释放，完整恢复前拒绝其他鼠标操作', async button => {
  vi.useFakeTimers();
  for (const failure of ['metadata', 'decode', 'dependency', 'clear']) {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(sizedBitmap(1280, 720)).mockResolvedValue(sizedBitmap()));
    const s = deltaSetup(); s.capability(); s.receive(deltaFrame(1, 0, true)); await flush();
    const mouse = (value: number) => s.module.send!(String.fromCharCode(0, 2, 0, 10, 0, value, 0, 32, 0, 32));
    mouse(button);
    if (failure === 'metadata') s.module.ProcessPictureMsg!(framePicture(1280, 720), 0, 0);
    if (failure === 'decode') {
      vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode'));
      s.receive(deltaFrame(2)); await flush();
    }
    if (failure === 'dependency') { s.receive(deltaFrame(3)); await flush(); }
    if (failure === 'clear') s.module.ResetDesktopDisplay!();
    for (const denied of [0, 2, 8, 32, 136]) mouse(denied);
    mouse(button * 2);
    const forwarded = s.sent.filter(packet => packet[0] === 0 && packet[1] === 2);
    expect(forwarded.map(packet => packet[5])).toEqual([button, button * 2]);
    expect(forwarded.map(packet => packet.slice(12))).toEqual([[0, 0, 0, 2, 0, 0, 0, 1], [0, 0, 0, 2, 0, 0, 0, 1]]);
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(createImageBitmap).mockResolvedValueOnce(sizedBitmap(1280, 720));
    s.receive(deltaFrame(4, 0, true)); await flush(); mouse(button);
    const latest = s.sent.filter(packet => packet[0] === 0 && packet[1] === 2).at(-1)!;
    expect(latest[5]).toBe(button); expect(latest.slice(16)).toEqual([0, 0, 0, 4]);
    s.dispose();
  }
});
it('矩形JPEG预读尺寸或实际解码尺寸不符时都丢弃，不产生展示确认', async () => {
  vi.useFakeTimers();
  for (const malformedSOF of [true, false]) {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(sizedBitmap(1280, 720)).mockResolvedValue(sizedBitmap(31, 32)));
    const s = deltaSetup(); s.capability(); s.receive(deltaFrame(1, 0, true)); await flush();
    if (malformedSOF) { s.module.ProcessBinaryCommand!(0x7f00, 56, deltaFrame(2)); s.module.ProcessPictureMsg!(framePicture(33, 32), 16, 32); }
    else { s.receive(deltaFrame(2)); await flush(); }
    expect(createImageBitmap).toHaveBeenCalledTimes(malformedSOF ? 1 : 2);
    expect(s.acknowledgements()).toEqual([1]); expect(s.drawn).toHaveLength(1);
    expect(s.sent.at(-1)?.slice(0, 2)).toEqual([127, 3]); s.dispose();
  }
});
it.each(['Ubuntu', 'Windows'])('%s 无能力的旧代理首图释放当前参数，后续普通刷新仍可发送', async (platform) => {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(sizedBitmap())));
  const s = deltaSetup({ platform, smooth: false });
  s.module.SendCompressionLevel = vi.fn((type, quality, scaling, interval) => s.module.send!(String.fromCharCode(0, 5, 0, 10, type, quality, scaling >> 8, scaling & 255, interval >> 8, interval & 255)));
  s.module.SendRefresh = vi.fn(() => s.module.send!(String.fromCharCode(0, 6, 0, 4)));
  s.module.SendCompressionLevel(1, 50, 1024, 40); s.module.SendRefresh(); expect(s.sent).toEqual([]);
  s.module.ProcessBinaryCommand!(7, 8, new Uint8Array([0, 7, 0, 8, 10, 0, 5, 160]));
  s.module.SetDesktopResolution!(1080); expect(s.sent).toEqual([]);
  s.module.ProcessPictureMsg!(smallPicture, 0, 0); await flush();
  expect(s.sent).toEqual([[0, 5, 0, 10, 1, 85, 3, 0, 0, 40], [0, 6, 0, 4]]);
  s.module.SendRefresh(); expect(s.sent.at(-1)).toEqual([0, 6, 0, 4]); expect(s.drawn).toHaveLength(1); s.dispose();
});
it('完整帧接管满队列的增量后正确归还信用，不破坏后续依赖或释放', async () => {
  const resolves: ((value: ImageBitmap) => void)[] = [], images: ImageBitmap[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => resolves.push(resolve))));
  const s = deltaSetup(); s.capability(); s.receive(deltaFrame(1, 0, true));
  for (let sequence = 2; sequence <= 6; sequence++) s.receive(deltaFrame(sequence));
  await flush(); s.receive(deltaFrame(7, 0, true)); s.receive(deltaFrame(8));
  expect(s.sent.filter(packet => packet[0] === 127 && packet[1] === 3).map(packet => packet[11])).toEqual([6, 5]);
  for (let index = 0; index < 4; index++) {
    const image = sizedBitmap(index ? 32 : 1280, index ? 32 : 720); images.push(image); resolves[index](image); await flush();
  }
  const full = sizedBitmap(1280, 720), patch = sizedBitmap(); images.push(full, patch);
  resolves[5](patch); await flush(); expect(s.acknowledgements()).toEqual([1, 2, 3, 4]);
  resolves[4](full); await flush(); expect(s.acknowledgements()).toEqual([1, 2, 3, 4, 7, 8]);
  expect(s.module.SendPause).not.toHaveBeenCalled(); s.dispose();
  expect(images.every(image => vi.mocked(image.close).mock.calls.length === 1)).toBe(true);
});

it('真实展示反馈将质量和间隔分别发到协商130，静止后只补一次Q90', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(sizedBitmap(1280, 720))));
  const s = deltaSetup({ platform: 'Ubuntu', smooth: false, resolution: 1440 }); s.capability();
  for (let sequence = 1; sequence <= 26; sequence++) {
    const metadata = deltaFrame(sequence, 0, true); new DataView(metadata.buffer).setUint32(32, 260);
    s.receive(metadata); await flush();
    now += 200; await vi.advanceTimersByTimeAsync(200);
  }
  expect(s.module.SendCompressionLevel).toHaveBeenCalledWith(130, 85, 1440, 60);
  expect(s.module.SendCompressionLevel).toHaveBeenCalledWith(130, 75, 1440, 120);
  now = 10000; await vi.advanceTimersByTimeAsync(4800);
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(130, 90, 1440, 120);
  const calls = vi.mocked(s.module.SendCompressionLevel).mock.calls.length;
  now = 60000; await vi.advanceTimersByTimeAsync(50000);
  expect(s.module.SendCompressionLevel).toHaveBeenCalledTimes(calls);
  expect(s.module.SendRefresh).not.toHaveBeenCalled(); expect(s.sent.filter(packet => packet[1] === 6)).toHaveLength(0);
  s.dispose(); now += 60000; await vi.advanceTimersByTimeAsync(60000);
  expect(s.module.SendCompressionLevel).toHaveBeenCalledTimes(calls);
});

it('清屏等待完整基准或单张图片仍在解码时不按静止补高清帧', async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  const resolve: ((value: ImageBitmap) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(r => resolve.push(r))));
  const s = deltaSetup({ platform: 'Ubuntu', smooth: true, resolution: 1080 }); s.capability();
  s.receive(deltaFrame(1, 0, true)); await flush(); resolve[0](sizedBitmap(1280, 720)); await flush();
  expect(s.module.SendCompressionLevel).toHaveBeenLastCalledWith(130, 80, 1080, 40);
  now = 100; s.receive(deltaFrame(2, 0, true)); await flush();
  now = 10000; await vi.advanceTimersByTimeAsync(10000);
  expect(vi.mocked(s.module.SendCompressionLevel).mock.calls.some(call => call[1] === 90)).toBe(false);
  s.module.ResetDesktopDisplay!(); resolve[1](sizedBitmap(1280, 720)); await flush();
  now = 20000; await vi.advanceTimersByTimeAsync(10000);
  expect(vi.mocked(s.module.SendCompressionLevel).mock.calls.some(call => call[1] === 90)).toBe(false);
  s.dispose();
});

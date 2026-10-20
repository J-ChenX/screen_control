// 使用 Windows 已安装的 Edge 和独立临时配置验证真实控屏；CDP 只走子进程管道。
// 不发送远端输入、不保存画面、不锁屏。需显式提供可信入口与已登记目标。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const target = process.argv[2];
if (process.platform !== 'win32' || !origin || !['nix', 'echova', 'lerrem'].includes(target)) throw new Error('需要 Windows、可信门户与已登记 Linux 目标');
const url = new URL(origin);
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('入口必须是精确的可信 HTTP(S) origin');
const profile = await mkdtemp(join(tmpdir(), 'screen-control-render-'));
const edge = join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const child = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let counter = 0, buffer = '', session;
const pending = new Map(), errors = [], sessions = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
child.stdio[4].setEncoding('utf8');
child.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id) {
      const item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  }
});
function call(method, params = {}, sessionId = session) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('页面诊断脚本失败');
  return result.result.value;
}
async function until(expression, timeout = 30000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await evaluate(expression); if (value) return value; await sleep(100); }
  throw new Error('等待真实画面超时');
}
function instrument() {
  const p = window.renderProbe = { draws: 0, live: 0, peak: 0, refresh: 0, settings: [], sessions: [], failNext: false, delay: 0, frames: [], motionFrames: 0, mixedMotionFrames: 0 };
  const fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/api/v1/desktops') && args[1]?.method === 'POST' && response.ok) p.sessions.push((await response.clone().json()).data.desktopSessionId);
    return response;
  };
  const create = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (...args) => {
    if (p.delay) await new Promise(resolve => setTimeout(resolve, p.delay));
    if (p.failNext) { p.failNext = false; throw new Error('隔离注入解码失败'); }
    const bitmap = await create(...args); p.live++; p.peak = Math.max(p.peak, p.live);
    const close = bitmap.close.bind(bitmap); let closed = false;
    bitmap.close = () => { if (!closed) { closed = true; p.live--; } close(); }; return bitmap;
  };
  let factory;
  Object.defineProperty(window, 'CreateAgentRemoteDesktop', { configurable: true, get: () => factory, set: original => {
    factory = (...args) => {
      const module = original(...args); window.renderModule = module;
      module.GrabMouseInput = module.GrabKeyInput = module.SendMouseMsg = module.SendKeyMsgKC = module.SendStringUnicode = () => {};
      const draw = module.Canvas.drawImage.bind(module.Canvas);
      const sample=document.createElement('canvas');sample.width=30;sample.height=17;
      const sampleContext=sample.getContext('2d',{willReadFrequently:true});sampleContext.imageSmoothingEnabled=false;
      module.Canvas.drawImage = (...args) => {
        draw(...args); p.draws++;
        const scale=module.CanvasId.width/2560;
        const marker=module.Canvas.getImageData(Math.round(80*scale),Math.round(80*scale),1,1).data;
        if(marker[0]>220&&marker[1]<30&&marker[2]<30){
          sampleContext.drawImage(module.CanvasId,64*scale,64*scale,1920*scale,1080*scale,0,0,30,17);
          const pixels=sampleContext.getImageData(0,0,30,17).data;let best=Infinity;
          for(let phase=0;phase<4;phase++){
            let mismatches=0;
            for(let y=0;y<17;y++)for(let x=0;x<30;x++){
              const expected=((x+y+phase)%4)<2?96:221;
              if([0,1,2].some(c=>Math.abs(pixels[(y*30+x)*4+c]-expected)>12))mismatches++;
            }
            best=Math.min(best,mismatches);
          }
          p.motionFrames++;if(p.motionFrames>2&&best>8)p.mixedMotionFrames++;
        }
      };
      let command = module.ProcessBinaryCommand;
      Object.defineProperty(module, 'ProcessBinaryCommand', {configurable:true,get:()=>command,set:next=>{
        command=(code,size,data)=>{
          if(code===0x7f00&&data.byteLength===40){const view=new DataView(data.buffer,data.byteOffset,data.byteLength);const sequence=view.getUint32(12);if(p.frames.at(-1)?.sequence!==sequence)p.frames.push({sequence,epoch:view.getUint32(8),width:view.getUint16(20),height:view.getUint16(22),tier:view.getUint16(24),processingMs:view.getUint32(28),ackMs:view.getUint32(32)});if(p.frames.length>1000)p.frames.shift();}
          return next(code,size,data);
        };
      }});
      module.ProcessBinaryCommand=command;
      const compression = module.SendCompressionLevel.bind(module), refresh = module.SendRefresh.bind(module);
      module.SendCompressionLevel = (...args) => { const value = compression(...args); p.settings.push([module.ImageType, module.CompressionLevel, module.ScalingLevel, module.FrameRateTimer]); return value; };
      module.SendRefresh = () => { p.refresh++; return refresh(); }; return module;
    };
  } });
}
try {
  const browser = await call('Browser.getVersion', {}, null);
  const created = await call('Target.createTarget', { url: 'about:blank' }, null);
  session = (await call('Target.attachToTarget', { targetId: created.targetId, flatten: true }, null)).sessionId;
  await call('Page.enable'); await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${instrument.toString()})();` });
  await call('Page.navigate', { url: `${origin}/devices/${target}/desktop` });
  await until('window.renderModule?.State === 3 && window.renderProbe.draws > 0');
  const identity = await evaluate("fetch('/api/v1/identity/device').then(r=>r.json()).then(r=>r.data.deviceId)");
  assert.equal(identity, 'jiang-chenx');
  const initial = await evaluate('({draws:renderProbe.draws,settings:renderProbe.settings.at(-1),width:renderModule.CanvasId.width,height:renderModule.CanvasId.height})');
  assert.equal(initial.settings[0],129);assert.equal(initial.settings[3],40);
  assert.ok(await evaluate('renderProbe.frames.some(frame=>frame.width===2560&&frame.height===1440)'));
  assert.ok(initial.width<=2560&&initial.height<=1440);
  let pointerMoves=0;
  const movePointer = async (x,y) => {
    if(process.env.SCREEN_CONTROL_RENDER_POINTER!=='1')return;
    await evaluate(`(() => {const x=Math.round(${x}*renderModule.CanvasId.width/2560),y=Math.round(${y}*renderModule.CanvasId.height/1440);renderModule.send(String.fromCharCode(0,2,0,10,0,0,x>>8,x&255,y>>8,y&255));})()`);
    pointerMoves++;await sleep(150);
  };
  await movePointer(1024,640);
  for (const smooth of [true, false]) {
    const before = await evaluate('({draws:renderProbe.draws,refresh:renderProbe.refresh})');
    await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='流畅：${smooth ? '关' : '开'}').click()`);
    await until(`renderProbe.refresh>${before.refresh} && renderProbe.draws>${before.draws}`);
    const settings=await evaluate('renderProbe.settings.at(-1)');
    assert.equal(settings[0],129);assert.equal(settings[3],40);
    assert.equal(settings[1],settings[2]===1440?(smooth?85:90):settings[2]===1080?(smooth?80:85):settings[2]===720?(smooth?75:80):(smooth?70:75));
  }
  const before = await evaluate('({draws:renderProbe.draws,refresh:renderProbe.refresh})');
  await evaluate('renderProbe.failNext=true;renderModule.SendRefresh()');
  await until(`renderProbe.refresh>${before.refresh} && renderProbe.draws>${before.draws}`);
  await sleep(500);
  let adaptation;
  if (process.env.SCREEN_CONTROL_RENDER_ADAPTIVE === '1') {
    // 静止桌面也持续采样，验证多个拥塞反馈；单帧尖峰不再构成降档依据。
    await evaluate('renderProbe.delay=220;renderProbe.refreshTimer=setInterval(()=>renderModule.SendRefresh(),200);renderModule.SendRefresh()');
    await until('renderModule.CanvasId.height<1440&&renderModule.CanvasId.height>=540',20000);
    await evaluate('renderProbe.delay=650;renderModule.SendRefresh()');
    await until('renderModule.CanvasId.height===540',20000);
    await movePointer(1792,1024);
    await evaluate('renderProbe.delay=0;renderModule.SendRefresh()');
    await until('renderModule.CanvasId.height===720',20000);
    await movePointer(1536,960);
    await until('renderModule.CanvasId.height===1440',45000);
    await evaluate('clearInterval(renderProbe.refreshTimer)');
    await movePointer(1280,896);
    adaptation=await evaluate('({tiers:[...new Set(renderProbe.frames.map(frame=>frame.tier))],maxWidth:Math.max(...renderProbe.frames.map(frame=>frame.width)),maxHeight:Math.max(...renderProbe.frames.map(frame=>frame.height)),observedFrames:renderProbe.frames.length})');
    assert.ok(adaptation.tiers.includes(1440)&&adaptation.tiers.includes(1080)&&adaptation.tiers.includes(720)&&adaptation.tiers.includes(540));
    assert.ok(adaptation.maxWidth<=2560&&adaptation.maxHeight<=1440);
  }
  let fixture;
  if (process.env.SCREEN_CONTROL_RENDER_FIXTURE === '1') {
    // 仅用于操作者创建的固定位置测试窗口；不保存采样图像或原始像素。
    fixture = await until(`(() => {
      const scale=renderModule.CanvasId.width/2560;
      const width=Math.round(320*scale),height=Math.round(192*scale);
      const pixels=renderModule.Canvas.getImageData(Math.round(64*scale),Math.round(64*scale),width,height).data;
      if(pixels[0]>8 || pixels[1]<247 || pixels[2]>8) return false;
      let differing=0,sum=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const expected=x<32*scale&&y<32*scale?[0,255,0]:x>=128*scale&&x<192*scale?[0,0,0]:[255,255,255];
        for(let c=0;c<3;c++){const difference=Math.abs(pixels[(y*width+x)*4+c]-expected[c]);sum+=difference;differing+=Number(difference>8);}
      }
      return differing===0?{differingChannels:differing,meanChannelError:sum/(width*height*3),width,height}:false;
    })()`, 30000);
  }
  const result = await evaluate('({draws:renderProbe.draws,refresh:renderProbe.refresh,peakBitmaps:renderProbe.peak,state:renderModule.State,motionFrames:renderProbe.motionFrames,mixedMotionFrames:renderProbe.mixedMotionFrames,sessions:renderProbe.sessions,width:renderModule.CanvasId.width,height:renderModule.CanvasId.height})');
  result.sessions.forEach(id => sessions.add(id));
  assert.equal(result.state, 3); assert.equal(sessions.size, 1);
  if(process.env.SCREEN_CONTROL_RENDER_FIXTURE==='1'){assert.ok(result.motionFrames>=20);assert.equal(result.mixedMotionFrames,0);} assert.ok(result.peakBitmaps <= 4); assert.deepEqual(errors, []);
  await call('Page.navigate', { url: 'about:blank' });
  for (const id of sessions) {
    const response = await fetch(`${origin}/api/v1/desktops/${id}/end`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.ok(response.ok);
  }
  sessions.clear();
  console.log(JSON.stringify({ source: identity, target, browser: browser.product, initial, ...result, sessions: 1, qualitySwitches: 2, ...(adaptation ? {adaptation} : {}), ...(fixture ? { movingFixture: fixture } : {}), decodeFailureRecovered: true, ordinaryEnd: true, remoteInputSent: pointerMoves>0, pointerMoves, clicksSent:0, keysSent:0, imagePersisted: false }));
} finally {
  // 先卸载以阻止自动重连，再清理本轮会话及独立浏览器配置。
  if (session) {
    try {
      const ids = await evaluate('window.renderProbe?.sessions ?? []'); ids.forEach(id => sessions.add(id));
      await call('Page.navigate', { url: 'about:blank' });
    } catch { /* 页面已关闭时由中继断开回收。 */ }
  }
  for (const id of sessions) await fetch(`${origin}/api/v1/desktops/${id}/end`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  try { await call('Browser.close', {}, null); } catch { child.kill(); }
  if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
  if (child.exitCode === null) child.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// 被动实机测量：不注入键鼠、不保存画面、不锁屏。正常/流畅各观测 20 秒。
// 用法：SCREEN_CONTROL_CANONICAL_ORIGIN=<可信门户> mise exec -- node tests/performance/desktop-live.mjs <登记目标>
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';

const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const target = process.argv[2];
if (!origin || !['nix', 'echova', 'jiang-chenx', 'lerrem'].includes(target)) throw new Error('需要配置可信门户并指定登记设备');

function instrument() {
  const state = window.desktopProbe = { pictures: 0, prepareMs: 0, draws: 0, drawMs: 0, firstDrawAt: null, startedAt: performance.now(), longTasks: 0, longTaskMs: 0 };
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { state.longTasks++; state.longTaskMs += entry.duration; } });
  observer.observe({ type: 'longtask', buffered: false });
  let factory;
  Object.defineProperty(window, 'CreateAgentRemoteDesktop', {
    configurable: true,
    get: () => factory,
    set: original => {
      factory = (...args) => {
        const module = original(...args);
        // 本探针始终只看画面，工具栏点击也不会注入远端输入。
        module.GrabMouseInput = module.GrabKeyInput = () => {};
        module.SendMouseMsg = module.SendKeyMsgKC = module.SendStringUnicode = () => {};
        // 内存管理模块会再次赋值此方法；拦截后续赋值才能统计实际收到的 tile。
        const originalPicture = module.ProcessPictureMsg;
        let picture;
        Object.defineProperty(module, 'ProcessPictureMsg', {
          configurable: true,
          get: () => picture,
          set: next => {
            picture = typeof next === 'function' ? function (...args) {
              const start = performance.now();
              state.pictures++;
              try { return next.apply(this, args); }
              finally { state.prepareMs += performance.now() - start; }
            } : next;
          },
        });
        module.ProcessPictureMsg = originalPicture;
        // 直接包装 Canvas 绘制，计时只覆盖同步绘制调用，不冒充解码耗时。
        const canvas = module.Canvas;
        if (canvas?.drawImage) {
          const draw = canvas.drawImage.bind(canvas);
          canvas.drawImage = (...args) => { const start = performance.now(); const value = draw(...args); state.draws++; state.drawMs += performance.now() - start; state.firstDrawAt ??= performance.now(); return value; };
        }
        return module;
      };
    },
  });
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const sessions = new Set();
let page;
let stage = 'identity';
try {
  const identity = await context.request.get(origin + '/api/v1/identity/device');
  if (!identity.ok()) throw new Error(`来源身份不可用，HTTP ${identity.status()}`);
  if ((await identity.json()).data.deviceId === target) throw new Error('选择了当前设备');
  await context.addInitScript(instrument);
  page = await context.newPage();
  let bytes = 0, frames = 0;
  page.on('websocket', socket => socket.on('framereceived', event => { frames++; bytes += typeof event.payload === 'string' ? Buffer.byteLength(event.payload) : event.payload.length; }));
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/v1/desktops' && response.request().method() === 'POST' && response.ok()) {
      const body = await response.json(); sessions.add(body.data.desktopSessionId);
    }
  });
  const started = performance.now();
  stage = 'navigation';
  await page.goto(origin + `/devices/${target}/desktop`);
  stage = 'connection';
  await expect(page.getByRole('status', { name: '实机桌面已连接', exact: true })).toBeVisible({ timeout: 30000 });
  const connectedMs = performance.now() - started;
  for (const smooth of [false, true]) {
    stage = smooth ? 'smooth' : 'normal';
    if (smooth) await page.getByRole('button', { name: '流畅：关', exact: true }).click();
    await page.waitForTimeout(2000);
    const before = await page.evaluate(() => ({ ...window.desktopProbe }));
    if (!smooth) console.log(JSON.stringify({ target, phase: 'initial-connection', scenario: 'passive-uncontrolled-screen', connectedMs: Math.round(connectedMs), firstDrawMs: before.firstDrawAt === null ? null : Math.round(before.firstDrawAt - before.startedAt), bytes, websocketFrames: frames, pictureTiles: before.pictures, draws: before.draws, picturePrepareMs: Math.round(before.prepareMs), synchronousDrawMs: Math.round(before.drawMs), sessions: sessions.size }));
    const byteStart = bytes, frameStart = frames, begin = performance.now();
    await page.waitForTimeout(20000);
    const after = await page.evaluate(() => ({ ...window.desktopProbe, width: document.querySelector('canvas')?.width, height: document.querySelector('canvas')?.height }));
    const durationMs = performance.now() - begin;
    console.log(JSON.stringify({ target, mode: smooth ? 'smooth' : 'normal', scenario: 'passive-uncontrolled-screen', connectedMs: Math.round(connectedMs), firstDrawMs: after.firstDrawAt === null ? null : Math.round(after.firstDrawAt - after.startedAt), durationMs: Math.round(durationMs), width: after.width, height: after.height, bytes: bytes - byteStart, websocketFrames: frames - frameStart, pictureTiles: after.pictures - before.pictures, draws: after.draws - before.draws, picturePrepareMs: Math.round(after.prepareMs - before.prepareMs), synchronousDrawMs: Math.round(after.drawMs - before.drawMs), longTasks: after.longTasks - before.longTasks, longTaskMs: Math.round(after.longTaskMs - before.longTaskMs), sessions: sessions.size }));
  }
  for (const id of sessions) {
    const ended = await context.request.post(origin + `/api/v1/desktops/${id}/end`, { data: {}, headers: { Origin: origin } });
    if (!ended.ok()) throw new Error(`会话结束失败，HTTP ${ended.status()}`);
  }
  sessions.clear();
  console.log(JSON.stringify({ target, explicitSessionEnded: true }));
} catch (error) {
  console.error('实机桌面探针未完成：' + stage + ' ' + error.name + ' ' + String(error.message).replace(/https?:\/\/[^\s)]+/g, '<门户>').slice(0, 220));
  process.exitCode = 1;
} finally {
  // 先卸载界面取消自动重连，再以普通结束接口清理本探针拥有的会话。
  await page?.goto('about:blank').catch(() => {});
  for (const id of sessions) await context.request.post(origin + `/api/v1/desktops/${id}/end`, { data: {}, headers: { Origin: origin } }).catch(() => {});
  await context.close(); await browser.close();
}

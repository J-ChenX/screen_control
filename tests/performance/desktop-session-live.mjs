// 实机会话生命周期检查：暂停、恢复和一次 Ctrl 按下/释放；不输入文字、点击或保存画面。
import assert from 'node:assert/strict';
import { launchBrowser, expect } from '../support/browser.mjs';

const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const target = process.argv[2];
if (!origin || !['nix', 'echova', 'jiang-chenx', 'lerrem'].includes(target)) throw new Error('此输入冒烟仅用于已登记 Ubuntu 或 Windows 目标');
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const sessions = new Set();
const page = await context.newPage();
try {
  const identity = await context.request.get(origin + '/api/v1/identity/device');
  assert.ok(identity.ok());
  assert.notEqual((await identity.json()).data.deviceId, target);
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/v1/desktops' && response.request().method() === 'POST' && response.ok()) {
      sessions.add((await response.json()).data.desktopSessionId);
    }
  });
  await page.addInitScript(() => {
    window.lifecycleProbe = { module: null, draws: 0 };
    let factory;
    Object.defineProperty(window, 'CreateAgentRemoteDesktop', {
      configurable: true, get: () => factory,
      set: original => { factory = (...args) => {
        const module = original(...args);
        module.GrabMouseInput = module.GrabKeyInput = () => {};
        const draw = module.Canvas.drawImage.bind(module.Canvas);
        module.Canvas.drawImage = (...values) => { const result = draw(...values); window.lifecycleProbe.draws++; return result; };
        window.lifecycleProbe.module = module;
        return module;
      }; },
    });
  });
  await page.goto(origin + `/devices/${target}/desktop`);
  await expect(page.getByRole('status', { name: '实机桌面已连接', exact: true })).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => window.lifecycleProbe.draws > 0);
  await page.waitForTimeout(3000);
  // 先排空已在途的图块，再用刷新请求证明暂停有效，静态桌面不能冒充通过。
  await page.evaluate(() => window.lifecycleProbe.module.SendPause());
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 20 && stable < 3; attempt++) {
    await page.waitForTimeout(500);
    const current = await page.evaluate(() => window.lifecycleProbe.draws);
    stable = current === previous ? stable + 1 : 0;
    previous = current;
  }
  assert.ok(stable >= 3, '暂停后图块未在期限内排空');
  const paused = await page.evaluate(() => window.lifecycleProbe.draws);
  await page.evaluate(() => window.lifecycleProbe.module.SendRefresh());
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.lifecycleProbe.draws), paused);
  await page.evaluate(() => {
    window.lifecycleProbe.module.SendUnPause();
    window.lifecycleProbe.module.SendRefresh();
  });
  await page.waitForFunction(previous => window.lifecycleProbe.draws > previous, paused, { timeout: 15000 });
  const input = await page.evaluate(() => {
    const module = window.lifecycleProbe.module;
    const send = module.send;
    let packets = 0;
    module.send = function (...args) { packets++; return send.apply(this, args); };
    try {
      try { module.SendKeyMsgKC(module.KeyAction.DOWN, 17); }
      finally { module.SendKeyMsgKC(module.KeyAction.UP, 17); }
    } finally { module.send = send; }
    const previous = window.lifecycleProbe.draws;
    module.SendRefresh();
    return { packets, previous };
  });
  assert.equal(input.packets, 2);
  await page.waitForFunction(previous => window.lifecycleProbe.draws > previous, input.previous, { timeout: 15000 });
  // 先卸载页面防止自动重连，再普通结束；本检查没有锁屏操作。
  await page.goto('about:blank');
  assert.ok(sessions.size > 0, '必须取得本轮会话 ID 才能核对普通结束');
  for (const id of sessions) {
    assert.ok((await context.request.post(origin + `/api/v1/desktops/${id}/end`, { data: {}, headers: { Origin: origin } })).ok());
  }
  sessions.clear();
  console.log(JSON.stringify({ target, pauseResume: 'passed', controlPacketsSent: input.packets,
    freshFrameAfterInput: true, ordinaryEnd: 'passed', inputApplicationAcknowledged: false }));
} catch (error) {
  console.error('生命周期检查失败：' + String(error.message).replace(/https?:\/\/[^\s)]+/g, '<门户>').slice(0, 240));
  process.exitCode = 1;
} finally {
  await page.goto('about:blank').catch(() => {});
  for (const id of sessions) await context.request.post(origin + `/api/v1/desktops/${id}/end`, { data: {}, headers: { Origin: origin } }).catch(() => {});
  await context.close();
  await browser.close();
}

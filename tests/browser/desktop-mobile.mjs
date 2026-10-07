// 隔离验证沉浸全屏、双指查看、单指控屏与缩放后的坐标，不连接真实电脑。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';
const browser = await launchBrowser();
const base = testOrigin();
function protocol() {
  window.mouseMessages = [];
  window.remoteKeys = [];
  window.CreateAgentRemoteDesktop = canvas => ({
    protocol: 2, KeyAction: { NONE: 0, DOWN: 1, UP: 2, SCROLL: 3 },
    GrabMouseInput() {}, UnGrabMouseInput() {},
    GrabKeyInput() { document.onkeydown = event => window.remoteKeys.push(event.key); document.onkeyup = event => window.remoteKeys.push(event.key); },
    UnGrabKeyInput() { document.onkeydown = null; document.onkeyup = null; },
    SendMouseMsg(action, event) {
      // 与现有协议相同：按 CSS 实际尺寸和 offsetParent 链计算远端坐标。
      let left = 0, top = 0, element = canvas;
      while (element) { left += element.offsetLeft; top += element.offsetTop; element = element.offsetParent; }
      window.mouseMessages.push({ action, x: (event.pageX - left) * canvas.width / canvas.clientWidth, y: (event.pageY - top) * canvas.height / canvas.clientHeight });
    },
  });
  window.CreateAgentRedirect = (_, module) => {
    const redirect = { m: module, Start() { setTimeout(() => {
      const canvas = document.querySelector('canvas');
      module.onScreenSizeChange(module, 1920, 1080, canvas);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#17363d'; ctx.fillRect(0, 0, 1920, 1080);
      ctx.strokeStyle = '#48716c';
      for (let x = 0; x < 1920; x += 120) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1080); ctx.stroke(); }
      for (let y = 0; y < 1080; y += 120) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1920, y); ctx.stroke(); }
      ctx.fillStyle = '#e0ebea'; ctx.font = '48px sans-serif'; ctx.fillText('隔离测试画面 · 1920 × 1080', 80, 160);
      redirect.onStateChanged(redirect, 3);
    }, 0); }, Stop() {} };
    return redirect;
  };
}
try {
  for (const [width, height, touch, fallback] of [[375, 812, true, false], [812, 375, true, false], [1440, 900, false, false], [320, 700, true, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    if (fallback) await context.addInitScript(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('测试原生全屏不可用')); });
    const errors = [], ended = [];
    await context.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: `(${protocol.toString()})();` });
      let data = {};
      if (path.endsWith('/identity/device')) data = { deviceId: 'xiaomi-15' };
      if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: ['echova', 'nix'].map(id => ({ id, name: id, platform: 'Ubuntu', role: '测试设备', state: 'online', nodeId: id, pathLabel: '测试', observedAt: '测试' })) };
      if (path.endsWith('/desktops')) data = { desktopSessionId: 'test', tunnelId: 'test', nodeId: 'echova', relayPath: '/test', state: 'connecting' };
      if (path.endsWith('/end') || path.endsWith('/lock-exit')) ended.push(path);
      return route.fulfill({ json: { apiVersion: 'v1', data } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/devices/echova/desktop');
    await expect(page.getByRole('status', { name: '实机桌面已连接' })).toBeVisible();
    await page.getByRole('button', { name: '进入全屏', exact: true }).click();
    await expect(page.getByRole('button', { name: '工具', exact: true })).toBeVisible();
    await expect(page.locator('.desktop-commandbar')).toBeHidden();
    await expect(page.locator('.mobile-input-toolbar')).toBeHidden();
    const viewport = page.locator('.mesh-canvas-wrap');
    await expect.poll(async () => Math.round((await viewport.boundingBox()).height)).toBe(height);
    assert.equal(Math.round((await viewport.boundingBox()).width), width);
    const canvas = page.locator('canvas');
    const fittedWidth = (await canvas.boundingBox()).width;
    if (touch) {
      const cdp = await context.newCDPSession(page);
      const centerY = height / 2;
      const points = (a, b) => [{ x: a, y: centerY, id: 1 }, { x: b, y: centerY, id: 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(width / 2 - 40, width / 2 + 40) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(width / 2 - 80, width / 2 + 80) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await canvas.boundingBox()).width).toBeGreaterThan(fittedWidth * 1.8);
      assert.deepEqual(await page.evaluate(() => window.mouseMessages), []);
      const rect = await canvas.boundingBox();
      const x = width / 2 - 20, y = height / 2 + 10;
      await page.touchscreen.tap(x, y);
      const messages = await page.evaluate(() => window.mouseMessages);
      assert.deepEqual(messages.map(message => message.action), [1, 2]);
      assert.ok(Math.abs(messages[1].x - (x - rect.x) * 1920 / rect.width) < 6);
      assert.ok(Math.abs(messages[1].y - (y - rect.y) * 1080 / rect.height) < 6);
    }
    await page.getByRole('button', { name: '工具', exact: true }).click();
    await expect(page.getByRole('button', { name: '文件传输', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /适应 ·/ }).click();
    await expect(page.getByRole('button', { name: '适应 · 100%', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '放大画面', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
    await expect(page.getByRole('button', { name: '适应 · 150%', exact: true })).toBeVisible();
    if (touch) {
      await page.getByRole('button', { name: '移画面：关', exact: true }).click();
      await page.getByRole('button', { name: '向左查看', exact: true }).click();
      await page.getByRole('button', { name: '向右查看', exact: true }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: screenshotPath(`desktop-tools-${width}x${height}.png`) });
    await page.getByRole('button', { name: '收起工具', exact: true }).click();
    await page.screenshot({ path: screenshotPath(`desktop-immersive-${width}x${height}.png`) });
    if (fallback) {
      await page.setViewportSize({ width: height, height: width });
      await expect.poll(async () => Math.round((await viewport.boundingBox()).height)).toBe(width);
      const rotatedFit = Math.round(Math.min(height / 1920, width / 1080) * 1920);
      await expect.poll(async () => (await canvas.boundingBox()).width).toBeCloseTo(rotatedFit * 1.5, 0);
      await page.setViewportSize({ width, height });
    }
    await page.getByRole('button', { name: '工具', exact: true }).click();
    await page.getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect(page.locator('.desktop-commandbar')).toBeVisible();
    assert.deepEqual(ended, []);
    assert.deepEqual(errors, []);
    console.log(`通过：${width}×${height} 全屏画面填满视口、工具收展、缩放与输入${fallback ? '、原生全屏失败回退' : ''}`);
    await context.close();
  }
} finally { await browser.close(); }

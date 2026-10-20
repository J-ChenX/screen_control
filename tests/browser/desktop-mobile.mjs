// 隔离验证沉浸全屏、双指查看、单指控屏与缩放后的坐标，不连接真实电脑。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';
const browser = await launchBrowser();
const base = testOrigin();
function protocol() {
  window.mouseMessages = [];
  window.remoteKeys = [];
  window.compressionMessages = [];
  window.CreateAgentRemoteDesktop = canvas => ({
    protocol: 2, KeyAction: { NONE: 0, DOWN: 1, UP: 2, SCROLL: 3 },
    GrabMouseInput() {
      canvas.onmousedown = event => this.SendMouseMsg(1, event);
      canvas.onmouseup = event => this.SendMouseMsg(2, event);
      canvas.onmousemove = event => this.SendMouseMsg(0, event);
    },
    UnGrabMouseInput() { canvas.onmousedown = canvas.onmouseup = canvas.onmousemove = null; },
    SendCompressionLevel(...settings) { window.compressionMessages.push(settings); }, SendRefresh() {},
    ProcessBinaryCommand() {},
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
      module.ProcessBinaryCommand(7, 8, new Uint8Array([0, 7, 0, 8, 15, 0, 8, 112]));
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
    const slider = page.getByRole('slider', { name: '画面缩放比例', exact: true });
    await expect(slider).toHaveValue(touch ? '200' : '100');
    const resolution = page.getByRole('combobox', { name: '分辨率', exact: true });
    await expect(resolution).toHaveValue('auto');
    assert.deepEqual(await resolution.locator('option').allTextContents(), ['自动', '1440P', '1080P', '720P']);
    for (const [value, scaling, quality] of [['1440', 682, 90], ['1080', 512, 85], ['720', 341, 80], ['auto', 682, 90]]) {
      await resolution.selectOption(value);
      assert.deepEqual(await page.evaluate(() => window.compressionMessages.at(-1)), [1, quality, scaling, 40]);
    }
    await resolution.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
    await page.getByRole('button', { name: '适应', exact: true }).click();
    await expect(slider).toHaveValue('100');
    await page.getByRole('button', { name: '放大画面', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
    await expect(slider).toHaveValue('150');
    const sliderRect = await slider.boundingBox();
    if (touch) await page.touchscreen.tap(sliderRect.x + sliderRect.width * .3, sliderRect.y + sliderRect.height / 2);
    else {
      await page.mouse.move(sliderRect.x + 8, sliderRect.y + sliderRect.height / 2);
      await page.mouse.down(); await page.mouse.move(sliderRect.x + sliderRect.width * .3, sliderRect.y + sliderRect.height / 2, { steps: 8 }); await page.mouse.up();
    }
    await expect.poll(() => slider.inputValue()).not.toBe('150');
    const ratio = Number(await slider.inputValue()) / 100;
    await expect.poll(async () => (await canvas.boundingBox()).width).toBeCloseTo(fittedWidth * ratio, 0);
    await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveValue('101');
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('800');
    await expect(page.getByRole('button', { name: '放大画面', exact: true })).toBeDisabled();
    assert.deepEqual(await page.evaluate(() => window.remoteKeys), []);
    await slider.fill('150');
    await expect(slider).toHaveAttribute('aria-valuetext', '150%');
    await page.getByRole('button', { name: '移画面：关', exact: true }).click();
    await page.getByRole('button', { name: '向左查看', exact: true }).click();
    await page.getByRole('button', { name: '向右查看', exact: true }).click();
    if (touch && width > height) {
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() => { window.mouseMessages = []; });
      const before = await canvas.boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: width / 2, y: height / 2, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: width / 2 + 50, y: height / 2, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.ok((await canvas.boundingBox()).x > before.x + 40);
      assert.deepEqual(await page.evaluate(() => window.mouseMessages), []);
    }
    if (!touch) {
      // 先将指针移入画布，再清空历史，检查移动模式没有远端鼠标消息。
      await page.mouse.move(width / 2, height / 2);
      await page.evaluate(() => { window.mouseMessages = []; });
      const before = await canvas.boundingBox();
      await page.mouse.down(); await page.mouse.move(width / 2 + 80, height / 2, { steps: 5 }); await page.mouse.up();
      const after = await canvas.boundingBox();
      assert.ok(after.x > before.x + 60);
      await page.mouse.wheel(0, 80);
      assert.deepEqual(await page.evaluate(() => window.mouseMessages), []);
      await page.getByRole('button', { name: '移画面：开', exact: true }).click();
      await page.mouse.click(width / 2, height / 2);
      const messages = await page.evaluate(() => window.mouseMessages);
      assert.deepEqual(messages.filter(message => message.action !== 0).map(message => message.action), [1, 2]);
      const rect = await canvas.boundingBox();
      assert.ok(Math.abs(messages.at(-1).x - (width / 2 - rect.x) * 1920 / rect.width) < 6);
      await page.getByRole('button', { name: '移画面：关', exact: true }).click();
    }
    await page.getByRole('button', { name: '缩小画面', exact: true }).click();
    await expect(page.getByRole('button', { name: '移画面：关', exact: true })).toBeDisabled();
    await expect(page.getByRole('group', { name: '移动画面', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '放大画面', exact: true }).click();
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
    console.log(`通过：${width}×${height} 分辨率切换、全屏、缩放、移动与输入${fallback ? '、原生全屏失败回退' : ''}`);
    await context.close();
  }
} finally { await browser.close(); }

// 隔离验证 Windows 单屏选择、确认与桌面／手机布局，不连接真实目标。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';
const browser = await launchBrowser(), base = testOrigin();
function protocol() {
  window.displaySelections = []; window.remoteInputs = []; window.displayModules = [];
  window.CreateAgentRemoteDesktop = canvas => {
    const module = {
      protocol: 2, KeyAction: { NONE: 0, DOWN: 1, UP: 2, SCROLL: 3 },
      GrabMouseInput() {}, UnGrabMouseInput() {}, GrabKeyInput() {}, UnGrabKeyInput() {},
      SendMouseMsg(...args) { window.remoteInputs.push(args); }, SendKeyMsgKC(...args) { window.remoteInputs.push(args); }, SendStringUnicode(...args) { window.remoteInputs.push(args); },
      ProcessBinaryCommand() {}, ProcessPictureMsg() {}, SendCompressionLevel() {}, SendRefresh() {},
      GetDisplayNumbers() { module.onDisplayinfo?.(module, { '1': 'Display 1', '2': 'Display 2', '65535': 'All Displays' }, 65535); },
      SetDisplay(id) {
        window.displaySelections.push(id);
        window.confirmDisplay = () => {
          module.onScreenSizeChange(module, 1920, 1080, canvas);
          module.onDisplayinfo?.(module, { '1': 'Display 1', '2': 'Display 2', '65535': 'All Displays' }, id);
        };
        if (!window.holdDisplayChanges) setTimeout(window.confirmDisplay, 20);
      },
    };
    window.displayModules.push(module); return module;
  };
  window.CreateAgentRedirect = (_, module) => {
    const redirect = { m: module, Start() { setTimeout(() => redirect.onStateChanged(redirect, 3), 0); }, Stop() {} };
    window.displayRedirect = redirect; return redirect;
  };
}
try {
  for (const [width, height, touch] of [[1440, 900, false], [390, 844, true], [844, 390, true], [320, 700, true]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch });
    const errors = [], ended = [];
    await context.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: `(${protocol.toString()})();` });
      let data = {};
      if (path.endsWith('/identity/device')) data = { deviceId: 'lerrem' };
      if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: [{ id: 'jiang-chenx', name: 'Windows', platform: 'Windows', role: '测试设备', state: 'online', nodeId: 'test', pathLabel: '测试', observedAt: '测试' }] };
      if (path.endsWith('/desktops')) data = { desktopSessionId: 'test-desktop', tunnelId: 'test', nodeId: 'test', relayPath: '/test', state: 'connecting' };
      if (path.endsWith('/end')) ended.push(path);
      return route.fulfill({ json: { apiVersion: 'v1', data } });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/devices/jiang-chenx/desktop');
    await expect(page.getByRole('status', { name: '实机桌面已连接' })).toBeVisible();
    if (await page.getByRole('button', { name: '工具', exact: true }).count()) await page.getByRole('button', { name: '工具', exact: true }).click();
    const select = page.getByRole('combobox', { name: '屏幕', exact: true });
    await expect(select).toHaveValue('1'); await expect(select).toBeEnabled();
    assert.deepEqual(await select.locator('option').allTextContents(), ['屏幕 1', '屏幕 2']);
    assert.deepEqual(await page.evaluate(() => displaySelections), [1]);
    await page.evaluate(() => { window.holdDisplayChanges = true; });
    await select.selectOption('2'); await expect(select).toBeDisabled(); await expect(page.locator('canvas')).toBeHidden();
    await page.evaluate(() => { displayModules.at(-1).SendMouseMsg(1, { pageX: 20, pageY: 20 }); displayModules.at(-1).SendKeyMsgKC(1, 65); });
    assert.deepEqual(await page.evaluate(() => remoteInputs), []);
    await page.evaluate(() => confirmDisplay());
    await expect(select).toBeEnabled(); await expect(select).toHaveValue('2'); await expect(page.locator('canvas')).toBeVisible();
    await select.focus(); await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => remoteInputs), []);
    const rect = await select.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (touch) {
      await page.getByRole('button', { name: '进入全屏', exact: true }).click();
      await page.getByRole('button', { name: '工具', exact: true }).click();
      await expect(select).toBeVisible();
      const fullscreenRect = await select.boundingBox(); assert.ok(fullscreenRect.x >= 0 && fullscreenRect.x + fullscreenRect.width <= width);
    }
    await page.screenshot({ path: screenshotPath(`screen-control-displays-${width}.png`) });
    await page.evaluate(() => { window.holdDisplayChanges = false; displayRedirect.onStateChanged(displayRedirect, 0); });
    await expect.poll(() => page.evaluate(() => displayModules.length)).toBe(2);
    await expect(select).toHaveValue('2'); await expect(select).toBeEnabled();
    assert.deepEqual(await page.evaluate(() => displaySelections), [1, 2, 2]);
    assert.deepEqual(errors, []);
    await page.goto(base + '/'); await expect.poll(() => ended.length).toBeGreaterThan(0);
    console.log(`通过：${width}×${height} 单屏选择、切换确认与重连恢复`);
    await context.close();
  }
  console.log('PASS: Windows 默认单屏、切换确认、输入隔离、重连恢复与四种桌面／手机布局。');
} finally { await browser.close(); }

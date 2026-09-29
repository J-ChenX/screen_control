// 隔离检查目录分页、过期响应、大目录有界渲染和键盘/手机操作。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';

function protocol() {
  window.directoryTest = { requests: [], modules: {}, legacy: false, hold: false };
  window.CreateAgentRedirect = (_, module) => {
    let device;
    const redirect = {
      m: module,
      Start(id) { device = id; window.directoryTest.modules[id] = module; setTimeout(() => redirect.onStateChanged(redirect, 3), 0); },
      Stop() {},
      sendText(command) {
        if (command.action !== 'ls') return;
        const test = window.directoryTest;
        test.requests.push({ device, ...command });
        if (test.hold) return;
        const total = device === 'echova' ? 20000 : 0;
        const begin = test.legacy ? 0 : command.page * 256;
        const end = test.legacy ? Math.min(5, total) : Math.min(total, begin + 256);
        const dir = Array.from({ length: end - begin }, (_, i) => ({ n: `file-${String(begin + i).padStart(5, '0')}.txt`, t: 3, s: 1 }));
        setTimeout(() => module.ProcessData(JSON.stringify({ path: command.path, reqid: command.reqid, dir, folderTransfer: true, ...(test.legacy ? {} : { page: command.page, more: end < total }) })), 1);
      },
    };
    return redirect;
  };
}
const base = testOrigin();
const browser = await launchBrowser();
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: { Accept: '*/*' } });
    await context.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: path.endsWith('agent-redir.js') ? `(${protocol.toString()})();` : '' });
      let data = {};
      if (path.endsWith('/identity/device')) data = { deviceId: 'nix' };
      if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: ['echova', 'nix'].map(id => ({ id, name: id, platform: 'Ubuntu', role: '测试', state: 'online', nodeId: id, pathLabel: '测试', observedAt: '测试' })) };
      if (path.includes('/files/favorites/')) data = { paths: [] };
      if (path.endsWith('/files/sessions')) { const id = route.request().postDataJSON().targetDeviceId; data = { fileSessionId: id, tunnelId: id, nodeId: id, relayPath: '/test' }; }
      return route.fulfill({ json: { apiVersion: 'v1', data } });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/devices/echova/files');
    const pane = page.locator('.file-browser').first();
    const grid = pane.getByRole('listbox');
    await expect(grid.getByRole('option').first()).toHaveAttribute('aria-setsize', '20000');
    assert.ok(await grid.getByRole('option').count() < 200);
    await grid.getByRole('option').first().click();
    await page.keyboard.press('End');
    await expect(grid.locator('[data-file-index="19999"]')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(grid.locator('[data-file-index="0"]')).toBeFocused();
    await grid.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    await expect.poll(() => grid.getByRole('option').first().getAttribute('data-file-index')).not.toBe('0');
    assert.ok(await grid.getByRole('option').count() < 200);
    assert.equal(await grid.locator('[tabindex="0"]').count(), 1);
    await page.evaluate(() => {
      const test = window.directoryTest;
      const request = test.requests.find(item => item.device === 'echova');
      test.modules.echova.ProcessData(JSON.stringify({ path: request.path, reqid: -1, dir: [{ n: '过期数据', t: 3 }] }));
    });
    await expect(grid.getByRole('option').first()).toHaveAttribute('aria-setsize', '20000');
    await page.screenshot({ path: screenshotPath(`screen-control-directory-${width}.png`) });
    await page.evaluate(() => { window.directoryTest.legacy = true; });
    await pane.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(grid.getByRole('option')).toHaveCount(5);
    await page.clock.install();
    await page.evaluate(() => { window.directoryTest.hold = true; });
    await pane.getByRole('button', { name: '刷新', exact: true }).click();
    await page.clock.fastForward(16000);
    await expect(pane.getByText('目录读取超时，请重新打开目录；未自动重试。', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: 2 万项分页、有界 DOM、键盘跳转、旧端兼容、过期回复和超时，桌面及手机。');
} finally { await browser.close(); }

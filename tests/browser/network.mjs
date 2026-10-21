// 隔离验证直连测试的手动触发、异步结果、失败提示与桌面/手机布局。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';
const browser = await launchBrowser();
const base = testOrigin();
const ids = ['echova', 'nix', 'jiang-chenx', 'lerrem'];
const results = ids.flatMap(source => ids.filter(target => target !== source).map(target => ({ source, target, path: 'internet', ipVersion: 6, rttMs: 12.4, initialRelay: false, responses: 5, attempts: 5 })));
results[0] = { ...results[0], path: 'lan', ipVersion: 4, rttMs: 2 };
results[1] = { ...results[1], path: 'derp', ipVersion: undefined };
results[3] = { ...results[3], path: 'timeout', ipVersion: undefined, rttMs: undefined, responses: 0 };
results[4] = { ...results[4], path: 'unavailable', ipVersion: undefined, rttMs: undefined, responses: 0, attempts: 0 };
results[5] = { ...results[5], initialRelay: true };
results[6] = { ...results[6], path: 'derp', ipVersion: undefined };
results[7] = { ...results[7], ipVersion: 4 };
results[8] = { ...results[8], ipVersion: undefined };
results[9] = { ...results[9], path: 'derp', ipVersion: undefined };
results[11] = { ...results[11], path: 'lan', ipVersion: 6 };
try {
  for (const [width, height] of [[1440, 1050], [390, 844], [320, 740]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
    const page = await context.newPage();
    let posts = 0, polls = 0, fail = false;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data = {};
      if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: '' });
      if (path.endsWith('/identity/device')) data = { deviceId: 'jiang-chenx' };
      if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: ids.map(id => ({ id, name: id === 'jiang-chenx' ? 'Jiang_ChenX' : id, platform: id === 'jiang-chenx' ? 'Windows' : 'Ubuntu', state: 'online', role: id === 'lerrem' ? '常驻服务端' : '开发机', nodeId: id, observedAt: '刚刚' })) };
      if (path.endsWith('/network/tests')) {
        if (route.request().method() === 'POST') {
          posts++;
          assert.deepEqual(route.request().postDataJSON(), {});
          if (fail) return route.fulfill({ status: 503, json: { apiVersion: 'v1', error: { code: 'NETWORK_TEST_UNAVAILABLE', message: '直连测试暂不可用' } } });
          data = { state: 'running', startedAt: new Date().toISOString(), results: results.map(r => ({ ...r, path: 'pending', rttMs: undefined })) };
        } else if (posts) {
          polls++;
          data = polls < 2 ? { state: 'running', results: results.map(r => ({ ...r, path: 'pending', rttMs: undefined })) } : { state: 'complete', completedAt: new Date(Date.now() - 61_000).toISOString(), results };
        } else data = { state: 'idle', results: [] };
      }
      await route.fulfill({ json: { apiVersion: 'v1', data } });
    });
    await page.goto(base);
    const panel = page.getByRole('region', { name: '直连测试', exact: true });
    const start = panel.getByRole('button', { name: '开始测试', exact: true });
    await expect(start).toBeEnabled();
    assert.equal(posts, 0, '打开主页不应触发探测');
    const box = await start.boundingBox();
    await start.hover();
    assert.deepEqual(await start.boundingBox(), box, '悬停不能移动或缩放按钮');
    await start.click();
    await expect(panel.getByRole('button', { name: '正在检测…' })).toBeDisabled();
    await expect(panel.getByText('2 组直连', { exact: true })).toBeVisible();
    await expect(panel.getByText('1 组中继', { exact: true })).toBeVisible();
    await expect(panel.getByText('1 组直连与中继不一致', { exact: true })).toBeVisible();
    await expect(panel.getByText('2 组未确认', { exact: true })).toBeVisible();
    await expect(panel.getByText('结果可能已过期，请重新测试')).toBeVisible();
    await expect(panel.getByText('仅检测 Tailscale 路径', { exact: false })).toBeVisible();
    assert.equal(posts, 1, '轮询不得重复发起测试');
    const resultArea = panel.locator('.network-pairs');
    assert.equal(await resultArea.locator('.network-pair-row').count(), 6, '每两台电脑只显示一组，不重复反向连接');
    assert.equal(await resultArea.locator('.network-detail-row').count(), 0, '所有诊断详情默认收起');
    const keys = await resultArea.locator('.network-pair-row > th').allTextContents();
    assert.equal(new Set(keys).size, 6);
    const relayPair = resultArea.locator('.network-pair-row').nth(1);
    await expect(relayPair.getByText('DERP 中继', { exact: true })).toBeVisible();
    const detailsToggle = relayPair.getByRole('button');
    await detailsToggle.focus();
    await page.keyboard.press('Enter');
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    for (const row of await resultArea.locator('.network-pair-row').all()) {
      const toggle = row.getByRole('button');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      assert.equal(await resultArea.locator('.network-detail-row').count(), 1, '一次只展开一组详情');
    }
    await expect(resultArea.getByText('IP 协议版本未确认，请重新测试')).toBeVisible();
    await resultArea.locator('.network-detail-toggle[aria-expanded="true"]').click();
    for (const label of ['局域网 IPv4 直连', '局域网 IPv6 直连', '公网 IPv4 直连', '公网 IPv6 直连', '未验证', '超时']) await expect(resultArea.getByText(label, { exact: true }).first()).toBeVisible();
    if (width > 800) {
      const bounds = await panel.boundingBox();
      assert.ok(bounds.height < 520, `六组连接的桌面面板应紧凑，实际高度 ${bounds.height}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '窄屏不得横向溢出');
    await panel.screenshot({ path: screenshotPath(`network-${width}.png`) });
    await panel.getByRole('button', { name: '收起结果' }).click();
    await expect(panel.getByText('仅检测 Tailscale 路径', { exact: false })).toBeHidden();
    fail = true;
    await panel.getByRole('button', { name: '重新测试' }).click();
    await expect(panel.getByRole('alert')).toContainText('直连测试暂不可用');
    await expect(panel.getByText('2 组直连', { exact: true })).toBeVisible();
    assert.equal(posts, 2);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser.close(); }

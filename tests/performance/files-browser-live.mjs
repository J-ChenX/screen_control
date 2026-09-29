// 真实门户端到端验证；仅向调用方预先创建的专用临时目录写入确定性测试文件。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const fixtures = JSON.parse(process.env.SCREEN_CONTROL_PERF_FIXTURES ?? '{}');
for (const id of ['echova', 'nix', 'jiang-chenx']) assert.ok(fixtures[id]?.replaceAll('\\', '/').split('/').at(-1)?.startsWith('screen-control-perf-'));
assert.ok(origin);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let stage = '连接';
try {
  for (const target of ['nix', 'jiang-chenx']) {
    const context = await browser.newContext({ viewport: { width: target === 'nix' ? 1440 : 390, height: 1000 } });
    const sessions = new Set(); const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    page.on('response', async response => {
      if (new URL(response.url()).pathname === '/api/v1/files/sessions' && response.request().method() === 'POST' && response.ok()) sessions.add((await response.json()).data.fileSessionId);
    });
    try {
      const identity = await context.request.get(origin + '/api/v1/identity/device'); assert.equal((await identity.json()).data.deviceId, 'echova');
      await page.goto(origin + `/devices/${target}/files`);
      const panes = [page.locator('.file-browser').nth(0), page.locator('.file-browser').nth(1)];
      for (let i = 0; i < 2; i++) {
        stage = '隔离目录导航';
        const pane = panes[i], label = i ? '设备 B' : '设备 A';
        await expect(pane.getByRole('textbox', { name: label + '地址' })).toBeVisible({ timeout: 20000 });
        await pane.getByRole('textbox', { name: label + '地址' }).fill(fixtures[i ? 'echova' : target].replaceAll('\\', '/'));
        await pane.getByRole('button', { name: '转到', exact: true }).click();
        await expect(pane.locator('.file-entry-count')).toContainText(/60[2-9] 项/, { timeout: 20000 });
        assert.ok(await pane.getByRole('option').count() < 200);
      }
      stage = '浏览器上传';
      const content = Buffer.alloc(8 * 1024 * 1024); for (let i = 0; i < content.length; i++) content[i] = (i + target.length) % 251;
      const name = `000-browser-proof-${target}.bin`, expected = hash(content);
      const sourceItem = panes[0].getByRole('option', { name: new RegExp('^' + name.replaceAll('.', '\\.')) });
      const uploadStart = performance.now();
      await panes[0].locator('input[type=file]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: content });
      await expect(sourceItem).toBeVisible({ timeout: 30000 });
      const uploadMs = performance.now() - uploadStart;
      await sourceItem.click();
      stage = '设备间流式复制';
      const copyStart = performance.now();
      await page.getByRole('button', { name: /发送到 echova/ }).click();
      await expect(page.getByText('已将 1 个项目复制到 echova', { exact: true })).toBeVisible({ timeout: 30000 });
      assert.equal(hash(await readFile(fixtures.echova + '/' + name)), expected);
      const copyMs = performance.now() - copyStart;
      stage = '浏览器下载';
      await sourceItem.click({ button: 'right' });
      const received = page.waitForEvent('download');
      await panes[0].getByRole('menuitem', { name: '下载', exact: true }).click();
      const download = await received; assert.equal(await download.failure(), null);
      assert.equal(hash(await readFile(await download.path())), expected); await download.delete();
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ target, width: target === 'nix' ? 1440 : 390, bytes: content.length, uploadMs: Math.round(uploadMs), copyMs: Math.round(copyMs), sourceUploadAndDownloadSHA256: true, crossDeviceSHA256: true, virtualDirectoryDOMBounded: true, pageErrors: 0 }));
    } finally {
      await page.goto('about:blank').catch(() => {});
      for (const id of sessions) await context.request.post(origin + `/api/v1/files/sessions/${id}/end`, { data: {}, headers: { Origin: origin } }).catch(() => {});
      await context.close();
    }
  }
} catch (error) { console.error('真实浏览器验证未完成：' + stage + ' ' + error.name); process.exitCode = 1; }
finally { await browser.close(); }

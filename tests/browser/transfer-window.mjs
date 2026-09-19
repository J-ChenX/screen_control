// 传输流水专项：所有设备与正文隔离模拟，不连接或修改真实设备。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';

function protocol() {
  const test = window.transferTest = { modern: ['echova', 'nix'], size: 17 * 1024 * 1024, received: 0, complete: false, maxOutstanding: 0, badBytes: 0, fail: false, cancel: 0 };
  window.CreateAgentRedirect = (_, module) => {
    let device, download, upload;
    const emit = data => setTimeout(() => module.ProcessData(JSON.stringify(data)), 1);
    const fill = () => {
      while (!download.done && download.sent - download.ack < download.window) {
        const count = Math.min(download.chunk, test.size - download.offset);
        const header = download.window > 1 ? 12 : 4;
        const frame = new Uint8Array(count + header); frame[0] = 1;
        if (header === 12) new DataView(frame.buffer).setBigUint64(4, BigInt(download.id));
        for (let i = 0; i < count; i++) frame[i + header] = (download.offset + i) % 251;
        download.offset += count; download.sent++;
        download.done = count < download.chunk; frame[3] = download.done ? 1 : 0;
        setTimeout(() => module.ProcessBinaryData(frame), 1);
      }
    };
    const redirect = {
      m: module,
      Start(id) { device = id; setTimeout(() => redirect.onStateChanged(redirect, 3), 0); },
      Stop() { if (download) download.done = true; },
      sendText(command) {
        const modern = test.modern.includes(device);
        if (command.action === 'ls') emit({ path: command.path, reqid: command.reqid, folderTransfer: true, dir: device === 'echova' ? [{ n: 'payload.bin', t: 3, s: test.size }] : [] });
        if (command.action === 'download' && command.sub === 'start') {
          download = { id: command.id, window: modern ? 8 : 1, chunk: modern ? 262144 : 16380, offset: 0, sent: 0, ack: 0, done: false };
          emit({ action: 'download', sub: 'start', id: command.id, size: test.size, ...(modern ? { window: 8, chunkSize: 262144 } : {}) });
        }
        if (command.action === 'download' && ['startack', 'ack'].includes(command.sub)) {
          if (test.stale && modern && command.sub === 'startack') {
            const stale = new Uint8Array(13); stale[0] = 1; stale[3] = 1; stale[12] = 255;
            new DataView(stale.buffer).setBigUint64(4, BigInt(command.id - 1));
            module.ProcessBinaryData(stale);
          }
          download.ack = modern ? (command.ack ?? 0) : download.sent;
          fill();
        }
        if (command.action === 'download' && command.sub === 'stop') { test.cancel++; download.done = true; }
        if (command.action === 'upload') {
          upload = { id: command.reqid, modern, chunks: 0, acknowledged: 0, bytes: 0 };
          emit({ action: 'uploadstart', reqid: command.reqid, ...(modern ? { window: 8, chunkSize: 262144 } : {}) });
        }
        if (command.action === 'uploaddone') {
          if (upload.bytes !== test.size || upload.acknowledged !== upload.chunks) throw new Error('目标未完整确认即提交');
          test.complete = true; emit({ action: 'uploaddone', reqid: command.reqid });
        }
      },
      send(bytes) {
        if (bytes[0] === 0) bytes = bytes.subarray(1);
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== (upload.bytes + i) % 251) test.badBytes++;
        upload.bytes += bytes.length; test.received = upload.bytes;
        const ack = ++upload.chunks;
        test.maxOutstanding = Math.max(test.maxOutstanding, upload.chunks - upload.acknowledged);
        if (test.maxOutstanding > (upload.modern ? 8 : 1)) throw new Error('发送超过窗口');
        setTimeout(() => {
          if (test.fail) { module.ProcessData(JSON.stringify({ action: 'uploaderror', reqid: upload.id, message: '隔离目标写入失败' })); return; }
          upload.acknowledged = ack;
          module.ProcessData(JSON.stringify({ action: 'uploadack', reqid: upload.id, ...(upload.modern ? { ack } : {}) }));
        }, 5);
      },
    };
    return redirect;
  };
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  for (const mode of ['modern', 'old-source', 'old-target', 'empty', 'fail', 'stale', 'disk']) {
    const context = await browser.newContext({ viewport: { width: mode === 'old-target' ? 390 : 1440, height: 1000 }, extraHTTPHeaders: { Accept: '*/*' } });
    if (mode !== 'disk') await context.addInitScript(() => Object.defineProperty(navigator, 'storage', { get() { throw new Error('设备间复制不能使用 OPFS'); } }));
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
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto((process.argv[2] || 'http://127.0.0.1:4175') + '/devices/echova/files');
    const left = page.locator('.file-browser').first();
    await expect(left.getByRole('option', { name: /payload.bin/ })).toBeVisible();
    await page.evaluate(mode => {
      const test = window.transferTest;
      if (mode === 'old-source') test.modern = ['nix'];
      if (mode === 'old-target') test.modern = ['echova'];
      if (mode === 'empty') test.size = 0;
      if (mode === 'fail') test.fail = true;
      if (mode === 'stale') test.stale = true;
    }, mode);
    await left.getByRole('button', { name: '刷新', exact: true }).click();
    await left.getByRole('option', { name: /payload.bin/ }).click();
    if (mode === 'disk') {
      await left.getByRole('option', { name: /payload.bin/ }).click({ button: 'right' });
      const pending = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: '下载', exact: true }).click();
      const download = await pending;
      const data = await readFile(await download.path());
      const expected = Buffer.alloc(17 * 1024 * 1024);
      for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
      assert.equal(createHash('sha256').update(data).digest('hex'), createHash('sha256').update(expected).digest('hex'));
      assert.deepEqual(errors, []); console.log('PASS: disk，17 MiB 窗口下载与 OPFS 串行落盘哈希');
      await context.close(); continue;
    }
    await page.getByRole('button', { name: /发送到 nix/ }).click();
    if (mode === 'fail') {
      await expect(page.getByText(/隔离目标写入失败/).first()).toBeVisible();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.transferTest.complete), false);
      assert.ok(await page.evaluate(() => window.transferTest.cancel) > 0);
    } else {
      await expect.poll(() => page.evaluate(() => window.transferTest.complete), { timeout: 30000 }).toBe(true);
      const result = await page.evaluate(() => window.transferTest);
      assert.equal(result.received, result.size); assert.equal(result.badBytes, 0);
      if (mode === 'modern') assert.ok(result.maxOutstanding > 1);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: ${mode}`);
    await context.close();
  }
} finally { await browser.close(); }

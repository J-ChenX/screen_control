// 经当前真实门户验证本机普通用户文件通道；只写调用方创建的隔离目录。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, expect } from '../support/browser.mjs';

const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const directory = process.env.SCREEN_CONTROL_PERF_DIRECTORY;
const width = Number(process.env.SCREEN_CONTROL_PERF_VIEWPORT ?? 1440);
const sizeMiB = Number(process.env.SCREEN_CONTROL_PERF_MIB ?? 8);
const emulateSecureContext = process.env.SCREEN_CONTROL_PERF_SECURE_CONTEXT === '1';
assert.ok(origin && directory?.replaceAll('\\', '/').split('/').at(-1)?.startsWith('screen-control-perf-'));
assert.ok(width === 1440 || width === 390);
assert.ok(Number.isInteger(sizeMiB) && sizeMiB >= 1 && sizeMiB <= 128);
if (emulateSecureContext) assert.equal(new URL(origin).protocol, 'http:');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await launchBrowser({ args: [...(emulateSecureContext ? [`--unsafely-treat-insecure-origin-as-secure=${origin}`] : [])] });
const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const sourceDirectory = await mkdtemp(join(tmpdir(), 'screen-control-perf-source-'));
const sessions = new Set();
const errors = [];
page.on('pageerror', error => errors.push(error.name));
page.on('response', async response => {
  if (new URL(response.url()).pathname === '/api/v1/files/sessions' && response.request().method() === 'POST' && response.ok()) {
    sessions.add((await response.json()).data.fileSessionId);
  }
});
let stage = '连接';
try {
  const identity = await context.request.get(origin + '/api/v1/identity/device');
  assert.equal((await identity.json()).data.deviceId, 'echova');
  await page.goto(origin + '/devices/echova/files');
  const browserStorage = await page.evaluate(() => ({ secure: isSecureContext, opfs: Boolean(navigator.storage?.getDirectory) }));
  if (sizeMiB > 16) assert.deepEqual(browserStorage, { secure: true, opfs: true });
  const pane = page.locator('.file-browser').filter({ has: page.locator('.live-files') }).first();
  stage = '隔离目录导航';
  await expect(pane.locator('.file-pane-eyebrow')).toContainText('当前设备', { timeout: 20000 });
  const address = pane.locator('input[aria-label$="地址"]');
  await expect(address).toBeVisible({ timeout: 5000 });
  await address.fill(directory);
  await pane.getByRole('button', { name: '转到', exact: true }).click();
  await expect(pane.locator('.file-entry-count')).toBeVisible({ timeout: 20000 });
  stage = '浏览器上传';
  const content = Buffer.alloc(sizeMiB * 1024 * 1024);
  for (let i = 0; i < content.length; i++) content[i] = i % 251;
  const name = 'browser-payload.bin', expected = hash(content);
  const sourcePath = join(sourceDirectory, name);
  await writeFile(sourcePath, content);
  const item = pane.getByRole('option', { name: new RegExp('^' + name.replaceAll('.', '\\.')) });
  const uploadStart = performance.now();
  await pane.locator('input[type=file]').setInputFiles(sourcePath);
  await expect(item).toBeVisible({ timeout: 30000 });
  const uploadMs = performance.now() - uploadStart;
  assert.equal(hash(await readFile(directory + '/' + name)), expected);
  stage = '浏览器下载';
  await item.click({ button: 'right' });
  const received = page.waitForEvent('download');
  await pane.getByRole('menuitem', { name: '下载', exact: true }).click();
  const downloadStart = performance.now();
  const download = await received;
  assert.equal(await download.failure(), null);
  assert.equal(hash(await readFile(await download.path())), expected);
  await download.delete();
  const downloadMs = performance.now() - downloadStart;
  assert.deepEqual(errors, []);
  for (const id of sessions) {
    const ended = await context.request.post(origin + `/api/v1/files/sessions/${id}/end`, { data: {}, headers: { Origin: origin } });
    assert.ok(ended.ok());
  }
  sessions.clear();
  console.log(JSON.stringify({ device: 'echova', width, bytes: content.length, uploadMs: Math.round(uploadMs), downloadMs: Math.round(downloadMs), uploadAndDownloadSHA256: true, explicitSessionEnded: true, browserStorage, emulatedSecureContext: emulateSecureContext, pageErrors: 0 }));
} catch (error) {
  console.error('本机浏览器文件验证未完成：' + stage + ' ' + error.name + ' ' + error.message.slice(0, 160));
  console.error(JSON.stringify({ pathname: new URL(page.url()).pathname, fileBrowsers: await page.locator('.file-browser').count(), headings: await page.locator('h1, h2').allTextContents(), connectedPanes: await page.locator('.live-files').count(), connectingPanes: await page.locator('.live-files-connect').count(), connectionErrors: await page.locator('.live-files-connect .inline-error').allTextContents(), fileErrors: await page.locator('.live-files .inline-error').allTextContents(), transferProgress: await page.locator('.file-transfer').allTextContents(), browserStorage: await page.evaluate(() => ({ secure: isSecureContext, opfs: Boolean(navigator.storage?.getDirectory) })).catch(() => null), pageErrors: errors }));
  process.exitCode = 1;
} finally {
  await page.goto('about:blank').catch(() => {});
  for (const id of sessions) await context.request.post(origin + `/api/v1/files/sessions/${id}/end`, { data: {}, headers: { Origin: origin } }).catch(() => {});
  await context.close();
  await browser.close();
  await rm(sourceDirectory, { recursive: true, force: true });
}

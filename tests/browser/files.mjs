// 隔离的文件协议回归：全部 API 和文件内容均为测试数据，不连接真实设备。
// 用法：mise exec -- node tests/browser/files.mjs http://127.0.0.1:5179
import assert from 'node:assert/strict';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';

function installFileProtocol() {
  const test = window.fileTest = { events: [], sessions: [], redirects: {}, failName: '', disconnectName: '', holdName: '', uploads: [] };
  window.CreateAgentRedirect = (_, module) => {
    let device, download, upload;
    const emit = (data) => setTimeout(() => module.ProcessData(JSON.stringify(data)), 5);
    const redirect = {
      Start(id) { device = id; test.redirects[id] = redirect; setTimeout(() => redirect.onStateChanged(redirect, 3), 0); },
      Stop() {},
      sendText(command) {
        test.events.push({ device, ...command });
        if (command.action === 'ls') emit({ path: command.path, dir: device === 'echova'
          ? [{ n: '目录', t: 2 }, ...(test.caseNames ? ['a.txt', 'A.txt'] : ['a.txt', 'b.txt', 'c.txt']).map(n => ({ n, t: 3, s: 1 }))]
          : [...new Map([...(test.emptyTarget ? [] : [{ n: 'a.txt', t: 3, s: 1 }]), ...test.uploads.map(f => ({ n: f.name, t: 3, s: f.size }))].map(entry => [entry.n, entry])).values()] });
        if (command.action === 'download' && command.sub === 'start') { download = command; emit({ action: 'download', sub: 'start', id: command.id }); }
        if (command.action === 'download' && command.sub === 'startack') setTimeout(() => module.ProcessBinaryData(new Uint8Array([1, 0, 0, 1, download.path.split('/').at(-1).charCodeAt(0)])), 5);
        if (command.action === 'compress') { test.compression=command;emit({action:'compressed',reqid:command.reqid,name:command.name}); }
        if (command.action === 'upload') {
          upload = { ...command, bytes: [] };
          emit({ action: command.name === test.failName ? 'uploaderror' : 'uploadstart', reqid: command.reqid });
        }
        if (command.action === 'uploaddone') {
          if (upload.name === test.disconnectName) { setTimeout(() => redirect.onStateChanged(redirect, 0), 5); return; }
          if (upload.name === test.holdName) return;
          test.uploads.push(upload);
          emit({ action: 'uploaddone', reqid: upload.reqid });
        }
      },
      send(bytes) {
        upload.bytes.push(...bytes);
        emit({ action: 'uploadack', reqid: upload.reqid });
      },
    };
    return redirect;
  };
}
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ acceptDownloads: true, extraHTTPHeaders: { Accept: '*/*' } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/v1/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: path.endsWith('agent-redir.js') ? `(${installFileProtocol.toString()})();` : '' });
  let data = {};
  if (path.endsWith('/identity/device')) data = { deviceId: 'nix' };
  if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: ['echova', 'nix', 'jiang-chenx'].map(id => ({ id, name: id, platform: id === 'jiang-chenx' ? 'Windows' : 'Ubuntu', role: '测试设备', state: 'online', nodeId: id, pathLabel: '测试', observedAt: '测试' })) };
  if (path.endsWith('/files/sessions')) {
    const id = route.request().postDataJSON().targetDeviceId;
    data = { fileSessionId: id, tunnelId: id, nodeId: id, relayPath: '/test', state: 'connecting' };
  }
  return route.fulfill({ json: { apiVersion: 'v1', data } });
});
const base = process.argv[2] || 'http://127.0.0.1:5179';
const left = page.locator('.file-browser').nth(0);
const right = page.locator('.file-browser').nth(1);
const option = name => left.getByRole('listbox').getByRole('option', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
async function open(width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(base + '/devices/echova/files');
  await expect(option('a.txt')).toBeVisible();
  await expect(right.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('button', { name: '设备 B', exact: true })).toContainText('nix（本机）');
}
async function selectAll() { const items=left.getByRole('listbox').getByRole('option').filter({hasText:/\.txt/}); await items.first().click(); await items.last().click({modifiers:['Shift']}); }
async function transfer() { await page.getByRole('button', { name: /发送到 B/ }).click(); }
async function confirm() { await right.getByRole('button', { name: '确认覆盖', exact: true }).click(); }
try {
  await open();
  await option('a.txt').click();
  await option('c.txt').click({ modifiers: ['Shift'] });
  await expect(left.locator('[aria-selected="true"]')).toHaveCount(3);
  await option('b.txt').click({ modifiers: ['Control'] });
  await expect(left.locator('[aria-selected="true"]')).toHaveCount(2);
  await option('b.txt').click({ modifiers: ['Meta'] });
  await expect(left.locator('[aria-selected="true"]')).toHaveCount(3);
  await transfer();
  await expect(right.getByText('覆盖已有文件？')).toBeVisible();
  assert.equal(await page.evaluate(() => window.fileTest.uploads.length), 0);
  await expect(page.getByRole('button', { name: '设备 B', exact: true })).toBeDisabled();
  await confirm();
  await expect(page.getByRole('status')).toHaveText('已将 3 个文件复制到 nix');
  const copied = await page.evaluate(() => window.fileTest.uploads.map(f => [f.name, f.path, f.bytes]));
  assert.deepEqual(copied, ['a', 'b', 'c'].map(n => [n + '.txt', 'home/nix', [n.charCodeAt(0)]]));
  console.log('通过：Ctrl/⌘/Shift 多选、本机默认接收、逐文件确认及内容顺序');
  await open();await option('a.txt').click();await option('c.txt').click({modifiers:['Control']});
  await option('a.txt').click({button:'right'});await expect(left.locator('[aria-selected="true"]')).toHaveCount(2);
  await left.getByRole('menuitem',{name:'压缩选中项（当前设备）'}).click();
  await left.getByRole('textbox',{name:'压缩包名称'}).fill('测试压缩.tar.gz');await left.getByRole('button',{name:'开始压缩'}).click();
  await expect(left.getByText('已在当前设备目录生成 测试压缩.tar.gz')).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.fileTest.compression.names),['a.txt','c.txt']);
  assert.equal(await page.evaluate(()=>window.fileTest.uploads.length),0);
  await left.getByLabel('设备 A排序方向').click();await expect(left.getByRole('listbox').getByRole('option').nth(1)).toContainText('c.txt');
  await option('c.txt').click();await option('a.txt').click({modifiers:['Shift']});await expect(left.locator('[aria-selected="true"]')).toHaveCount(3);
  console.log('通过：右键保留多选、本设备压缩、排序后 Shift 连选');

  await open();
  await page.evaluate(() => { window.fileTest.caseNames = true; window.fileTest.emptyTarget = true; });
  await left.getByRole('button', { name: '刷新', exact: true }).click();
  await right.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(left.getByRole('listbox').getByRole('option')).toHaveCount(3);
  await expect(right.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await selectAll(); await transfer();
  await expect(right.getByText('覆盖已有文件？')).toBeVisible();
  assert.equal(await page.evaluate(() => window.fileTest.uploads.length), 1);
  await right.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('后续文件未继续传输');
  await expect(page.getByRole('status')).toContainText('已完成 1/2');
  console.log('通过：同批大小写同名文件仍逐项确认覆盖');

  await open(); await selectAll(); await transfer();
  await right.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已完成 0/3');
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'upload').length), 0);
  console.log('通过：取消覆盖不写入、不继续后续文件');

  for (const failure of ['failName', 'disconnectName']) {
    await open();
    await page.evaluate(key => { window.fileTest[key] = 'b.txt'; }, failure);
    await selectAll(); await transfer(); await confirm();
    await expect(page.getByRole('status')).toContainText('后续文件未继续传输');
    await expect(page.getByRole('status')).toContainText('已完成 1/3');
    assert.deepEqual(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'upload').map(e => e.name)), ['a.txt', 'b.txt']);
  }
  console.log('通过：上传失败和目标断线报告部分完成，后续文件不发送');

  await open();
  await page.evaluate(() => { window.fileTest.holdName = 'a.txt'; });
  await selectAll(); await transfer(); await confirm();
  await expect(page.getByRole('status')).toContainText('已完成 0/3');
  await page.evaluate(() => { window.fileTest.redirects.nix.onStateChanged(window.fileTest.redirects.nix, 0); });
  await expect(page.getByRole('status')).toContainText('上传结果未确认');
  console.log('通过：收到上传确认前不报告成功');

  await open();
  await page.clock.install();
  await page.evaluate(() => { window.fileTest.holdName = 'a.txt'; });
  await selectAll(); await transfer(); await confirm();
  await expect.poll(() => page.evaluate(() => window.fileTest.events.some(e => e.action === 'uploaddone'))).toBe(true);
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('status')).toContainText('上传结果未确认');
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'upload').length), 1);
  console.log('通过：上传超时终止队列，不重放');


  await open(390);
  for(const name of ['多选','全选文件','取消选择','下载到本机']) await expect(left.getByRole('button',{name,exact:true})).toHaveCount(0);
  await option('a.txt').click();await option('b.txt').click();
  await expect(left.locator('[aria-selected="true"]')).toHaveCount(1);
  const downloaded=page.waitForEvent('download');
  await option('a.txt').click({button:'right'});
  await left.getByRole('menuitem',{name:'下载',exact:true}).click();
  assert.equal((await downloaded).suggestedFilename(),'a.txt');
  console.log('通过：移除四个按钮，普通点选替换选择，保留右键单文件下载');

  for (const width of [1440, 875, 821, 820, 390]) {
    await open(width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await page.goto(base + '/devices/nix/files');
  await expect(page.getByRole('heading', { name: '设备间文件管理' })).toBeVisible();
  assert.ok(page.url().endsWith('/devices/nix/files'));
  await page.goto(base + '/');
  const local = page.getByRole('article', { name: 'nix', exact: true });
  await expect(local.getByRole('button', { name: '打开桌面' })).toBeDisabled();
  await expect(local.getByRole('button', { name: '文件', exact: true })).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log('通过：响应式布局、本机文件入口可用、本机控屏仍禁用、无页面错误');
} finally {
  await browser.close();
}

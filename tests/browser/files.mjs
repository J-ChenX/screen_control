// 隔离的文件协议回归：全部 API 和文件内容均为测试数据，不连接真实设备。
// 用法：mise exec -- node tests/browser/files.mjs http://127.0.0.1:5179
import assert from 'node:assert/strict';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';

function installFileProtocol() {
  const test = window.fileTest = { events: [], sessions: [], redirects: {}, failName: '', disconnectName: '', holdName: '', uploads: [] };
  window.CreateAgentRemoteDesktop = () => ({ protocol: 2, GrabMouseInput() {}, GrabKeyInput() {}, UnGrabMouseInput() {}, UnGrabKeyInput() {} });
  window.CreateAgentRedirect = (_, module) => {
    let device, download, upload;
    const emit = (data) => setTimeout(() => module.ProcessData(JSON.stringify(data)), 5);
    const redirect = {
      m: module,
      Start(id) { device = id; test.redirects[id] = redirect; setTimeout(() => redirect.onStateChanged(redirect, 3), 0); },
      Stop() {},
      sendText(command) {
        test.events.push({ device, ...command });
        if (command.action === 'ls' && test.previewFiles) { emit({ path: command.path, dir: Object.entries(test.previewFiles).map(([n, bytes]) => ({ n, t: 3, s: bytes.length })) }); return; }
        if (command.action === 'ls' && device === 'jiang-chenx') {
          emit({ path: command.path, folderTransfer: true, dir: command.path === '' ? [{ n: 'C:/', t: 1, dt: '磁盘' }] : command.path === 'C:/' ? [{ n: 'Users', t: 2 }] : command.path === 'C:/Users' ? [] : null });
          return;
        }
        if (command.action === 'ls') emit({ path: command.path, folderTransfer: !test.oldWorker, dir: device === 'echova'
          ? [{ n: '目录', t: 2 }, ...(test.caseNames ? ['a.txt', 'A.txt'] : ['a.txt', 'b.txt', 'c.txt']).map(n => ({ n, t: 3, s: test.largeFile && n === "b.txt" ? 17 * 1024 * 1024 : 1 }))]
          : [...new Map([...(test.emptyTarget ? [] : [{ n: 'a.txt', t: 3, s: 1 }]), ...test.uploads.map(f => ({ n: f.name, t: 3, s: f.size }))].map(entry => [entry.n, entry])).values()] });
        if (command.action === 'download' && command.sub === 'start') {
          download = { ...command, bytes: test.previewFiles?.[command.path.split('/').at(-1)], offset: 0, size: test.largeFile && command.path.endsWith('/b.txt') ? 17 * 1024 * 1024 : 1 };
          if (download.bytes) download.size = download.bytes.length;
          emit({ action: 'download', sub: test.sourceError ? 'cancel' : 'start', id: command.id, size: download.size, message: test.sourceError });
        }
        if (command.action === 'download' && ['startack', 'ack'].includes(command.sub)) setTimeout(() => {
          const count = Math.min(64 * 1024, download.size - download.offset);
          const frame = new Uint8Array(count + 4); frame.fill(download.path.split('/').at(-1).charCodeAt(0), 4);
          if (download.bytes) frame.set(download.bytes.slice(download.offset, download.offset + count), 4);
          download.offset += count; frame.set([1, 0, 0, download.offset === download.size ? 1 : 0]);
          module.ProcessBinaryData(frame);
        }, 1);
        if (command.action === 'download' && command.sub === 'stop' && test.sourceError) emit({action:'error',message:'下载标识无效'});
        if (command.action === 'open-directory' && test.openDirectoryReply) emit({ action: 'directory-open-requested', reqid: command.reqid, status: 'unknown' });
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
        if (bytes[0] === 0) bytes = bytes.slice(1);
        if (test.largeFile) { upload.received = (upload.received || 0) + bytes.length; upload.firstByte ??= bytes[0]; upload.lastByte = bytes.at(-1); }
        else upload.bytes.push(...bytes);
        emit({ action: test.failAfterChunk ? 'uploaderror' : 'uploadack', reqid: upload.reqid, message: test.failAfterChunk ? '目标写入失败' : undefined });
      },
    };
    return redirect;
  };
}
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP screen-control.test 127.0.0.1'] });
const context = await browser.newContext({ acceptDownloads: true, extraHTTPHeaders: { Accept: '*/*' } });
await context.addInitScript(() => {
  // 模拟用户当前无法使用 OPFS 的页面，设备间传输不得访问该接口。
  Object.defineProperty(navigator, 'storage', { configurable: true, get() { throw new Error('设备间传输不应依赖浏览器磁盘'); } });
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const sharedFavorites = new Map();
const favoriteImports = new Set();
let failFavoriteWrite = false;
const routeAPI = async route => {
  const path = new URL(route.request().url()).pathname;
  if (path.includes('/files/favorites/')) {
    const device = path.split('/').at(-1);
    let paths = [...(sharedFavorites.get(device) ?? [])];
    if (route.request().method() === 'POST') {
      if (failFavoriteWrite) return route.fulfill({ status: 503, json: { apiVersion: 'v1', error: { code: 'FAVORITES_SAVE_FAILED', message: '测试收藏保存失败' } } });
      const change = route.request().postDataJSON();
      if (change.action === 'import') {
        const token = device + ':' + change.importId;
        if (!favoriteImports.has(token)) { paths = [...new Set([...paths, ...change.paths])]; favoriteImports.add(token); }
      } else if (change.action === 'remove') paths = paths.filter(path => path !== change.path);
      else if (change.action === 'add') paths = [...new Set([...paths, change.path])];
      else if (change.action === 'move' && change.before !== change.path) {
        paths = paths.filter(path => path !== change.path);
        const index = paths.indexOf(change.before);
        paths.splice(index < 0 ? paths.length : index, 0, change.path);
      }
      sharedFavorites.set(device, paths);
    }
    return route.fulfill({ json: { apiVersion: 'v1', data: { paths } } });
  }
  if (path.includes('/vendor/')) return route.fulfill({ contentType: 'application/javascript', body: path.endsWith('agent-redir.js') ? `(${installFileProtocol.toString()})();` : '' });
  let data = {};
  if (path.endsWith('/identity/device')) data = { deviceId: 'nix' };
  if (path.endsWith('/control/snapshot')) data = { mode: 'g0-live', devices: ['echova', 'nix', 'jiang-chenx'].map(id => ({ id, name: id, platform: id === 'jiang-chenx' ? 'Windows' : 'Ubuntu', role: '测试设备', state: 'online', nodeId: id, pathLabel: '测试', observedAt: '测试' })) };
  if (path.endsWith('/desktops')) { const id = route.request().postDataJSON().targetDeviceId; data = { desktopSessionId: id, tunnelId: id, nodeId: id, relayPath: '/test' }; }
  if (path.endsWith('/files/sessions')) {
    const id = route.request().postDataJSON().targetDeviceId;
    data = { fileSessionId: id, tunnelId: id, nodeId: id, relayPath: '/test', state: 'connecting' };
  }
  return route.fulfill({ json: { apiVersion: 'v1', data } });
};
await context.route('**/api/v1/**', routeAPI);
const base = process.argv[2] || 'http://127.0.0.1:5179';
const left = page.locator('.file-browser').nth(0);
const right = page.locator('.file-browser').nth(1);
const option = name => left.getByRole('listbox').getByRole('option', { name: new RegExp(`^${name.replace('.', '\\.')}`) });
async function open(width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(base + '/devices/echova/files');
  await expect(option('a.txt')).toBeVisible();
  await expect(left.getByText('已启用跨设备同步', { exact: true })).toBeVisible();
  if (base.includes('screen-control.test')) assert.equal(await page.evaluate(() => window.isSecureContext), false);
  await expect(right.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('button', { name: '设备 B', exact: true })).toContainText('nix（本机）');
}
async function selectAll() { const items=left.getByRole('listbox').getByRole('option').filter({hasText:/\.txt/}); await items.first().click(); await items.last().click({modifiers:['Shift']}); }
async function transfer() { await page.getByRole('button', { name: /发送到 nix/ }).click(); }
async function confirm() { await right.getByRole('button', { name: '确认覆盖', exact: true }).click(); }
try {
  for (const width of [1440, 1024, 390, 320]) {
    await open(width);
    const desktopEntry = left.locator('.file-desktop-entry');
    const desktopButton = desktopEntry.getByRole('button', { name: '在控屏中打开目录', exact: true });
    await expect(desktopButton).toBeVisible();
    await expect(desktopButton).toBeEnabled();
    const buttonBox = await desktopButton.boundingBox(), paneBox = await left.boundingBox();
    assert.ok(buttonBox.x >= paneBox.x && buttonBox.x + buttonBox.width <= paneBox.x + paneBox.width);
    await expect(right.locator('.file-desktop-entry')).toContainText('当前设备不支持控屏');
    await page.screenshot({ path: `/tmp/directory-button-after-${width}.png` });
    await option('a.txt').dblclick();
    const preview = page.getByRole('dialog', { name: '预览 a.txt', exact: true });
    await expect(preview.locator('pre')).toHaveText('a');
    await expect(right.getByRole('button', { name: '在控屏中打开目录', exact: true })).toBeDisabled();
    await page.screenshot({ path: `/tmp/file-preview-${width}.png` });
    await preview.getByRole('button', { name: '关闭预览' }).click();
    await expect(preview).toHaveCount(0);
    await page.evaluate(() => { window.fileTest.sourceError = '读取权限不足'; });
    await option('a.txt').dblclick();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('读取权限不足');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.fileTest.sourceError = ''; window.fileTest.largeFile = true; });
    await left.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(option('b.txt')).toContainText('17');
    await option('b.txt').dblclick();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('16 MiB');
    await page.keyboard.press('Escape');
    await page.clock.install();
    await left.getByRole('button', { name: '在控屏中打开目录', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.fileTest.events.filter(event => event.action === 'open-directory').map(event => event.path))).toEqual(['home/echova']);
    await page.clock.fastForward(16_000);
    await expect(left.getByText('打开目录结果未确认，未自动重试；请检查目标桌面或升级文件进程。', { exact: true })).toBeVisible();
    await page.clock.resume();
  }
  await open();
  await page.evaluate(() => {
    const text = new TextEncoder();
    window.fileTest.previewFiles = {
      '图片.png': Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII='), c => c.charCodeAt(0)),
      '页面.html': Array.from(text.encode('<script>window.previewExecuted=true</script>')),
      '文档.docx': [0,1,2],
      '文档.pdf': Array.from(text.encode('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'))
    };
    window.previewRevoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.previewRevoked.push(url); revoke(url); };
  });
  await left.getByRole('button', { name: '刷新', exact: true }).click();
  await option('图片.png').dblclick();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(image => image.naturalWidth)).toBe(1);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.previewRevoked.length), 1);
  await option('页面.html').dblclick();
  await expect(page.getByRole('dialog').locator('pre')).toHaveText('<script>window.previewExecuted=true</script>');
  assert.equal(await page.evaluate(() => Boolean(window.previewExecuted)), false);
  await page.keyboard.press('Escape');
  await option('文档.docx').dblclick();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('暂不支持');
  await page.keyboard.press('Escape');
  await option('文档.pdf').dblclick();
  await expect(page.getByRole('dialog').locator('iframe')).toHaveAttribute('src', /^blob:/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.previewRevoked.length), 2);
  await open();
  await page.evaluate(() => { window.fileTest.openDirectoryReply = true; });
  await left.getByRole('button', { name: '在控屏中打开目录', exact: true }).click();
  await expect(page).toHaveURL(/devices\/echova\/desktop\?directoryOpen=requested$/);
  await expect(page.getByRole('status', { name: '实机桌面已连接', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'open-directory').length), 1);
  await page.getByRole('button', { name: '文件传输', exact: true }).click();
  const embeddedFiles = page.getByRole('dialog', { name: '文件传输 · echova', exact: true });
  await expect(embeddedFiles).toBeVisible();
  await embeddedFiles.getByRole('listbox').first().getByRole('option', { name: /^a\.txt/ }).dblclick();
  await expect(page.getByRole('dialog', { name: '预览 a.txt', exact: true }).locator('pre')).toHaveText('a');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '预览 a.txt', exact: true })).toHaveCount(0);
  await expect(embeddedFiles).toBeVisible();
  await embeddedFiles.getByRole('button', { name: '关闭文件传输', exact: true }).click();
  await expect(page.getByRole('status', { name: '实机桌面已连接', exact: true })).toBeVisible();
  if (process.env.SCREEN_CONTROL_PREVIEW_ONLY === '1') { console.log('通过：预览专项（桌面/手机、图片、文本、PDF 入口、资源释放、格式和大小限制、路径请求及超时）'); process.exitCode = 0; await browser.close(); process.exit(0); }
  console.log('通过：桌面与手机文本预览、关闭、读取失败、大小限制、控屏路径请求及超时不重放');
  await open();
  await option('目录').dblclick();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('home/echova/目录');
  await left.getByRole('button', { name: '返回初始目录' }).click();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('home/echova');
  await right.getByRole('textbox', { name: '设备 B地址' }).fill('tmp');
  await right.getByRole('button', { name: '转到', exact: true }).click();
  await expect(right.getByRole('button', { name: '返回初始目录' })).toBeEnabled();
  await right.getByRole('button', { name: '返回初始目录' }).click();
  await expect(right.getByRole('textbox', { name: '设备 B地址' })).toHaveValue('home/nix');
  console.log('通过：两侧根目录各自返回初始目录');
  const sortMenuButton = left.getByRole('button', { name: '设备 A排序方式', exact: true });
  await sortMenuButton.press('ArrowDown');
  const sortMenu = left.getByRole('listbox', { name: '设备 A排序方式', exact: true });
  await expect(sortMenu).toBeVisible();
  const triggerBounds = await sortMenuButton.boundingBox(), menuBounds = await sortMenu.boundingBox();
  assert.ok(menuBounds.y >= triggerBounds.y + triggerBounds.height);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(sortMenuButton).toContainText('大小');
  await sortMenuButton.click();
  await page.keyboard.press('Escape');
  await expect(sortMenu).not.toBeVisible();
  await expect(sortMenuButton).toBeFocused();
  await sortMenuButton.click();
  await sortMenu.getByRole('option', { name: '名称', exact: true }).click();
  console.log('通过：自定义排序菜单向下展开、键盘选择与 Escape 返回焦点');

  await option('目录').click({ button: 'right' });
  await left.getByRole('menuitem', { name: '收藏文件夹', exact: true }).click();
  const favorites = left.getByRole('complementary', { name: '设备 A文件夹收藏' });
  await expect(favorites.getByRole('button', { name: '打开收藏 home/echova/目录', exact: true })).toBeVisible();
  await expect(option('目录').locator('.entry-favorite-icon')).toHaveCount(1);
  await expect(right.locator('.favorite-open')).toHaveCount(0);
  await option('a.txt').click({ button: 'right' });
  await expect(left.getByRole('menuitem', { name: '收藏文件夹', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await open();
  await favorites.getByRole('button', { name: '打开收藏 home/echova/目录', exact: true }).click();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('home/echova/目录');
  await expect(option('a.txt').locator('.entry-kind-document')).toHaveCount(1);
  await page.screenshot({ path: '/tmp/files-favorites-desktop.png', fullPage: true });
  await open(390);
  await expect(favorites.getByRole('button', { name: '打开收藏 home/echova/目录', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/files-favorites-mobile.png', fullPage: true });
  await favorites.getByRole('button', { name: '取消收藏 home/echova/目录', exact: true }).click();
  await expect(option('目录').locator('.entry-favorite-icon')).toHaveCount(0);
  await open();
  await expect(favorites.locator('.favorite-open')).toHaveCount(0);
  console.log('通过：文件夹收藏、刷新保留、设备隔离、取消收藏、类型图标与桌面/手机布局');
  await option('目录').dragTo(favorites);
  await expect(favorites.locator('.favorite-open')).toHaveCount(1);
  await option('目录').dragTo(favorites);
  await expect(favorites.locator('.favorite-open')).toHaveCount(1);
  await expect(option('a.txt')).toHaveAttribute('draggable', 'false');
  await option('目录').dragTo(right.locator('.file-favorites'));
  await expect(right.locator('.favorite-open')).toHaveCount(0);
  await favorites.getByRole('button', { name: '☆ 收藏当前目录', exact: true }).click();
  const favoriteNames = () => favorites.locator('.favorite-open').evaluateAll(items => items.map(item => item.getAttribute('aria-label')));
  const originalOrder = ['打开收藏 home/echova/目录', '打开收藏 home/echova'];
  await expect.poll(favoriteNames).toEqual(originalOrder);
  const reorderFrom = await favorites.locator('li').last().boundingBox();
  const reorderTo = await favorites.locator('li').first().boundingBox();
  await page.mouse.move(reorderFrom.x + 35, reorderFrom.y + 20);
  await page.mouse.down();
  await page.mouse.move(reorderTo.x + 35, reorderTo.y + 3, { steps: 10 });
  await page.mouse.up();
  await expect.poll(favoriteNames).toEqual([...originalOrder].reverse());
  await open();
  await expect.poll(favoriteNames).toEqual([...originalOrder].reverse());
  await favorites.locator('.favorite-drag-handle').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(favoriteNames).toEqual(originalOrder);
  // 触摸事件经过浏览器实际命中测试和指针捕获，不依赖原生 HTML 拖动支持。
  await open(390);
  const cdp = await context.newCDPSession(page);
  async function touchDrag(source, destination) {
    await expect(favorites.getByText("已启用跨设备同步", { exact: true })).toBeVisible();
    await source.scrollIntoViewIfNeeded();
    await destination.scrollIntoViewIfNeeded();
    const from = await source.boundingBox(), to = await destination.boundingBox();
    const x = from.x + from.width / 2, y = from.y + from.height / 2;
    const endX = to.x + to.width / 2, endY = to.y + 3;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (endX - x) * step / 12, y: y + (endY - y) * step / 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await touchDrag(favorites.locator('.favorite-drag-handle').last(), favorites.locator('li').first());
  await expect.poll(favoriteNames).toEqual([...originalOrder].reverse());
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('home/echova');
  await favorites.getByRole('button', { name: '取消收藏 home/echova/目录', exact: true }).click();
  await touchDrag(option('目录').locator('.folder-touch-drag'), favorites.locator('.favorite-drop-end'));
  await expect(favorites.locator('.favorite-open')).toHaveCount(2);
  await page.screenshot({ path: '/tmp/files-drag-mobile.png', fullPage: true });
  await open();
  await page.screenshot({ path: '/tmp/files-drag-desktop.png', fullPage: true });
  await favorites.getByRole('button', { name: '取消收藏 home/echova/目录', exact: true }).click();
  await favorites.getByRole('button', { name: '取消收藏 home/echova', exact: true }).click();
  await cdp.detach();
  console.log('通过：拖入收藏、去重、跨设备拒绝、拖动与键盘排序、刷新保留、手机触摸拖入与排序');
  // 用真实鼠标拖动覆盖整栏边缘、内部按钮及底部，不能只验证图标中心。
  for (const width of [1440, 390]) {
    await open(width);
    // 固定高度的手机面板可能在首屏下方，先滚入视口再计算鼠标坐标。
    await favorites.scrollIntoViewIfNeeded();
    const bounds = await favorites.boundingBox();
    const points = [
      [8, 8], [bounds.width - 8, 8],
      [bounds.width / 2, 86], [bounds.width - 3, bounds.height / 2],
      [8, bounds.height - 8], [bounds.width - 8, bounds.height - 8],
    ];
    for (const [dx, dy] of points) {
      await expect(favorites.getByText("已启用跨设备同步", { exact: true })).toBeVisible();
      const from = await option('目录').boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + 25);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 - 12, from.y + 30, { steps: 3 });
      await page.mouse.move(bounds.x + dx, bounds.y + dy, { steps: 10 });
      await page.mouse.move(bounds.x + dx, bounds.y + dy);
      await expect(favorites).toHaveClass(/favorite-drop-active/);
      await expect(favorites.locator('.favorite-drop-surface')).toBeVisible();
      if (dx === 8 && dy === 8) await page.screenshot({ path: `/tmp/files-droparea-${width}.png`, fullPage: true });
      await page.mouse.up();
      await expect(favorites.locator('.favorite-open')).toHaveCount(1);
      await favorites.getByRole('button', { name: '取消收藏 home/echova/目录', exact: true }).click();
    }
    const from = await option('目录').boundingBox();
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 10, bounds.y + 10, { steps: 10 });
    await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + bounds.height - 10, { steps: 10 });
    await page.mouse.up();
    await expect(favorites.locator('.favorite-open')).toHaveCount(0);
  }
  console.log('通过：桌面/手机整栏六处放下均可收藏，离开区域不误触发');
  // 第二个浏览器上下文没有共享 localStorage，模拟另一台电脑。
  const otherContext = await browser.newContext({ extraHTTPHeaders: { Accept: '*/*' } });
  await otherContext.route('**/api/v1/**', routeAPI);
  const otherPage = await otherContext.newPage();
  await otherPage.goto(base + '/devices/echova/files');
  const otherFavorites = otherPage.locator('.file-browser').first().locator('.file-favorites');
  await expect(otherFavorites.getByText('已启用跨设备同步', { exact: true })).toBeVisible();
  await open();
  await option('目录').click({ button: 'right' });
  await left.getByRole('menuitem', { name: '收藏文件夹', exact: true }).click();
  await expect(otherFavorites.locator('.favorite-open')).toHaveCount(1, { timeout: 10000 });
  await favorites.getByRole('button', { name: '☆ 收藏当前目录', exact: true }).click();
  await expect(favorites.getByText('已启用跨设备同步', { exact: true })).toBeVisible();
  await favorites.locator('.favorite-drag-handle').last().focus();
  await page.keyboard.press('ArrowUp');
  await expect(otherFavorites.locator('.favorite-open').first()).toHaveAttribute('aria-label', '打开收藏 home/echova', { timeout: 10000 });
  await otherFavorites.getByRole('button', { name: '取消收藏 home/echova/目录', exact: true }).click();
  await expect(favorites.locator('.favorite-open')).toHaveCount(1, { timeout: 10000 });
  failFavoriteWrite = true;
  await favorites.getByRole('button', { name: '取消收藏 home/echova', exact: true }).click();
  await expect(favorites.getByRole('status')).toContainText('未确认保存');
  await expect(favorites.locator('.favorite-open')).toHaveCount(1);
  failFavoriteWrite = false;
  await favorites.getByRole('button', { name: '取消收藏 home/echova', exact: true }).click();
  await expect(favorites.locator('.favorite-open')).toHaveCount(0);
  await otherContext.close();
  await page.evaluate(() => localStorage.setItem('screen-control:folder-favorites:echova', JSON.stringify(['home/echova/旧收藏'])));
  await open();
  await expect(favorites.locator('.favorite-open')).toHaveCount(1);
  assert.equal(await page.evaluate(() => localStorage.getItem('screen-control:folder-favorites:echova')), null);
  await favorites.getByRole('button', { name: '取消收藏 home/echova/旧收藏', exact: true }).click();
  await open();
  await expect(favorites.locator('.favorite-open')).toHaveCount(0);
  console.log('通过：独立浏览器新增/删除/排序同步、保存失败不误报、旧收藏迁移且取消后不复活');



  await open();
  await page.evaluate(() => { window.fileTest.sourceError = '无法复制 node_modules/socket（套接字）：运行时特殊文件不能作为普通文件传输'; });
  await option('目录').click(); await transfer();
  await expect(page.getByRole('status')).toContainText('node_modules/socket');
  await expect(left.getByText('无法复制 node_modules/socket（套接字）：运行时特殊文件不能作为普通文件传输', {exact:true})).toBeVisible();
  await expect(left.getByText('目标设备取消了下载', {exact:true})).toHaveCount(0);
  console.log('通过：源端具体失败原因保留，不误报接收端取消');

  await open();
  await page.evaluate(() => { window.fileTest.largeFile = true; });
  await left.getByRole('button', {name:'刷新',exact:true}).click();
  await option('b.txt').click(); await transfer();
  await expect(page.getByRole('status')).toHaveText('已将 1 个项目复制到 nix', {timeout:60000});
  assert.deepEqual(await page.evaluate(() => { const f=window.fileTest.uploads[0];return [f.received,f.firstByte,f.lastByte]; }), [17*1024*1024,98,98]);
  assert.equal(await page.evaluate(() => window.fileTest.events.findIndex(e => e.action === 'upload') < window.fileTest.events.findIndex(e => e.action === 'download' && e.sub === 'startack')), true);
  console.log('通过：无 OPFS 时 17 MB 分块转发；接收端就绪后才拉取来源正文');

  await open();
  await option('a.txt').click();
  await option('c.txt').click({ modifiers: ['Shift'] });
  await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(3);
  await option('b.txt').click({ modifiers: ['Control'] });
  await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(2);
  await option('b.txt').click({ modifiers: ['Meta'] });
  await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(3);
  await transfer();
  await expect(right.getByText('覆盖已有文件？')).toBeVisible();
  assert.equal(await page.evaluate(() => window.fileTest.uploads.length), 0);
  await expect(page.getByRole('button', { name: '设备 B', exact: true })).toBeDisabled();
  await confirm();
  await expect(page.getByRole('status')).toHaveText('已将 3 个项目复制到 nix');
  const copied = await page.evaluate(() => window.fileTest.uploads.map(f => [f.name, f.path, f.bytes]));
  assert.deepEqual(copied, ['a', 'b', 'c'].map(n => [n + '.txt', 'home/nix', [n.charCodeAt(0)]]));
  console.log('通过：Ctrl/⌘/Shift 多选、本机默认接收、逐文件确认及内容顺序');
  await open();await option('a.txt').click();await option('c.txt').click({modifiers:['Control']});
  await option('a.txt').click({button:'right'});await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(2);
  await left.getByRole('menuitem',{name:'压缩选中项（当前设备）'}).click();
  await left.getByRole('textbox',{name:'压缩包名称'}).fill('测试压缩.tar.gz');await left.getByRole('button',{name:'开始压缩'}).click();
  await expect(left.getByText('已在当前设备目录生成 测试压缩.tar.gz')).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.fileTest.compression.names),['a.txt','c.txt']);
  assert.equal(await page.evaluate(()=>window.fileTest.uploads.length),0);
  await left.getByLabel('设备 A排序方向').click();await expect(left.getByRole('listbox').getByRole('option').nth(1)).toContainText('c.txt');
  await option('c.txt').click();await option('a.txt').click({modifiers:['Shift']});await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(3);
  console.log('通过：右键保留多选、本设备压缩、排序后 Shift 连选');

  for (const width of [1440, 390]) {
    await open(width);
    await option('目录').click(); await transfer();
    await expect(page.getByRole('status')).toHaveText('已将 1 个项目复制到 nix');
    assert.equal(await page.evaluate(() => window.fileTest.uploads[0].folder), true);
    assert.equal(await page.evaluate(() => window.fileTest.events.find(e => e.action === 'download').folder), true);
    await option('目录').click(); await transfer();
    await expect(page.getByRole('status')).toContainText('同名');
    assert.equal(await page.evaluate(() => window.fileTest.uploads.length), 1);
  }
  console.log('通过：桌面和手机文件夹传输、源端打包标志、目标端解压标志及同名拒绝');

  await open();
  await page.evaluate(() => { window.fileTest.oldWorker = true; });
  await right.getByRole('button', { name: '刷新', exact: true }).click();
  await option('目录').click(); await transfer();
  await expect(page.getByRole('status')).toContainText('目标设备文件进程尚未升级');
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'upload').length), 0);
  console.log('通过：旧版目标不接收文件夹包，不误报成功');

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

  await open(); await option('a.txt').click(); await transfer();
  await expect(right.getByText('覆盖已有文件？')).toBeVisible();
  await page.evaluate(() => { window.fileTest.redirects.echova.onStateChanged(window.fileTest.redirects.echova, 0); });
  await expect(page.getByRole('status')).toContainText('会话已结束');
  await expect(right.getByText('覆盖已有文件？')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'upload').length), 0);
  console.log('通过：确认覆盖期间来源断线，关闭接收请求且不上传');

  await open();
  await page.evaluate(() => { window.fileTest.largeFile = true; window.fileTest.failAfterChunk = true; });
  await left.getByRole('button', {name:'刷新',exact:true}).click();
  await option('b.txt').click(); await transfer();
  await expect(page.getByRole('status')).toContainText('目标写入失败');
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'download' && e.sub === 'ack').length), 0);
  assert.equal(await page.evaluate(() => window.fileTest.events.filter(e => e.action === 'uploaddone').length), 0);
  console.log('通过：目标首块失败，停止拉取来源且不提交不完整文件');

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
  await expect(left.locator('.file-icon-grid [aria-selected="true"]')).toHaveCount(1);
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
  await expect(local.getByRole('button', { name: '打开桌面' })).toHaveCount(0);
  await expect(local.getByRole('button', { name: '文件', exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('通过：响应式布局、本机文件路由可用、本机卡片不显示操作按钮、无页面错误');
  await page.goto(base + '/devices/jiang-chenx/files');
  await expect(left.getByRole('option', { name: /^C:\// })).toBeVisible();
  await left.getByRole('option', { name: /^C:\// }).dblclick();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('C:/');
  await expect(left.getByRole('option', { name: /^Users/ })).toBeVisible();
  await expect(left.locator('.favorite-current')).toBeDisabled();
  await left.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(left.getByRole('option', { name: /^Users/ })).toBeVisible();
  await left.getByRole('option', { name: /^Users/ }).dblclick();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('C:/Users');
  await expect(left.getByText('此目录为空', { exact: true })).toBeVisible();
  await left.getByRole('button', { name: '返回上一级目录' }).click();
  await expect(left.getByRole('option', { name: /^Users/ })).toBeVisible();
  await left.getByRole('textbox', { name: '设备 A地址' }).fill('C:');
  await left.getByRole('button', { name: '转到', exact: true }).click();
  await expect(left.getByRole('option', { name: /^Users/ })).toBeVisible();
  assert.equal(await page.evaluate(() => window.fileTest.events.some(event => event.action === 'ls' && event.device === 'jiang-chenx' && event.path === 'C:')), false);
  await expect(left.getByRole('button', { name: '转到', exact: true })).toBeEnabled();
  await left.getByRole('textbox', { name: '设备 A地址' }).fill('C:/missing');
  await left.getByRole('button', { name: '转到', exact: true }).click();
  await expect(left.getByText('无法访问该目录', { exact: true })).toBeVisible();
  await expect(left.getByText('此目录为空', { exact: true })).toHaveCount(0);
  await left.getByRole('button', { name: '返回初始目录' }).click();
  await expect(left.getByRole('option', { name: /^C:\// })).toBeVisible();
  await expect(left.getByRole('textbox', { name: '设备 A地址' })).toHaveValue('');
  console.log('通过：Windows 盘符根目录、刷新、返回上级、手动盘符输入及访问失败提示');

} finally {
  await browser.close();
}

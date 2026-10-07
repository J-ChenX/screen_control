// 隔离验证控屏文件入口：弹窗直连当前设备，不结束原控屏会话。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin } from '../support/browser.mjs';
const base = testOrigin();
const browser = await launchBrowser();
function protocol() {
  window.desktopInputActive = false;
  window.CreateAgentRemoteDesktop = () => ({ protocol: 2, GrabMouseInput() {}, GrabKeyInput() { window.desktopInputActive = true; }, UnGrabMouseInput() {}, UnGrabKeyInput() { window.desktopInputActive = false; } });
  window.CreateAgentRedirect = (_, module) => {
    const redirect = { m: module, Start() { setTimeout(() => redirect.onStateChanged(redirect, 3), 0); }, Stop() {}, sendText(command) {
      if (command.action === 'ls') setTimeout(() => module.ProcessData(JSON.stringify({path:command.path,dir:[]})), 0);
    }};
    return redirect;
  };
}
try {
 for (const width of [1440, 390, 320]) {
  const context = await browser.newContext({ viewport: {width,height:900}, extraHTTPHeaders:{Accept:'*/*'} });
  const ended = [], files = [], fileEnds = [], errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()).pathname;
    if(url.includes('/vendor/')) return route.fulfill({contentType:'application/javascript',body:`(${protocol.toString()})();`});
    let data = {};
    if(url.includes("/files/favorites/")) data={paths:[]};
    if(url.endsWith('/identity/device')) data={deviceId:'nix'};
    if(url.endsWith('/control/snapshot')) data={mode:'g0-live',devices:['echova','nix','jiang-chenx'].map(id=>({id,name:id,platform:'Ubuntu',role:'测试设备',state:'online',nodeId:id,pathLabel:'测试',observedAt:'测试'}))};
    if(url.endsWith('/desktops')) data={desktopSessionId:'test-desktop',tunnelId:'test',nodeId:'echova',relayPath:'/test',state:'connecting'};
    if(url.includes('/desktops/') && url.endsWith('/end')) ended.push(url);
    if(url.includes('/files/sessions/') && url.endsWith('/end')) fileEnds.push(url);
    if(url.endsWith('/files/sessions')) { const id=route.request().postDataJSON().targetDeviceId;files.push(id);data={fileSessionId:id,tunnelId:id,nodeId:id,relayPath:'/test',state:'connecting'}; }
    return route.fulfill({json:{apiVersion:'v1',data}});
  });
  const page=await context.newPage();
  await page.goto(base+'/devices/echova/desktop');
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  const button=page.getByRole('button',{name:'文件传输',exact:true});
  await expect(button).toBeVisible();
  const rect=await button.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(width===1440) { await page.getByRole('button',{name:'进入全屏'}).click();await expect.poll(()=>page.evaluate(()=>!!document.fullscreenElement)).toBe(true);await page.getByRole('button',{name:'工具',exact:true}).click(); }
  await button.click();
  const popup=page.getByRole('dialog',{name:'文件传输 · echova',exact:true});
  await expect(popup).toBeVisible();
  const bounds=await popup.boundingBox();assert.ok(bounds.width<=width && bounds.height>=760 && bounds.height<=880);
  if(width===1440) assert.ok(bounds.width>=width-40 && bounds.width<=width-24);
  for(const name of ['多选','全选文件','取消选择','下载到本机']) await expect(popup.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(popup.getByRole('button',{name:'设备 A',exact:true})).toContainText('echova');
  await expect(popup.getByRole('button',{name:'设备 B',exact:true})).toContainText('nix（本机）');
  await expect(popup.getByRole('listbox')).toHaveCount(2);
  assert.deepEqual(files.sort(),['echova','nix']);assert.equal(context.pages().length,1);
  assert.equal(await page.evaluate(()=>window.desktopInputActive),false);
  assert.equal(await popup.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await expect(page).toHaveURL(base+'/devices/echova/desktop');
  assert.deepEqual(ended,[]);
  await popup.getByRole('button',{name:'关闭文件传输'}).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  assert.equal(await page.evaluate(()=>window.desktopInputActive),true);
  await expect.poll(()=>fileEnds.length).toBe(2);
  if(width===1440) await page.getByRole('button',{name:'退出全屏'}).click();
  await button.click();await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');await expect(popup).toHaveCount(0);
  assert.deepEqual(ended,[]);
  assert.deepEqual(errors,[]);
  console.log(`通过：${width}px 控屏文件入口可见，弹窗连接被控设备与本机，输入暂停/恢复及关闭清理通过，控屏保持连接`);
  await context.close();
 }
} finally { await browser.close(); }

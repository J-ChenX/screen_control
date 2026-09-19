// 隔离验证画质切换与桌面、手机布局，不连接真实目标。
import assert from 'node:assert/strict';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const base = process.argv[2] || 'http://127.0.0.1:4175';
function protocol() {
  window.settings = [];
  window.CreateAgentRemoteDesktop = () => ({ protocol: 2, GrabMouseInput() {}, GrabKeyInput() {}, UnGrabMouseInput() {}, UnGrabKeyInput() {}, SendCompressionLevel(...args) { window.settings.push(args); } });
  window.CreateAgentRedirect = (_, module) => {
    const redirect = { m: module, Start() { window.settings.push([module.ImageType,module.CompressionLevel,module.ScalingLevel,module.FrameRateTimer]); setTimeout(() => redirect.onStateChanged(redirect, 3), 0); }, Stop() {} };
    return redirect;
  };
}
try {
 for (const width of [1440, 390, 320]) {
  const context = await browser.newContext({ viewport: {width,height:900}, extraHTTPHeaders:{Accept:'*/*'} });
  const errors = [];
  await context.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()).pathname;
    if(url.includes('/vendor/')) return route.fulfill({contentType:'application/javascript',body:`(${protocol.toString()})();`});
    let data = {};
    if(url.endsWith('/identity/device')) data={deviceId:'nix'};
    if(url.endsWith('/control/snapshot')) data={mode:'g0-live',devices:['echova','nix','jiang-chenx'].map(id=>({id,name:id,platform:'Ubuntu',role:'测试设备',state:'online',nodeId:id,pathLabel:'测试',observedAt:'测试'}))};
    if(url.endsWith('/desktops')) data={desktopSessionId:'test-desktop',tunnelId:'test',nodeId:'echova',relayPath:'/test',state:'connecting'};
    return route.fulfill({json:{apiVersion:'v1',data}});
  });
  const page=await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base+'/devices/echova/desktop');
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  assert.deepEqual(await page.evaluate(()=>window.settings),[[1,60,1024,40]]);
  await page.getByRole('button',{name:'流畅：关',exact:true}).click();
  await expect(page.getByRole('button',{name:'流畅：开',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'锁屏并结束连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  await page.getByRole('button',{name:'流畅：开',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.settings),[[1,60,1024,40],[1,45,512,40],[1,45,512,40],[1,60,1024,40]]);
  for (const name of ['流畅：关','文件传输','锁屏并结束连接']) {
    const button=page.getByRole('button',{name,exact:true});
    const rect=await button.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`/tmp/screen-control-performance-${width}.png`});
  assert.deepEqual(errors,[]);
  await context.close();
 }
 console.log('PASS: 画质切换、重连保留与 1440/390/320 布局。');
} finally { await browser.close(); }

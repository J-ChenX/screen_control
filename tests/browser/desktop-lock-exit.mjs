// 隔离检查显式锁屏、直接返回、失败提示和桌面/手机布局。
import assert from 'node:assert/strict';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const base=process.argv[2] || 'http://127.0.0.1:4176';
function protocol() {
 window.CreateAgentRemoteDesktop=()=>({protocol:2,GrabMouseInput(){},GrabKeyInput(){},UnGrabMouseInput(){},UnGrabKeyInput(){}});
 window.CreateAgentRedirect=(_,m)=>{const r={m,Start(){setTimeout(()=>r.onStateChanged(r,3),0)},Stop(){}};return r;};
}
try {
 for (const width of [1440,390,320]) {
  const context=await browser.newContext({viewport:{width,height:900}});
  const requests=[]; let fail=false;
  await context.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   requests.push(path);
   if(path.includes('/vendor/')) return route.fulfill({contentType:'application/javascript',body:`(${protocol.toString()})();`});
   let data={};
   if(path.endsWith('/identity/device')) data={deviceId:'nix'};
   if(path.endsWith('/control/snapshot')) data={mode:'g0-live',devices:['echova','nix','jiang-chenx'].map(id=>({id,name:id,platform:'Windows',role:'测试设备',state:'online',nodeId:id,pathLabel:'测试',observedAt:'测试'}))};
   if(path.endsWith('/desktops')) data={desktopSessionId:'test',tunnelId:'test',nodeId:'echova',relayPath:'/test',state:'connecting'};
   if(path.endsWith('/lock-exit')) {
    await new Promise(resolve=>setTimeout(resolve,100));
    if(fail) return route.fulfill({status:502,json:{error:{message:'无法确认锁屏请求是否送达'}}});
    data={state:'ended',lock:{status:'unknown'}};
   }
   return route.fulfill({json:{apiVersion:'v1',data}});
  });
  const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/devices/echova/desktop');
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  const button=page.getByRole('button',{name:'锁屏并结束连接',exact:true});
  const rect=await button.boundingBox(); assert.ok(rect.x>=0 && rect.x+rect.width<=width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`/tmp/screen-control-lock-${width}.png`});
  await button.click(); await expect(page.getByRole('button',{name:'正在结束…'})).toBeDisabled();
  await expect(page.getByText('锁屏请求已发送，连接已结束；暂无法确认目标是否已锁屏。')).toBeVisible();
  assert.equal(requests.filter(p=>p.endsWith('/lock-exit')).length,1);
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.getByRole('button',{name:'锁屏并结束连接',exact:true})).toHaveCount(0);
  assert.equal(requests.filter(p=>p.endsWith('/lock-exit')).length,1);
  fail=true;
  await page.goto(base+'/devices/echova/desktop');
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  await page.getByRole('button',{name:'锁屏并结束连接',exact:true}).click();
  await expect(page.getByText(/连接已结束，锁屏结果未知/)).toBeVisible();
  assert.equal(requests.filter(p=>p.endsWith('/lock-exit')).length,2);
  assert.deepEqual(errors,[]); await context.close();
 }
 console.log('PASS: 显式锁屏、返回不锁屏、失败不误报、重复点击防护与 1440/390/320 布局');
} finally {await browser.close();}

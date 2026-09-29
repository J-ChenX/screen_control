// 由 gateway_smoke.py 提供隔离 HTTPS 网关与临时访问密钥。
import fs from 'node:fs';
import { launchBrowser, expect, screenshotPath } from '../support/browser.mjs';
const browser = await launchBrowser();
try {
 const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 const origin='https://127.0.0.1:18792';const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/control/snapshot',route=>route.fulfill({json:{apiVersion:'v1',data:{mode:'g0-live',devices:['echova','nix'].map(id=>({id,name:id,platform:'Ubuntu',role:'测试设备',state:'online',nodeId:id,pathLabel:'测试',observedAt:'测试'}))}}}));
 await page.route('**/api/v1/vendor/**',async route=>route.fulfill({contentType:'text/javascript',body:`
 window.CreateAgentRemoteDesktop=()=>({KeyAction:{SCROLL:1,DOWN:1,UP:2},GrabMouseInput(){},GrabKeyInput(){},UnGrabMouseInput(){},UnGrabKeyInput(){},SendMouseMsg(){}});
 window.CreateAgentRedirect=(_a,m)=>{const r={m,Start(){setTimeout(()=>r.onStateChanged?.(r,3),10)},Stop(){r.onStateChanged?.(r,0)}};window.testDisconnect=()=>r.onStateChanged(r,0);return r;};
 `}));
 await page.goto(origin);await expect(page.getByRole('heading',{name:'登录私人远控'})).toBeVisible();
 await page.screenshot({path:screenshotPath('gateway-login.png'),fullPage:true});
 await page.getByLabel('设备访问密钥').fill(fs.readFileSync(process.env.TEST_KEY_FILE,'utf8'));await page.getByRole('button',{name:'验证并进入'}).click();
 await expect(page.getByRole('button',{name:'退出登录'})).toBeVisible();
 const identity=await page.evaluate(()=>fetch('/api/v1/identity/device').then(r=>r.json()));if(identity.data.deviceId!=='nix'||identity.data.accessMode!=='gateway')throw Error('wrong identity');
 let created=0;
 await page.route('**/api/v1/desktops',route=>{created++;return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({apiVersion:'v1',data:{desktopSessionId:'test-'+created,nodeId:'node/server',tunnelId:'test',relayPath:'/api/v1/desktops/test/relay',state:'connecting'}})})});
 await page.route('**/api/v1/desktops/*/end',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({apiVersion:'v1',data:{state:'ended'}})}));
 await page.route('**/api/v1/desktops/*/lock-exit',route=>route.fulfill({json:{apiVersion:'v1',data:{state:'ended',lock:{status:'unknown'}}}}));
 await page.goto(origin+'/devices/echova/desktop');await expect(page.getByText('实机桌面已连接',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.testDisconnect());await expect.poll(()=>created).toBe(2);await expect(page.getByText('实机桌面已连接',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'锁屏并结束连接',exact:true}).click();await page.waitForTimeout(2200);if(created!==2)throw Error('manual stop reconnected');
 await page.goto(origin+'/settings/security');await page.getByRole('button',{name:'退出登录'}).first().click();await expect(page.getByRole('heading',{name:'登录私人远控'})).toBeVisible();
 const result=await context.request.get(origin+'/api/v1/health');if(result.status()!==401)throw Error('logout did not revoke');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Browser PASS: HTTPS login, registered identity, mocked desktop reconnect, manual stop, logout and revoked API.');
}finally{await browser.close()}

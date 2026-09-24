// 被动内存探针：不注入远端输入、不保存屏幕或文件内容，不触发锁屏。
// SCREEN_CONTROL_ENV_FILE=<套件 tailscale.env> ./ops/with-env mise exec -- node tests/performance/desktop-memory.mjs nix
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '../../web/node_modules/@playwright/test/index.mjs';
const origin = process.env.SCREEN_CONTROL_CANONICAL_ORIGIN;
const target = process.argv[2];
if (!origin || !['nix','echova','jiang-chenx','lerrem'].includes(target)) throw new Error('需要可信门户和登记目标');
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', headless: true, args:['--no-sandbox'] });
const browserCDP = await browser.newBrowserCDPSession();
async function memory(page, cdp) {
  const heap = await cdp.send('Runtime.getHeapUsage');
  const processes = await browserCDP.send('SystemInfo.getProcessInfo');
  let pssKiB=0;
  for (const p of processes.processInfo) {
    const smaps = await readFile(`/proc/${p.id}/smaps_rollup`,'utf8').catch(()=> '');
    pssKiB += Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1] || 0);
  }
  return { heapBytes:heap.usedSize, browserPssKiB:pssKiB, ...await page.evaluate(()=>({draws:window.memoryProbe.draws,liveBitmaps:window.memoryProbe.liveBitmaps,width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height})) };
}
try {
 for (const width of [1440,390]) {
  const context = await browser.newContext({viewport:{width,height:900}});
  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  const sessions = new Set(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async response=>{
    if(new URL(response.url()).pathname==='/api/v1/desktops' && response.request().method()==='POST' && response.ok()) {
      sessions.add((await response.json()).data.desktopSessionId);
    }
  });
  await page.addInitScript(()=>{
    window.memoryProbe={draws:0,liveBitmaps:0};
    const create=window.createImageBitmap.bind(window);
    window.createImageBitmap=async(...args)=>{
      const bitmap=await create(...args);window.memoryProbe.liveBitmaps++;
      const close=bitmap.close.bind(bitmap);let closed=false;
      bitmap.close=()=>{if(!closed){closed=true;window.memoryProbe.liveBitmaps--;}close();};return bitmap;
    };
    let factory;
    Object.defineProperty(window,'CreateAgentRemoteDesktop',{configurable:true,get:()=>factory,set:original=>{
      factory=(...args)=>{
        const module=original(...args);
        module.GrabMouseInput=module.GrabKeyInput=module.SendMouseMsg=module.SendKeyMsgKC=module.SendStringUnicode=()=>{};
        const draw=module.Canvas.drawImage.bind(module.Canvas);
        module.Canvas.drawImage=(...args)=>{window.memoryProbe.draws++;return draw(...args);};
        return module;
      };
    }});
  });
  try {
    const identity=await context.request.get(origin+'/api/v1/identity/device');
    assert.ok(identity.ok());assert.notEqual((await identity.json()).data.deviceId,target);
    await page.goto(origin+`/devices/${target}/desktop`);
    for(let cycle=0;cycle<3;cycle++) {
      if(cycle) await page.getByRole('button',{name:'重新连接',exact:true}).click();
      await expect(page.getByRole('status',{name:'实机桌面已连接',exact:true})).toBeVisible({timeout:30000});
      await page.waitForFunction(()=>window.memoryProbe.draws>0,null,{timeout:15000});
      if(cycle===1) await page.getByRole('button',{name:'流畅：关',exact:true}).click();
      await page.waitForTimeout(5000);
      const active=await memory(page,cdp);
      // 普通结束接口断开中继，随后取消自动恢复，绝不点锁屏按钮。
      await page.route('**/api/v1/desktops',route=>route.abort());
      for(const id of sessions) assert.ok((await context.request.post(origin+`/api/v1/desktops/${id}/end`,{data:{},headers:{Origin:origin}})).ok());
      sessions.clear();
      // 保留组件以验证停止时归还画布；拦截下一次自动建连后使用“结束连接”。
      await expect(page.getByRole('button',{name:'重新连接',exact:true})).toBeVisible({timeout:10000});
      const end=page.getByRole('button',{name:'结束连接',exact:true});
      if(await end.isVisible()) await end.click();
      await page.unroute('**/api/v1/desktops');
      await page.waitForTimeout(500);
      await cdp.send('HeapProfiler.collectGarbage');
      const ended=await memory(page,cdp);
      assert.equal(ended.liveBitmaps,0);
      console.log(JSON.stringify({target,width,cycle,active,ended}));
    }
    assert.deepEqual(errors,[]);
  } finally {
    await page.goto('about:blank').catch(()=>{});
    for(const id of sessions) await context.request.post(origin+`/api/v1/desktops/${id}/end`,{data:{},headers:{Origin:origin}}).catch(()=>{});
    await context.close();
  }
 }
} catch(error) {
 console.error('内存探针失败：'+String(error.message).replace(/https?:\/\/[^\s)]+/g,'<门户>').slice(0,300));process.exitCode=1;
} finally {await browser.close();}

// 被动实机故障回归：只在本探针浏览器内注入图块，不发送键鼠、不保存屏幕、不锁屏。
// 验证解码失败和突发积压后使用同一会话自动恢复真实画面。
import assert from 'node:assert/strict';
import { launchBrowser, expect } from '../support/browser.mjs';
const origin=process.env.SCREEN_CONTROL_CANONICAL_ORIGIN, target=process.argv[2];
if(!origin || !['nix','echova','jiang-chenx','lerrem'].includes(target)) throw new Error('需要可信入口和登记目标');
const browser=await launchBrowser();
const context=await browser.newContext({viewport:{width:1440,height:900}});
const sessions=new Set(),errors=[];let creates=0,ends=0;const page=await context.newPage();
try {
 const identity=await context.request.get(origin+'/api/v1/identity/device');assert.ok(identity.ok());assert.notEqual((await identity.json()).data.deviceId,target);
 await page.addInitScript(()=>{
  const p=window.recoveryProbe={draws:0,live:0,peakLive:0,decoding:0,peakDecoding:0,pause:0,resume:0,refresh:0,failNext:false,delay:0};
  const original=window.createImageBitmap.bind(window);
  window.createImageBitmap=async(...args)=>{
   p.decoding++;p.peakDecoding=Math.max(p.peakDecoding,p.decoding);
   try {
    if(p.delay) await new Promise(r=>setTimeout(r,p.delay));
    if(p.failNext){p.failNext=false;throw new Error('测试注入解码失败');}
    const b=await original(...args);p.live++;p.peakLive=Math.max(p.peakLive,p.live);
    const close=b.close.bind(b);let closed=false;b.close=()=>{if(!closed){closed=true;p.live--;}close();};return b;
   }finally{p.decoding--;}
  };
  let factory;Object.defineProperty(window,'CreateAgentRemoteDesktop',{configurable:true,get:()=>factory,set:f=>{
   factory=(...args)=>{
    const m=f(...args);window.recoveryModule=m;
    m.GrabMouseInput=m.GrabKeyInput=m.SendMouseMsg=m.SendKeyMsgKC=m.SendStringUnicode=()=>{};
    for(const [method,key] of [['SendPause','pause'],['SendUnPause','resume'],['SendRefresh','refresh']]){
     const fn=m[method].bind(m);m[method]=(...args)=>{p[key]++;return fn(...args);};
    }
    const draw=m.Canvas.drawImage.bind(m.Canvas);m.Canvas.drawImage=(...args)=>{const r=draw(...args);p.draws++;return r;};return m;
   };
  }});
 });
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/v1/desktops'&&r.request().method()==='POST'&&r.ok()){creates++;sessions.add((await r.json()).data.desktopSessionId);}});
 page.on('request',r=>{if(/\/api\/v1\/desktops\/[^/]+\/end$/.test(new URL(r.url()).pathname))ends++;});
 await page.goto(origin+`/devices/${target}/desktop`);
 await expect(page.getByRole('status',{name:'实机桌面已连接',exact:true})).toBeVisible({timeout:30000});
 await page.waitForFunction(()=>window.recoveryProbe.draws>0);
 const baseline=await page.evaluate(()=>({...window.recoveryProbe}));
 for(let cycle=0;cycle<12;cycle++){
  const before=await page.evaluate(async cycle=>{
   const p=window.recoveryProbe,m=window.recoveryModule, before={draws:p.draws,refresh:p.refresh};
   if(cycle%2===0){p.failNext=true;m.ProcessPictureMsg(new Uint8Array([0,0,0,0,1,2,3]),0,0);}
   else{
    p.delay=100;
    const c=document.createElement('canvas');c.width=c.height=8;
    const blob=await new Promise(r=>c.toBlob(r,'image/jpeg'));
    const b=new Uint8Array(await blob.arrayBuffer()), data=new Uint8Array(b.length+4);data.set(b,4);
    for(let i=0;i<1000;i++)m.ProcessPictureMsg(data,0,0);
    setTimeout(()=>{p.delay=0;},150);
   }
   return before;
  },cycle);
  await page.waitForFunction(b=>window.recoveryProbe.refresh>b.refresh,before,{timeout:15000});
  await page.waitForFunction(b=>window.recoveryProbe.draws>b.draws,before,{timeout:15000});
  await expect(page.getByRole('status',{name:'实机桌面已连接',exact:true})).toBeVisible();
  await page.waitForTimeout(300);
 }
 const result=await page.evaluate(()=>({...window.recoveryProbe,width:document.querySelector('canvas').width,height:document.querySelector('canvas').height,state:window.recoveryModule.State}));
 assert.equal(creates,1);assert.equal(ends,0);assert.equal(result.state,3);assert.equal(result.peakLive,1);assert.equal(result.peakDecoding,1);assert.deepEqual(errors,[]);
 assert.ok(result.refresh>=baseline.refresh+12);assert.ok(result.width>1);
 console.log(JSON.stringify({target,cycles:12,creates,ends,result}));
 await page.goto('about:blank');
} catch(e){console.error(String(e.message).replace(/https?:\/\/[^\s)]+/g,'<门户>').slice(0,450));process.exitCode=1;}
finally{
 await page.goto('about:blank').catch(()=>{});
 for(const id of sessions)await context.request.post(origin+`/api/v1/desktops/${id}/end`,{data:{},headers:{Origin:origin}}).catch(()=>{});
 await context.close();await browser.close();
}

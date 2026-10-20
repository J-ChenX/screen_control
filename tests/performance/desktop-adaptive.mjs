// 实际 C 整帧输出通过实际协议组件绘制，检查尺寸切换、像素与逐帧输入绑定。
// 参数：desktop-adaptive C harness 可执行文件、公开协议脚本目录。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser } from '../support/browser.mjs';
import { desktopMemoryScript } from '../support/desktop-script.mjs';
const binary=process.argv[2],directory=process.argv[3];
if(!binary||!directory)throw new Error('需要 C 整帧检查程序和公开协议目录');
const capture=spawnSync(binary,['--wire'],{maxBuffer:16*1024*1024});
assert.equal(capture.status,0,capture.stderr.toString());
const frames=[];let offset=0;
while(offset<capture.stdout.length){const size=capture.stdout.readUInt32BE(offset);offset+=4;assert.ok(size>48&&offset+size<=capture.stdout.length);frames.push(Array.from(capture.stdout.subarray(offset,offset+size)));offset+=size;}
assert.equal(frames.length,4);
const script=await desktopMemoryScript(),browser=await launchBrowser();
try{
 const page=await browser.newPage();
 for(const name of ['common.js','agent-desktop.js'])await page.addScriptTag({content:readFileSync(resolve(directory,name),'utf8')});
 await page.addScriptTag({content:script});
 const result=await page.evaluate(async frames=>{
  const canvas=document.createElement('canvas');canvas.width=2560;canvas.height=1440;canvas.style.width='960px';canvas.style.height='540px';document.body.style.margin='0';document.body.append(canvas);
  const module=CreateAgentRemoteDesktop(canvas);module.State=3;
  const sent=[];module.send=packet=>sent.push([...packet].map(char=>char.charCodeAt(0)));
  const native=createImageBitmap;let delay=40,live=0,peak=0;
  window.createImageBitmap=async(...args)=>{await new Promise(r=>setTimeout(r,delay));const image=await native(...args);live++;peak=Math.max(peak,live);const close=image.close.bind(image);image.close=()=>{live--;close();};return image;};
  const dispose=manageDesktopMemory(module,canvas,{platform:'Ubuntu',smooth:false});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));const results=[];
  for(const encoded of frames){
   const bytes=new Uint8Array(encoded),metadata=bytes.subarray(0,40),view=new DataView(metadata.buffer),w=view.getUint16(20),h=view.getUint16(22);
   const jpegOffset=(bytes[40]===0&&bytes[41]===27)?56:48;
   const pictureHeader=jpegOffset-8;const picture=bytes.subarray(pictureHeader);
   // jumbo 内层图片头的长度字段为零；实际组件由外层传入完整长度。
   const before={width:canvas.width,height:canvas.height};
   module.ProcessBinaryCommand(0x7f00,40,metadata);module.ProcessBinaryCommand(3,picture.length,picture);
   if(before.width!==w) {if(canvas.width!==before.width||canvas.height!==before.height)throw new Error('新尺寸在完整帧解码前清空了画面');}
   const deadline=performance.now()+3000;
   while(!sent.some(packet=>packet[0]===127&&packet[1]===1&&packet[11]===view.getUint32(12))&&performance.now()<deadline)await sleep(5);
   if(canvas.width!==w||canvas.height!==h)throw new Error('完整画面尺寸未提交');
   const reference=document.createElement('canvas');reference.width=w;reference.height=h;
   const bitmap=await native(new Blob([bytes.subarray(jpegOffset)],{type:'image/jpeg'}));reference.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
   const a=canvas.getContext('2d').getImageData(0,0,w,h).data,b=reference.getContext('2d').getImageData(0,0,w,h).data;let different=0;
   for(let i=0;i<a.length;i++)different+=Number(a[i]!==b[i]);
   module.SendMouseMsg(module.KeyAction.DOWN,{pageX:480,pageY:270,button:0});
   const mouse=sent.filter(packet=>packet[0]===0&&packet[1]===2).at(-1);const mv=new DataView(new Uint8Array(mouse).buffer);
   if(mouse.length!==20||mv.getUint32(12)!==view.getUint32(8)||mv.getUint32(16)!==view.getUint32(12))throw new Error('鼠标未绑定已展示帧');
   results.push({width:w,height:h,differingChannels:different,mouseLength:mouse.length});
  }
  dispose();window.createImageBitmap=native;
  return {results,retainedBitmaps:live,peakBitmaps:peak,canvasReleased:canvas.width===1&&canvas.height===1};
 },frames);
 assert.equal(result.retainedBitmaps,0);assert.ok(result.canvasReleased);assert.ok(result.results.every(r=>r.differingChannels===0));
 console.log(JSON.stringify({browser:browser.version(),nativeFrames:frames.length,...result}));
}finally{await browser.close();}

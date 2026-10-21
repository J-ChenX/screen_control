// 隔离验证画质切换与桌面、手机布局，不连接真实目标。
import assert from 'node:assert/strict';
import { launchBrowser, expect, testOrigin, screenshotPath } from '../support/browser.mjs';
import { desktopMemoryScript } from '../support/desktop-script.mjs';
const base = testOrigin();
const browser = await launchBrowser();
function protocol() {
  window.settings = []; window.refreshes = 0;
  window.CreateAgentRemoteDesktop = () => ({ protocol: 2, GrabMouseInput() {}, GrabKeyInput() {}, UnGrabMouseInput() {}, UnGrabKeyInput() {}, SendCompressionLevel(...args) { window.settings.push(args); }, SendRefresh() { window.refreshes++; } });
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
  assert.deepEqual(await page.evaluate(()=>window.settings),[[1,90,1024,40]]);
  await page.getByRole('button',{name:'流畅：关',exact:true}).click();
  await expect(page.getByRole('button',{name:'流畅：开',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'锁屏并结束连接',exact:true}).click();
  await page.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(page.getByRole('status',{name:'实机桌面已连接'})).toBeVisible();
  await page.getByRole('button',{name:'流畅：开',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.settings),[[1,90,1024,40],[1,85,1024,40],[1,85,1024,40],[1,90,1024,40]]);
  assert.equal(await page.evaluate(()=>window.refreshes), 2);
  await expect(page.getByRole('button',{name:'流畅：关',exact:true})).toHaveAttribute('title', /自动/);
  for (const name of ['流畅：关','文件传输','锁屏并结束连接']) {
    const button=page.getByRole('button',{name,exact:true});
    const rect=await button.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=width);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:screenshotPath(`screen-control-performance-${width}.png`)});
  assert.deepEqual(errors,[]);
  await context.close();
 }
 // 使用实际画布、JPEG 解码和图块管理器，验证活动检测确实进入自动策略。
 const memoryScript = await desktopMemoryScript();
 for (const scenario of [
   { name: '小范围变化保留清晰', moving: false, ackMs: 280, duration: 6000, tier: 1440 },
   { name: '大面积运动优先延迟', moving: true, ackMs: 280, duration: 2400, tier: 1080 },
   { name: '健康动态保持高清', moving: true, ackMs: 20, duration: 4000, tier: 1440 },
   { name: '高动态处理过慢时降档', moving: true, ackMs: 20, processingMs: 220, duration: 2400, tier: 1080 },
   { name: '数秒才收到一帧时仍保护持续拥塞', moving: true, ackMs: 2500, interval: 3750, duration: 15000, tier: 540 },
   { name: '固定分辨率独立调节压缩与采集', moving: true, ackMs: 260, resolution: 1440, duration: 6000, tier: 1440 },
   { name: '静止后补高清完整基准', moving: false, ackMs: 20, smooth: true, resolution: 1080, idleFor: 10000, duration: 1000, tier: 1080 },
   { name: '动态转静态后恢复清晰度', moving: true, ackMs: 280, quietAfter: 2000, duration: 11600, tier: 1440 },
 ]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<canvas width="2560" height="1440"></canvas>');
  await page.addScriptTag({ content: memoryScript });
  const result = await page.evaluate(async scenario => {
    const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
    const realNow = performance.now.bind(performance), sampling = [];
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    for (const [name, original] of [['drawImage', drawImage], ['getImageData', getImageData]]) {
      CanvasRenderingContext2D.prototype[name] = function(...args) {
        const start = realNow();
        try { return original.apply(this, args); }
        finally { if (this.canvas.width === 32 && this.canvas.height === 18) sampling.push(realNow() - start); }
      };
    }
    let now = 0, tick, drawn;
    Object.defineProperty(performance, 'now', { value: () => now });
    window.setInterval = callback => { tick = callback; return 0; };
    const images = [];
    for (const color of ['black', 'white']) {
      context.fillStyle = 'black'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = color;
      context.fillRect(0, 0, scenario.moving ? canvas.width : 40, scenario.moving ? canvas.height : 40);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
      const packet = new Uint8Array(4 + blob.size); packet.set(new Uint8Array(await blob.arrayBuffer()), 4); images.push(packet);
    }
    const settings = [];
    const module = {
      State: 3, tilesReceived: 0, TilesDrawn: 0, KillDraw: 0, PendingOperations: [],
      ProcessBinaryCommand() {}, ProcessPictureMsg() {}, send() {},
      SendCompressionLevel(...args) { settings.push(args); }, SendRefresh() {}, SendPause() {}, SendUnPause() {},
      DoPendingOperations() {
        const index = this.PendingOperations.findIndex(op => op[0] === this.TilesDrawn + 1);
        if (index < 0) return false;
        const [operation] = this.PendingOperations.splice(index, 1); this.TilesDrawn++;
        if (operation[1] === 2) { context.drawImage(operation[2], 0, 0); drawn?.(); }
        return true;
      },
    };
    const dispose = window.manageDesktopMemory(module, canvas, { platform: 'Ubuntu', smooth: scenario.smooth ?? false, resolution: scenario.resolution });
    for (let sequence = 1; now <= scenario.duration; now += scenario.interval ?? 200, sequence++) {
      const packet = new Uint8Array(40), view = new DataView(packet.buffer);
      for (const [offset, value] of [[0, 0x7f00], [2, 40], [4, 1], [6, 3], [16, 2560], [18, 1440], [20, 2560], [22, 1440], [24, 1440], [26, 90]]) view.setUint16(offset, value);
      const quiet = scenario.quietAfter !== undefined && now > scenario.quietAfter;
      view.setUint32(8, 1); view.setUint32(12, sequence); view.setUint32(28, scenario.processingMs ?? 25); view.setUint32(32, quiet ? 220 : scenario.ackMs);
      const completed = new Promise(resolve => { drawn = resolve; });
      module.ProcessBinaryCommand(0x7f00, 40, packet);
      module.ProcessPictureMsg(images[quiet ? 0 : sequence % 2], 0, 0);
      await completed; tick();
    }
    if (scenario.idleFor) {
      const end = now + scenario.idleFor;
      for (; now <= end; now += 200) tick();
    }
    const tier = settings.at(-1)[2]; dispose();
    return { tier, settings, tiers: settings.map(setting => setting[2]).filter((value, index, all) => index === 0 || value !== all[index - 1]), samplingCalls: sampling.length, samplingMs: sampling.reduce((sum, value) => sum + value, 0), released: canvas.width * canvas.height === 1 };
  }, scenario);
  assert.equal(result.tier, scenario.tier, scenario.name);
  if (scenario.quietAfter !== undefined) assert.deepEqual(result.tiers, [1440, 1080, 1440]);
  if (scenario.ackMs >= 160 && !scenario.interval) {
    assert.ok(result.settings.some(setting => setting[1] < 90), `${scenario.name} 未调整 JPEG`);
    assert.ok(result.settings.some(setting => setting[3] > 40), `${scenario.name} 未调整采集间隔`);
  }
  if (scenario.processingMs) assert.ok(result.settings.filter(setting => setting[2] === 1440).every(setting => setting[1] === 90));
  if (scenario.idleFor) { assert.equal(result.settings.at(-1)[1], 90); assert.equal(result.settings.length, 2); }
  assert.ok(result.settings.every(setting => setting[1] >= 60 && setting[1] <= 90 && [40, 60, 80, 120].includes(setting[3])));
  assert.ok(result.samplingCalls > 0); assert.equal(result.released, true);
  console.log(`通过：${scenario.name}，采样绘制／读取 ${result.samplingCalls} 次共 ${result.samplingMs.toFixed(1)}ms`);
  await context.close();
 }
 console.log('PASS: 自动策略活动检测、画质切换、重连保留与 1440/390/320 布局。');
} finally { await browser.close(); }

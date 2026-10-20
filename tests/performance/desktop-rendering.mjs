// 使用实际协议绘制组件对照图块延迟和像素顺序；只处理合成图像，不连接桌面。
// 参数：公开协议脚本目录，可选的旧版 memory.ts 路径。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { desktopMemoryScript } from '../support/desktop-script.mjs';
import { resolve } from 'node:path';
import { launchBrowser } from '../support/browser.mjs';

const vendorDirectory = process.argv[2];
if (!vendorDirectory) throw new Error('需要指定包含 common.js 和 agent-desktop.js 的公开协议脚本目录');
const current = resolve(import.meta.dirname, '../../web/src/features/desktop/memory.ts');
const sources = process.argv[3] ? [['baseline', process.argv[3]], ['current', current]] : [['current', current]];
const browser = await launchBrowser();
const results = [];
try {
  for (const [variant, file] of sources) {
    const source = await desktopMemoryScript(file);
    for (let round = 0; round < 3; round++) {
      const page = await browser.newPage();
      for (const name of ['common.js', 'agent-desktop.js']) await page.addScriptTag({ content: readFileSync(resolve(vendorDirectory, name), 'utf8') });
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 32;
        const expected = document.createElement('canvas'); expected.width = 96; expected.height = 32;
        const tile = document.createElement('canvas'); tile.width = tile.height = 32;
        const colors = ['#fff', '#000', '#e52b36', '#2455df'];
        const pictures = [], bitmaps = [];
        const nativeCreate = createImageBitmap;
        for (const color of colors) {
          const ctx = tile.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 32);
          const blob = await new Promise(resolve => tile.toBlob(resolve, 'image/jpeg', .85));
          const bytes = new Uint8Array(4 + blob.size); bytes.set(new Uint8Array(await blob.arrayBuffer()), 4);
          pictures.push(bytes); bitmaps.push(await nativeCreate(blob));
        }
        const module = CreateAgentRemoteDesktop(canvas); module.State = 3; module.send = () => {};
        let draws = 0, live = 0, peak = 0, pause = 0, refresh = 0;
        const originalDraw = module.Canvas.drawImage.bind(module.Canvas);
        module.Canvas.drawImage = (...args) => { originalDraw(...args); draws++; };
        module.SendPause = () => { pause++; }; module.SendRefresh = () => { refresh++; };
        const nativeClose = ImageBitmap.prototype.close;
        ImageBitmap.prototype.close = function () { live--; nativeClose.call(this); };
        window.createImageBitmap = async (...args) => {
          // 固定延迟仅模拟受限控制端，不代表真实设备的解码耗时。
          await sleep(15); const bitmap = await nativeCreate(...args); live++; peak = Math.max(peak, live); return bitmap;
        };
        const dispose = manageDesktopMemory(module, canvas);
        const begin = performance.now();
        for (let i = 0; i < 60; i++) {
          const index = i % colors.length, x = i % 3 * 32;
          expected.getContext('2d').drawImage(bitmaps[index], x, 0);
          module.ProcessPictureMsg(pictures[index], x, 0);
        }
        const deadline = begin + 5000;
        while (draws < 60 && performance.now() < deadline) await sleep(5);
        const elapsedMs = performance.now() - begin;
        const actual = canvas.getContext('2d').getImageData(0, 0, 96, 32).data;
        const reference = expected.getContext('2d').getImageData(0, 0, 96, 32).data;
        let differingChannels = 0;
        for (let i = 0; i < actual.length; i++) differingChannels += Number(actual[i] !== reference[i]);
        dispose();
        const retainedBitmaps = live;
        window.createImageBitmap = nativeCreate; ImageBitmap.prototype.close = nativeClose;
        bitmaps.forEach(bitmap => bitmap.close());
        return { elapsedMs: Math.round(elapsedMs), draws, peakBitmaps: peak, retainedBitmaps, differingChannels, pause, refresh, canvasReleased: canvas.width === 1 && canvas.height === 1 };
      });
      assert.equal(result.draws, 60); assert.equal(result.differingChannels, 0); assert.equal(result.retainedBitmaps, 0); assert.ok(result.canvasReleased);
      if (variant === 'current') assert.ok(result.peakBitmaps <= 4);
      results.push({ variant, round, ...result }); await page.close();
    }
  }
  const median = variant => results.filter(result => result.variant === variant).map(result => result.elapsedMs).sort((a, b) => a - b)[1];
  const summary = { browser: browser.version(), simulatedDecodeMs: 15, queuedTiles: 60, currentMedianMs: median('current'), results };
  if (process.argv[3]) {
    summary.baselineMedianMs = median('baseline');
    summary.improvementPercent = Math.round((1 - summary.currentMedianMs / summary.baselineMedianMs) * 100);
    assert.ok(summary.currentMedianMs < summary.baselineMedianMs * .75, '相同受限解码负载必须至少降低四分之一排空时间');
  }
  console.log(JSON.stringify(summary));
} finally { await browser.close(); }

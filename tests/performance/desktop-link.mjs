// 真实编码参数→C JPEG→隔离限速通道→实际组件→ACK；仅合成负载，不修改系统网络。
// 参数：基线/候选 C 驱动、基线 memory.ts、公开协议目录；可选场景与活动/安静时长。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { launchBrowser } from '../support/browser.mjs';
import { desktopMemoryScript } from '../support/desktop-script.mjs';

const [baseline, candidate, baselineEntry, vendor, only, activeArg, quietArg] = process.argv.slice(2);
assert.ok(baseline && candidate && baselineEntry && vendor, '需要两份 C 驱动、基线入口和协议目录');
const activeMs = Number(activeArg || 12000), quietMs = Number(quietArg || 12000);
const bandwidthMbps = 12, oneWayMs = 20;
const scripts = [await desktopMemoryScript(baselineEntry), await desktopMemoryScript()];
const browser = await launchBrowser();
const results = [];
try {
  for (const scenario of only ? [only] : ['local', 'static', 'scroll', 'motion']) {
    assert.ok(['local', 'static', 'scroll', 'motion'].includes(scenario));
    for (const [mode, binary, script] of [['baseline', baseline, scripts[0]], ['candidate', candidate, scripts[1]]]) {
      const process = spawn(binary, [scenario], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buffered = Buffer.alloc(0), pending = null, stderr = '', peakRssKiB = 0;
      process.stderr.on('data', data => { stderr += data; });
      process.stdout.on('data', data => {
        buffered = Buffer.concat([buffered, data]);
        if (buffered.length < 8 || buffered.length < 8 + buffered.readUInt32BE(0)) return;
        const size = buffered.readUInt32BE(0), processingMs = buffered.readUInt32BE(4) / 1000;
        const wire = buffered.subarray(8, size + 8).toString('base64');
        buffered = buffered.subarray(size + 8);
        const complete = pending; pending = null; clearTimeout(complete.timer); complete.resolve({ wire, bytes: size, processingMs });
      });
      const fail = error => { if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
      process.on('error', fail);
      process.on('exit', code => fail(new Error(`C 驱动提前退出：${code} ${stderr}`)));
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.exposeFunction('captureNative', config => new Promise((complete, reject) => {
          assert.equal(pending, null);
          pending = { resolve: complete, reject, timer: setTimeout(() => fail(new Error('C 编码响应超时')), 8000) };
          try {
            const status = readFileSync(`/proc/${process.pid}/status`, 'utf8');
            peakRssKiB = Math.max(peakRssKiB, Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0));
            process.stdin.write(`${config.index} ${config.quality} 1440 ${config.delta} ${config.force} ${config.epoch} ${config.sequence}\n`);
          } catch (error) { fail(error); }
        }));
        for (const name of ['common.js', 'agent-desktop.js']) await page.addScriptTag({ content: readFileSync(resolve(vendor, name), 'utf8') });
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(async ({ scenario, activeMs, quietMs, bandwidthMbps, oneWayMs }) => {
          const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440; document.body.append(canvas);
          const module = CreateAgentRemoteDesktop(canvas); module.State = 3;
          let config = { quality: scenario === 'static' ? 85 : 90, interval: 40, delta: 0, force: 0 };
          let epoch = 0, sequence = 0, live = 0, peakBitmaps = 0, decoders = 0, peakDecoders = 0;
          let pendingFrames = 0, peakFrames = 0, bytes = 0, deltaFrames = 0, resetRequests = 0;
          const settings = [], processing = [], latency = [], intervals = [], infos = new Map(), deliveries = [];
          const nativeBitmap = createImageBitmap, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
          let lastPresented, lastPresentation = 0, presented = 0;
          window.createImageBitmap = async (...args) => {
            decoders++; peakDecoders = Math.max(peakDecoders, decoders);
            try {
              const bitmap = await nativeBitmap(...args); live++; peakBitmaps = Math.max(peakBitmaps, live);
              const close = bitmap.close.bind(bitmap); bitmap.close = () => { live--; close(); }; return bitmap;
            } finally { decoders--; }
          };
          const started = performance.now();
          module.send = packet => {
            const data = Uint8Array.from(packet, char => char.charCodeAt(0)), view = new DataView(data.buffer), command = view.getUint16(0);
            if (command === 5) {
              config = { quality: data[5], interval: view.getUint16(8), delta: data[4] === 130 ? 1 : 0, force: 1 };
              settings.push({ atMs: performance.now() - started, ...config });
            } else if (command === 6 || command === 0x7f05) { config.force = 1; if (command === 0x7f05) resetRequests++; }
            else if (command === 0x7f01 || command === 0x7f03) {
              const e = view.getUint32(4), s = view.getUint32(8), info = infos.get(s);
              if (command === 0x7f01 && info) {
                const now = performance.now(); latency.push(now - info.captured); presented++;
                if (lastPresentation && info.atMs < activeMs) intervals.push(now - lastPresentation);
                lastPresentation = now; lastPresented = info;
              }
              setTimeout(() => { epoch = e; sequence = Math.max(sequence, s); pendingFrames--; }, oneWayMs);
            }
          };
          const dispose = manageDesktopMemory(module, canvas, { platform: 'Ubuntu', smooth: scenario === 'static', resolution: 1440 });
          let linkFree = started, captures = 0;
          while (performance.now() - started < activeMs + quietMs) {
            const now = performance.now(), atMs = now - started, index = Math.floor(Math.min(atMs, activeMs) / 40);
            const parameters = { ...config, index, epoch, sequence }; config.force = 0;
            const packet = await window.captureNative(parameters); captures++;
            if (packet.bytes) {
              const raw = Uint8Array.from(atob(packet.wire), c => c.charCodeAt(0));
              const view = new DataView(raw.buffer), cap = view.getUint16(0) === 0x7f04 ? 8 : 0, size = view.getUint16(cap + 2);
              const frame = new DataView(raw.buffer, cap, size), s = frame.getUint32(12);
              const jumbo = view.getUint16(cap + size) === 27, picture = raw.subarray(cap + size + (jumbo ? 8 : 0));
              const info = { captured: now, atMs, index, quality: frame.getUint16(26), width: frame.getUint16(20), height: frame.getUint16(22) };
              infos.set(s, info); pendingFrames++; peakFrames = Math.max(peakFrames, pendingFrames);
              bytes += packet.bytes; processing.push(packet.processingMs); deltaFrames += Number((frame.getUint16(6) & 4) !== 0);
              linkFree = Math.max(linkFree, performance.now()) + packet.bytes * 8 / (bandwidthMbps * 1000);
              deliveries.push(new Promise(resolve => setTimeout(() => {
                if (cap) module.ProcessBinaryCommand(0x7f04, 8, raw.subarray(0, 8));
                module.ProcessBinaryCommand(0x7f00, size, raw.subarray(cap, cap + size));
                module.ProcessBinaryCommand(3, picture.length, picture); resolve();
              }, Math.max(0, linkFree + oneWayMs - performance.now()))));
            }
            await sleep(Math.max(1, parameters.interval - (performance.now() - now)));
          }
          await Promise.all(deliveries);
          const until = performance.now() + 8000;
          while (pendingFrames && performance.now() < until) await sleep(10);
          assertResult(pendingFrames === 0 && lastPresented, '发送窗口未清空');
          const channels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let error = 0;
          const index = lastPresented.index, left = 640 + index % 12 * 8;
          for (let y = 0; y < 1440; y++) for (let x = 0; x < 2560; x++) for (let c = 0; c < 3; c++) {
            const sy = scenario === 'scroll' ? (y + index * 5) % 1440 : y;
            let value = sy % 24 >= 7 && sy % 24 < 17 && x % 13 >= 3 && x % 13 < 9 ? 35 + c * 12 : 230 + c * 8;
            if (scenario === 'motion') value = (value + index * 17 + Math.floor(x / 32)) & 255;
            if (scenario === 'local' && y >= 416 && y < 480 && x >= left && x < left + 128) value = 70 + index % 3 * 50 + c * 15;
            error += Math.abs(value - channels[(y * 2560 + x) * 4 + c]);
          }
          const percentile = (values, p) => { values.sort((a, b) => a - b); return values[Math.floor((values.length - 1) * p)] ?? null; };
          dispose(); await sleep(50); window.createImageBitmap = nativeBitmap;
          return { bytes, captures, presented, deltaFrames, peakFrames, peakBitmaps, peakDecoders, retainedBitmaps: live,
            canvasReleased: canvas.width === 1, resetRequests, settings, final: lastPresented,
            finalMeanChannelError: error / (2560 * 1440 * 3),
            processingMedianMs: percentile(processing, .5), processingP95Ms: percentile(processing, .95),
            presentationMedianMs: percentile(latency, .5), presentationP95Ms: percentile(latency, .95),
            intervalMedianMs: percentile(intervals, .5), intervalP95Ms: percentile(intervals, .95) };
          function assertResult(ok, message) { if (!ok) throw new Error(message); }
        }, { scenario, activeMs, quietMs, bandwidthMbps, oneWayMs });
        assert.equal(result.retainedBitmaps, 0); assert.ok(result.canvasReleased);
        assert.ok(result.peakFrames <= 2); assert.ok(result.peakBitmaps <= 2); assert.ok(result.peakDecoders <= 2);
        assert.equal(result.final.width, 2560); assert.equal(result.final.height, 1440);
        results.push({ mode, scenario, nativePeakRssKiB: peakRssKiB, ...result });
        console.error(JSON.stringify({ mode, scenario, bytes: result.bytes, presented: result.presented, p95Ms: result.presentationP95Ms, finalQuality: result.final.quality }));
      } finally {
        await page.close();
        if (process.exitCode === null && process.signalCode === null) {
          const exited = once(process, 'exit');
          process.stdin.end('4294967295 0 0 0 0 0 0\n');
          const killer = setTimeout(() => process.kill('SIGKILL'), 5000);
          try { await exited; } finally { clearTimeout(killer); }
        }
        assert.equal(process.exitCode, 0, stderr);
      }
    }
  }
  console.log(JSON.stringify({ browser: browser.version(), bandwidthMbps, oneWayMs, activeMs, quietMs, fixedTier: 1440, results }));
} finally { await browser.close(); }

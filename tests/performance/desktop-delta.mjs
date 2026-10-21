// 实际 C 输出经 MeshCentral 组件连续重建；两帧突发及乱序解码不应破坏增量依赖。
// 参数：desktop-delta C harness、公开协议脚本目录、可选合成场景。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser } from '../support/browser.mjs';
import { desktopMemoryScript } from '../support/desktop-script.mjs';

const [binary, directory, scenario = 'local'] = process.argv.slice(2);
if (!binary || !directory || !['local', 'static', 'scroll', 'motion'].includes(scenario)) throw new Error('需要 C 增量检查程序、公开协议目录及有效场景');
// Windows 的 GDI+ 原生检查可离线提供合成图像包，不保存真实桌面图像。
const capture = binary.endsWith('.wire')
  ? { status: 0, stdout: readFileSync(binary), stderr: readFileSync(binary + '.json') }
  : spawnSync(binary, [scenario, '--wire'], { maxBuffer: 256 * 1024 * 1024 });
assert.equal(capture.status, 0, capture.stderr.toString());
const frames = [];
for (let offset = 0; offset < capture.stdout.length;) {
  const length = capture.stdout.readUInt32BE(offset); offset += 4;
  assert.ok(length > 48 && offset + length <= capture.stdout.length);
  // 使用 base64 避免在传输浏览器检查输入时展开上亿个 JSON 数字。
  frames.push(capture.stdout.subarray(offset, offset + length).toString('base64')); offset += length;
}
const native = JSON.parse(capture.stderr.toString().trim());
if (native.outsideJpegEdges !== undefined) assert.equal(native.outsideJpegEdges, 0);
else assert.equal(native.differentReferenceChannels, 0);
assert.equal(frames.length, native.frames);
if (scenario === 'local' && native.mode !== 0) assert.ok(native.deltaFrames > 0);
const script = await desktopMemoryScript(), browser = await launchBrowser();
try {
  const results = [];
  for (const viewportWidth of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 } });
    for (const name of ['common.js', 'agent-desktop.js']) await page.addScriptTag({ content: readFileSync(resolve(directory, name), 'utf8') });
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async encoded => {
      const packets = encoded.map(value => Uint8Array.from(atob(value), char => char.charCodeAt(0)));
      const inspect = bytes => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0, capability = new Uint8Array();
        while (view.getUint16(offset) !== 0x7f00) {
          const command = view.getUint16(offset), size = view.getUint16(offset + 2);
          if (![7, 0x7f04].includes(command) || size < 4 || offset + size >= bytes.length) throw new Error('首帧前置消息无效');
          if (command === 0x7f04) capability = bytes.subarray(offset, offset + size);
          offset += size;
        }
        const size = view.getUint16(offset + 2), metadata = bytes.subarray(offset, offset + size), m = new DataView(metadata.buffer, metadata.byteOffset, size);
        const jumbo = view.getUint16(offset + size) === 27, pictureOffset = offset + size + (jumbo ? 8 : 0), picture = bytes.subarray(pictureOffset);
        return { capability, metadata, picture, jpeg: picture.subarray(8), sequence: m.getUint32(12), epoch: m.getUint32(8),
          width: m.getUint16(20), height: m.getUint16(22), x: size === 56 ? m.getUint16(40) : 0, y: size === 56 ? m.getUint16(42) : 0 };
      };
      const frames = packets.map(inspect), first = frames[0];
      const canvas = document.createElement('canvas'); canvas.width = first.width; canvas.height = first.height; canvas.style.width = '100%'; document.body.append(canvas);
      const reference = document.createElement('canvas'); reference.width = first.width; reference.height = first.height;
      const ref = reference.getContext('2d', { willReadFrequently: true }), ctx = canvas.getContext('2d', { willReadFrequently: true });
      const module = CreateAgentRemoteDesktop(canvas); module.State = 3;
      const sent = [], acked = [], presented = [], expected = new Map(), latency = [];
      module.send = packet => { const bytes = Uint8Array.from(packet, char => char.charCodeAt(0)); const v = new DataView(bytes.buffer); sent.push(bytes); if (v.getUint16(0) === 0x7f01) acked.push(v.getUint32(8)); };
      const originalBitmap = createImageBitmap, draw = ctx.drawImage.bind(ctx);
      let live = 0, peak = 0, active = 0, peakActive = 0, calls = 0, failNext = false;
      let difference = 0;
      window.createImageBitmap = async (...args) => {
        const call = ++calls; active++; peakActive = Math.max(peakActive, active);
        try {
          if (failNext) { failNext = false; throw new Error('受控解码失败'); }
          await new Promise(resolve => setTimeout(resolve, call % 2 ? 30 : 0));
          const image = await originalBitmap(...args); live++; peak = Math.max(peak, live);
          const close = image.close.bind(image); image.close = () => { live--; close(); }; return image;
        } finally { active--; }
      };
      ctx.drawImage = (...args) => {
        draw(...args);
        const next = expected.entries().next().value;
        if (!next) throw new Error('发生未预期的画面提交');
        const [sequence, { channels, started }] = next, actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        if (actual.length !== channels.length) throw new Error('画面尺寸不符');
        for (let i = 0; i < actual.length; i++) difference += Number(actual[i] !== channels[i]);
        if (difference) throw new Error('逐通道重建不一致');
        presented.push(sequence); latency.push(performance.now() - started); expected.delete(sequence);
      };
      const dispose = manageDesktopMemory(module, canvas, { platform: 'Ubuntu', smooth: false });
      module.SendCompressionLevel(1, 90, 1024, 40); module.SendRefresh();
      if (sent.length) throw new Error('识别能力前发送旧式启动参数');
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const wait = async condition => { const until = performance.now() + 6000; while (!condition()) { if (performance.now() > until) throw new Error('等待展示／恢复超时'); await sleep(5); } };
      const feed = frame => {
        if (frame.capability.length) module.ProcessBinaryCommand(0x7f04, 8, frame.capability);
        module.ProcessBinaryCommand(0x7f00, frame.metadata.length, frame.metadata);
        module.ProcessBinaryCommand(3, frame.picture.length, frame.picture);
      };
      const prepare = async frame => {
        const bitmap = await originalBitmap(new Blob([frame.jpeg], { type: 'image/jpeg' }));
        ref.drawImage(bitmap, frame.x, frame.y); bitmap.close();
        expected.set(frame.sequence, { channels: ref.getImageData(0, 0, reference.width, reference.height).data, started: performance.now() });
      };
      for (let index = 0; index < frames.length; index += 2) {
        const batch = frames.slice(index, index + 2);
        for (const frame of batch) await prepare(frame);
        for (const frame of batch) feed(frame);
        await wait(() => acked.at(-1) === batch.at(-1).sequence);
      }
      if (acked.length !== frames.length || presented.some((value, index) => value !== frames[index].sequence)) throw new Error('增量依赖被跳过或确认顺序错误');
      // 缺少中间依赖必须保留旧画面并丢弃，不能给出展示确认。
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const last = frames.at(-1), broken = inspect(packets.at(-1).slice());
      const bv = new DataView(broken.metadata.buffer, broken.metadata.byteOffset, broken.metadata.length);
      if (broken.metadata.length === 56 && (bv.getUint16(6) & 4)) {
        const mouse = button => module.send(String.fromCharCode(0, 2, 0, 10, 0, button, 0, 32, 0, 32));
        for (const button of [2, 8, 32]) mouse(button);
        bv.setUint32(12, last.sequence + 1); bv.setUint32(36, last.sequence - 1);
        feed(broken); await wait(() => sent.some(packet => new DataView(packet.buffer).getUint16(0) === 0x7f05));
        const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        if (after.some((value, index) => value !== before[index]) || acked.at(-1) !== last.sequence) throw new Error('失配增量修改了画面或被确认');
        for (const button of [0, 2, 8, 32, 136, 4, 16, 64]) mouse(button);
        const pointer = sent.filter(packet => new DataView(packet.buffer).getUint16(0) === 2);
        if (pointer.map(packet => packet[5]).join(',') !== '2,8,32,4,16,64' || pointer.some(packet => packet.length !== 20 || new DataView(packet.buffer).getUint32(16) !== last.sequence)) throw new Error('恢复期间鼠标释放丢失，或失效画面仍产生新鼠标操作');
        const restored = inspect(packets[0].slice()), rv = new DataView(restored.metadata.buffer, restored.metadata.byteOffset, restored.metadata.length);
        rv.setUint32(12, last.sequence + 2); restored.sequence = last.sequence + 2;
        await prepare(restored); feed(restored); await wait(() => acked.at(-1) === restored.sequence);
        failNext = true;
        const failing = inspect(packets.at(-1).slice()), fv = new DataView(failing.metadata.buffer, failing.metadata.byteOffset, failing.metadata.length);
        fv.setUint32(12, last.sequence + 3); fv.setUint32(36, restored.sequence);
        const resets = () => sent.filter(packet => new DataView(packet.buffer).getUint16(0) === 0x7f05).length, count = resets();
        feed(failing); await wait(() => resets() > count);
        if (acked.at(-1) !== restored.sequence) throw new Error('解码失败被确认');
        rv.setUint32(12, last.sequence + 4); restored.sequence = last.sequence + 4;
        await prepare(restored); feed(restored); await wait(() => acked.at(-1) === restored.sequence);
      }
      dispose(); await sleep(40); window.createImageBitmap = originalBitmap;
      latency.sort((a, b) => a - b);
      return { frames: frames.length, differingChannels: difference, peakBitmaps: peak, peakDecoders: peakActive, retainedBitmaps: live,
        canvasReleased: canvas.width === 1 && canvas.height === 1, oldRefreshPackets: sent.filter(packet => new DataView(packet.buffer).getUint16(0) === 6).length,
        presentationP95Ms: latency[Math.floor((latency.length - 1) * .95)], recoveryRequests: sent.filter(packet => new DataView(packet.buffer).getUint16(0) === 0x7f05).length };
    }, frames);
    assert.equal(result.differingChannels, 0); assert.equal(result.retainedBitmaps, 0); assert.ok(result.canvasReleased);
    assert.ok(result.peakBitmaps <= 2); assert.ok(result.peakDecoders <= 2); assert.equal(result.oldRefreshPackets, 0);
    if (scenario === 'local' && native.mode !== 0) assert.equal(result.recoveryRequests, 2);
    results.push({ viewportWidth, ...result }); await page.close();
  }
  console.log(JSON.stringify({ browser: browser.version(), native, results }));
} finally { await browser.close(); }

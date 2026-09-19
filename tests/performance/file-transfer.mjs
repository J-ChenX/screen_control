// 对真实普通用户文件进程注入每窗口确认等待，不修改网络或访问既有文件。
// 用法：mise exec -- node tests/performance/file-transfer.mjs /tmp/screen-control-files
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2]) throw new Error('请提供已构建的文件进程路径');
const directory = await mkdtemp(join(tmpdir(), 'screen-control-transfer-benchmark-'));
try {
  const source = join(directory, 'source.bin');
  const data = randomBytes(4 * 1024 * 1024);
  await writeFile(source, data, { mode: 0o600 });
  const expected = createHash('sha256').update(data).digest('hex');
  for (const window of [1, 8]) for (const waitMs of [10, 50]) {
    const child = spawn(resolve(process.argv[2]), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
    const timeout = setTimeout(() => child.kill(), 30000);
    const chunks = child.stdout[Symbol.asyncIterator](); let buffered = Buffer.alloc(0);
    const read = async () => {
      for (;;) {
        if (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (length > 1048576) throw new Error('协议帧超限');
          if (buffered.length >= length + 4) { const frame = buffered.subarray(4, length + 4); buffered = buffered.subarray(length + 4); return frame; }
        }
        const next = await chunks.next(); if (next.done) throw new Error('文件进程提前退出');
        buffered = Buffer.concat([buffered, next.value]);
      }
    };
    const send = value => { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); child.stdin.write(Buffer.concat([header, body])); };
    try {
      await read();
      send({ action: 'download', sub: 'start', id: 1, path: source, window });
      const start = JSON.parse((await read()).toString());
      assert.equal(start.window ?? 1, window);
      let frames = 0, bytes = 0, last = false;
      const hash = createHash('sha256'); const begin = performance.now();
      while (!last) {
        await delay(waitMs);
        send({ action: 'download', sub: frames ? 'ack' : 'startack', id: 1, ack: frames });
        for (let i = 0; i < window && !last; i++) {
          const frame = await read(); frames++; bytes += frame.length - (window > 1 ? 12 : 4);
          hash.update(frame.subarray(window > 1 ? 12 : 4)); last = Boolean(frame[3] & 1);
        }
      }
      const seconds = (performance.now() - begin) / 1000;
      assert.equal(bytes, data.length); assert.equal(hash.digest('hex'), expected);
      console.log(JSON.stringify({ window, syntheticWaitMs: waitMs, bytes, frames, seconds: Number(seconds.toFixed(3)), MiBPerSecond: Number((bytes / 1048576 / seconds).toFixed(3)), sha256OK: true }));
      child.stdin.end(); assert.equal((await exited).code, 0);
    } finally { clearTimeout(timeout); child.kill(); await exited; }
  }
} finally { await rm(directory, { recursive: true, force: true }); }

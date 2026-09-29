// 在本次专用临时目录验证真实普通用户文件进程，不读取或覆盖用户已有文件。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const device = process.argv[2];
const mode = process.argv[3];
const token = process.argv[4];
const directory = process.env.SCREEN_CONTROL_PERF_DIRECTORY;
if (!['echova', 'nix', 'jiang-chenx'].includes(device) || !['current', 'staged', 'local'].includes(mode) || !/^perf-[a-z0-9-]+$/.test(token ?? '') || !directory?.replaceAll('\\', '/').split('/').at(-1)?.startsWith('screen-control-perf-')) throw new Error('只允许本次登记设备与隔离目录');
const targets = Object.fromEntries((process.env.SCREEN_CONTROL_FILE_SSH_TARGETS ?? '').split(',').map(entry => entry.split('=')));
if (mode !== 'local' && !targets[device]) throw new Error('缺少已登记的文件 SSH 目标');
if (mode === 'staged') {
  // 文件专用 SSH 可能使用 ForceCommand；它会忽略 staged 路径却仍返回成功。
  const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '--', targets[device], 'printf SCREEN_CONTROL_STAGED_COMMAND_OK'],
    { encoding: 'utf8', timeout: 12000, maxBuffer: 4096 });
  if (probe.status !== 0 || probe.stdout !== 'SCREEN_CONTROL_STAGED_COMMAND_OK') {
    throw new Error('SSH 目标未执行 staged 命令；可能启用了 ForceCommand，拒绝将当前进程误报为候选');
  }
}
const workerPath = mode === 'staged' ? `staging/${token}` : 'current';
const command = device === 'jiang-chenx' ? `"%USERPROFILE%\\.local\\lib\\screen-control-files\\${workerPath.replaceAll('/', '\\')}\\screen-control-files.exe"` : `exec "$HOME/.local/lib/screen-control-files/${workerPath}/screen-control-files"`;
const child = mode === 'local' ? spawn(process.env.SCREEN_CONTROL_PERF_BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] }) : spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '--', targets[device], command], { stdio: ['pipe', 'pipe', 'pipe'] });
const exited = new Promise(done => child.once('exit', code => done(code)));
const timeout = setTimeout(() => child.kill(), 90000);
const chunks = child.stdout[Symbol.asyncIterator](); let buffered = Buffer.alloc(0);
const read = async () => {
  for (;;) {
    if (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0); assert.ok(size <= 1048576);
      if (buffered.length >= size + 4) { const data = buffered.subarray(4, size + 4); buffered = buffered.subarray(size + 4); return data; }
    }
    const next = await chunks.next(); if (next.done) throw new Error('文件进程提前退出');
    buffered = Buffer.concat([buffered, next.value]);
  }
};
const json = async () => JSON.parse((await read()).toString());
const send = value => { const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); child.stdin.write(Buffer.concat([header, body])); };
const join = name => directory.replaceAll('\\', '/') + '/' + name;
try {
  const hello = await json(); assert.equal(hello.action, 'workerReady'); assert.ok(!['0', 'S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(hello.uid));
  const size = Number(process.env.SCREEN_CONTROL_PERF_BYTES ?? 8 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(size) && size >= 8 * 1024 * 1024 && size <= 128 * 1024 * 1024);
  const content = Buffer.alloc(size); for (let i = 0; i < size; i++) content[i] = i % 251;
  const hash = createHash('sha256').update(content).digest('hex');
  send({ action: 'upload', reqid: 1, path: directory, name: 'payload.bin', size, window: 8 });
  const upload = await json(); assert.equal(upload.action, 'uploadstart');
  const window = upload.window ?? 1, chunkSize = upload.chunkSize ?? 65536;
  let sent = 0, acknowledged = 0, offset = 0; const uploadStart = performance.now();
  while (offset < size || acknowledged < sent) {
    while (offset < size && sent - acknowledged < window) {
      let chunk = content.subarray(offset, Math.min(size, offset + chunkSize)); offset += chunk.length; sent++;
      if (chunk[0] === 0 || chunk[0] === 123) chunk = Buffer.concat([Buffer.from([0]), chunk]);
      send(chunk);
    }
    const ack = await json(); assert.equal(ack.action, 'uploadack'); acknowledged = ack.ack ?? acknowledged + 1;
  }
  send({ action: 'uploaddone', reqid: 1 }); assert.equal((await json()).action, 'uploaddone');
  const uploadMs = performance.now() - uploadStart;
  send({ action: 'download', sub: 'start', id: 2, path: join('payload.bin'), window: 8 });
  const download = await json(); assert.equal(download.sub, 'start');
  const downloadWindow = download.window ?? 1, headerSize = downloadWindow > 1 ? 12 : 4;
  let frames = 0, received = 0, last = false; const digest = createHash('sha256'); const downloadStart = performance.now();
  while (!last) {
    send({ action: 'download', sub: frames ? 'ack' : 'startack', id: 2, ack: frames });
    for (let i = 0; i < downloadWindow && !last; i++) {
      const frame = await read(); assert.equal(frame[0], 1);
      if (headerSize === 12) assert.equal(frame.readBigUInt64BE(4), 2n);
      digest.update(frame.subarray(headerSize)); received += frame.length - headerSize; frames++; last = Boolean(frame[3] & 1);
    }
  }
  const downloadMs = performance.now() - downloadStart;
  assert.equal(received, size); assert.equal(digest.digest('hex'), hash);
  // 故意短写覆盖必须失败，已有文件完整保留。
  send({ action: 'upload', reqid: 3, path: directory, name: 'payload.bin', size: 10, window: 8 }); assert.equal((await json()).action, 'uploadstart');
  send(Buffer.from('bad')); assert.equal((await json()).action, 'uploadack');
  send({ action: 'uploaddone', reqid: 3 }); assert.equal((await json()).action, 'uploaderror');
  send({ action: 'download', sub: 'start', id: 4, path: join('payload.bin'), window: 8 });
  const preserved = await json(); assert.equal(preserved.size, size);
  const preservedWindow = preserved.window ?? 1, preservedHeader = preservedWindow > 1 ? 12 : 4;
  const preservedHash = createHash('sha256'); let preservedFrames = 0, preservedLast = false, preservedSize = 0;
  while (!preservedLast) {
    send({ action: 'download', sub: preservedFrames ? 'ack' : 'startack', id: 4, ack: preservedFrames });
    for (let i = 0; i < preservedWindow && !preservedLast; i++) {
      const frame = await read(); assert.equal(frame[0], 1);
      if (preservedHeader === 12) assert.equal(frame.readBigUInt64BE(4), 4n);
      preservedHash.update(frame.subarray(preservedHeader)); preservedSize += frame.length - preservedHeader;
      preservedFrames++; preservedLast = Boolean(frame[3] & 1);
    }
  }
  assert.equal(preservedSize, size); assert.equal(preservedHash.digest('hex'), hash);
  send({ action: 'upload', reqid: 5, path: directory, name: 'empty.bin', size: 0, window: 8 }); assert.equal((await json()).action, 'uploadstart');
  send({ action: 'uploaddone', reqid: 5 }); assert.equal((await json()).action, 'uploaddone');
  const names = new Set(); let page = 0;
  for (;;) {
    send({ action: 'ls', reqid: 6, path: directory, paged: true, page }); const listing = await json();
    assert.ok(Array.isArray(listing.dir));
    for (const item of listing.dir) { assert.ok(!names.has(item.n)); names.add(item.n); }
    if (!listing.more) break; page++;
  }
  assert.ok(names.has('payload.bin') && names.has('empty.bin')); assert.ok(![...names].some(name => name.startsWith('.screen-control-upload-')));
  console.log(JSON.stringify({ device, mode, uploadWindow: window, downloadWindow, bytes: size, uploadMs: Math.round(uploadMs), downloadMs: Math.round(downloadMs), uploadMiBPerSecond: Number((size / 1048576 * 1000 / uploadMs).toFixed(2)), downloadMiBPerSecond: Number((size / 1048576 * 1000 / downloadMs).toFixed(2)), sha256OK: true, failedOverwritePreservedSHA256: true, emptyFile: true, directoryEntries: names.size, directoryPages: page + 1, temporaryUploadCleaned: true }));
  child.stdin.end(); assert.equal(await exited, 0);
} catch (error) { console.error('文件实机检查失败：' + error.name + ' ' + error.message.slice(0, 200)); process.exitCode = 1; }
finally { clearTimeout(timeout); child.kill(); await exited; }

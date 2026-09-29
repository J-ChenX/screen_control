// 六项隔离回归共用临时端口；不加载私有配置或连接真实后端。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'web/package.json'));
const { preview } = await import(pathToFileURL(require.resolve('vite')).href);
const scenarios = ['files', 'transfer-window', 'directory-performance', 'desktop-files', 'desktop-lock-exit', 'desktop-performance'];
const selected = process.argv.slice(2);
if (selected.some(name => !scenarios.includes(name))) {
  throw new Error(`支持的隔离场景：${scenarios.join(', ')}`);
}
await access(resolve(root, 'dist/portal/index.html'));
const outputs = resolve(root, 'web/test-results');
await mkdir(outputs, { recursive: true });
const output = await mkdtemp(resolve(outputs, 'browser-'));
const server = await preview({
  configFile: false, envDir: false, root: resolve(root, 'web'),
  build: { outDir: resolve(root, 'dist/portal') },
  preview: { host: '127.0.0.1', port: 0, allowedHosts: ['screen-control.test'] },
});
const { port } = server.httpServer.address();
let child;
const stop = () => child?.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (const name of selected.length ? selected : scenarios) {
    // 文件回归还验证普通 HTTP 不具备安全上下文；OPFS 专项使用回环安全上下文。
    const host = name === 'files' ? 'screen-control.test' : '127.0.0.1';
    console.log(`运行隔离场景：${name}`);
    await new Promise((done, reject) => {
      child = spawn(process.execPath, [resolve(import.meta.dirname, `${name}.mjs`), `http://${host}:${port}`], {
        cwd: root, stdio: 'inherit',
        env: { ...process.env, SCREEN_CONTROL_TEST_OUTPUT: output },
        timeout: 180_000,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${name} 失败：${signal || code}`)));
    });
  }
} finally {
  stop();
  await new Promise(done => server.httpServer.close(done));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  console.log(`合成页面截图：${output}`);
}

// 浏览器脚本共用锁定的 Playwright；实机对照可显式指定浏览器路径。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
export { expect };

export function launchBrowser({ args = [] } = {}) {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', ...args],
  });
}

export function testOrigin() {
  if (!process.argv[2]) throw new Error('请使用 make test-browser，或传入本机静态预览地址');
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', 'screen-control.test'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('隔离浏览器回归只接受本机 HTTP origin');
  }
  return url.origin;
}

export function screenshotPath(name) {
  const directory = process.env.SCREEN_CONTROL_TEST_OUTPUT
    || resolve(import.meta.dirname, '../../web/test-results/browser');
  mkdirSync(directory, { recursive: true });
  return resolve(directory, name);
}

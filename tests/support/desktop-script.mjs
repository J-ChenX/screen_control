// 通过项目既有 Vite/TypeScript 工具链打包真实图块管理器，供隔离浏览器验证。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'web/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
export async function desktopMemoryScript(entry = resolve(root, 'web/src/features/desktop/memory.ts')) {
  const result = await build({ configFile: false, envDir: false, logLevel: 'error', root: resolve(root, 'web'), build: { write: false, minify: false, lib: { entry, name: 'DesktopMemory', formats: ['iife'] } } });
  return (Array.isArray(result) ? result[0] : result).output[0].code + '\nwindow.manageDesktopMemory = window.__manageDesktopMemory = DesktopMemory.manageDesktopMemory;';
}

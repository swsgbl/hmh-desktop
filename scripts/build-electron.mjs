/**
 * esbuild 打包 Electron main + preload 为 CJS(sandbox preload 必须 CJS)。
 * main 进程代码 import workspace 包(@hmh-desktop/*)与 electron——全部打平。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: 'inline',
  external: ['electron'],
  logLevel: 'info',
};

await build({
  ...shared,
  format: 'esm',
  entryPoints: [join(appDir, 'electron', 'main', 'index.ts')],
  outfile: join(appDir, 'dist-electron', 'main', 'index.js'),
});

await build({
  ...shared,
  entryPoints: [join(appDir, 'electron', 'preload', 'index.ts')],
  outfile: join(appDir, 'dist-electron', 'preload', 'index.cjs'),
});

console.log('electron bundles → apps/desktop/dist-electron/');

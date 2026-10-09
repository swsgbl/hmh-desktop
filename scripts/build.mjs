/**
 * build:renderer(vite build) + electron(esbuild)→ 可运行产物。
 * 安装包/签名/SBOM 属 M6,此脚本只出 dist。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

await new Promise((resolve, reject) => {
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/desktop/vite.config.ts'], {
    cwd: root + '/..',
    stdio: 'inherit',
  });
  vite.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`))));
});

await import('./build-electron.mjs');
console.log('build 完成:apps/desktop/dist-renderer + apps/desktop/dist-electron');

/**
 * dev:esbuild 打包 electron → vite dev server → spawn electron(连 dev server)。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

// 1) electron main/preload
await import('./build-electron.mjs');

// 2) vite dev server(子进程,继承输出)
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'dev', '--config', 'apps/desktop/vite.config.ts'], {
  cwd: join(root, '..'),
  stdio: 'inherit',
});

// 3) 等 vite 端口就绪再拉 electron(简单轮询)
const devUrl = 'http://127.0.0.1:5174';
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(devUrl, { signal: AbortSignal.timeout(500) });
    if (r.ok) break;
  } catch {
    await new Promise((r2) => setTimeout(r2, 500));
  }
}

// 4) electron(直接用二进制;node 跑 electron/index.js 只是包入口)
const electronExe = join(root, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronExe, ['apps/desktop'], {
  cwd: join(root, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    HMH_DESKTOP_DEV: '1',
    HMH_DESKTOP_RENDERER_URL: devUrl,
    ELECTRON_ENABLE_LOGGING: '1',
  },
});

const shutdown = (code) => {
  vite.kill();
  process.exit(code ?? 0);
};
child.on('exit', shutdown);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

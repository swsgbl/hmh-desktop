// 验证 ELECTRON_RUN_AS_NODE=1 的 electron.exe 是否支持 --import tsx
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), ['--import', 'tsx', join(root, 'packages', 'host-adapter', 'src', 'fake-host.ts')], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HMH_DESKTOP_TOKEN: 'debug-tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
setTimeout(() => {
  console.log('stdout:', out.slice(0, 300));
  console.log('stderr:', err.slice(0, 500));
  child.kill();
  process.exit(0);
}, 8_000);

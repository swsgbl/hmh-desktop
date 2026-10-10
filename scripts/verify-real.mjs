// 打包版验证:确认自动发现并连上真实 hmharness(mode real + entry 路径)
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe'), [], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
setTimeout(() => {
  child.kill();
  const lines = out.split('\n').filter((l) => l.includes('bridge ready'));
  console.log(lines.join('\n') || '(no bridge line)');
  process.exit(0);
}, 30_000);

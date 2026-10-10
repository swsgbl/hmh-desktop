/** 启动打包版(prod renderer,与安装版同一产物)并截图——装机诊断。 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const useDev = process.argv.includes('--dev');
const snapFile = process.argv[2] ?? join(root, 'ui-shot.png');
const extraEnv = {};
for (const arg of process.argv.slice(2)) {
  if (arg.includes('=')) {
    const [k, v] = arg.split('=');
    extraEnv[k] = v;
  }
}
const exe = useDev
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const args = useDev ? [join(root, 'apps', 'desktop', 'dist-electron', 'main', 'index.js')] : [];
const child = spawn(exe, args, {
  cwd: join(root, 'apps', 'desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HMH_DESKTOP_SNAPSHOT: snapFile, ...extraEnv },
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (code) => {
  console.log(out.split('\n').filter((l) => l.includes('SNAPSHOT') || l.includes('bridge ready') || l.includes('RENDER')).join('\n'));
  process.exit(code === 0 ? 0 : 1);
});
setTimeout(() => { child.kill(); setTimeout(() => process.exit(1), 1_000); }, 90_000);

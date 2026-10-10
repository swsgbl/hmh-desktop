/**
 * 渲染自检驱动:HMH_DESKTOP_RENDER_TEST=1 启动 electron(win-unpacked 或 dev
 * 产物),main 检查 #root 是否真的挂载了 React 内容,输出 RENDER-TEST ok/EMPTY。
 * 这是 2026-10-10 装机黑屏的教训:bridge ready ≠ 界面渲染了。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const child = spawn(target, [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HMH_DESKTOP_RENDER_TEST: '1' } });
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
const timer = setTimeout(() => { console.log('RENDER-TEST TIMEOUT'); child.kill(); process.exit(1); }, 45_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.startsWith('RENDER-TEST')) ?? '(no RENDER-TEST line)';
  console.log(line);
  process.exit(code === 0 ? 0 : 1);
});

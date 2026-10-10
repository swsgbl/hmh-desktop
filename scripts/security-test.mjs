/**
 * 阶段H 安全测试矩阵驱动:spawn electron(HMH_DESKTOP_SECURITY_TEST=1),
 * main 自跑六项探针(renderer 无 process/require、白名单桥、导航拦截、
 * window.open 拒绝、CSP、桥可用),按 exit code 判定。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronExe, [join(root, 'apps', 'desktop')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HMH_DESKTOP_SECURITY_TEST: '1' },
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
const timer = setTimeout(() => {
  console.log('TIMEOUT');
  child.kill();
  process.exit(1);
}, 60_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const lines = out.split('\n').filter((l) => l.startsWith('SECURITY-TEST'));
  for (const l of lines) console.log(l);
  process.exit(code === 0 ? 0 : 1);
});

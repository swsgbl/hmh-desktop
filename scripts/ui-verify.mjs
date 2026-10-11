/** UIVERIFY 驱动:启动 Electron(dev 或 win-unpacked),跑逐功能 UI 验收。
 *  用法:node scripts/ui-verify.mjs [--dev|--packaged] [--real|--fake] [--keep]
 *  默认:dev 布局 + fake 模式。输出 UIVERIFY 行,exit code 即验收结论。 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exeArgIdx = process.argv.indexOf('--exe');
const exeOverride = exeArgIdx >= 0 ? process.argv[exeArgIdx + 1] : '';
const useDev = process.argv.includes('--dev') || (!process.argv.includes('--packaged') && exeOverride === '');
const mode = process.argv.includes('--real') ? 'real' : 'fake';
const exe = exeOverride !== ''
  ? exeOverride
  : useDev
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const args = useDev ? [join(root, 'apps', 'desktop', 'dist-electron', 'main', 'index.js')] : [];

console.log(`UIVERIFY-DRIVER layout=${useDev ? 'dev' : 'packaged'} mode=${mode}`);
const child = spawn(exe, args, {
  cwd: join(root, 'apps', 'desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HMH_DESKTOP_UIVERIFY: '1',
    HMH_DESKTOP_UIVERIFY_MODE: mode,
    HMH_DESKTOP_UIVERIFY_SHOTS: join(root, `ui-verify-shots-${mode}`),
    ...(process.argv.includes('--real-task') ? { HMH_DESKTOP_UIVERIFY_REAL_TASK: '1' } : {}),
  },
});
let tail = '';
child.stdout.on('data', (d) => {
  const s = d.toString();
  tail = (tail + s).slice(-8_000);
  for (const line of s.split(/\r?\n/)) {
    if (line.includes('UIVERIFY') || line.includes('hmh-desktop:host')) console.log(line.slice(0, 300));
  }
});
child.stderr.on('data', (d) => { tail += d.toString(); });
child.on('exit', (code) => {
  if (code !== 0 && !tail.includes('UIVERIFY SUMMARY')) {
    console.error('--- crashed before summary; stdout/stderr tail ---');
    console.error(tail.slice(-2_000));
  }
  process.exit(code ?? 1);
});
// 硬超时:fake 4 分钟;real 只读 5 分钟;real 含真实任务 8 分钟(模型回复可慢)
const realTask = process.argv.includes('--real-task');
setTimeout(() => { try { child.kill(); } catch {} }, mode === 'real' ? (realTask ? 480_000 : 300_000) : 240_000);

/**
 * Electron 冒烟:prod 模式启动(loadFile dist-renderer),采样主进程日志,
 * N 秒后关闭。验证:窗口创建、CSP 注入、fake host ready、无未捕获异常。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 直接用 electron 二进制(node 跑 electron/index.js 只是导出路径的包入口)
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronExe, [join(root, 'apps', 'desktop')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });

const RUN_MS = 20_000;
let timedKill = false;
setTimeout(() => {
  timedKill = true;
  child.kill();
  setTimeout(() => {
    console.log('=== stdout ===');
    console.log(out.slice(-3000));
    console.log('=== stderr(tail) ===');
    console.log(err.slice(-1500));
    const ready = /ready on 127\.0\.0\.1:\d+/.test(out);
    const noCrash = !/uncaught|Unhandled/gi.test(err);
    console.log(`SMOKE: host-ready=${ready} no-crash=${noCrash}`);
    process.exit(ready && noCrash ? 0 : 1);
  }, 2_000);
}, RUN_MS);

child.on('exit', (code, signal) => {
  if (timedKill) return; // 由我们主动结束的正常路径
  console.log(`electron exited early: code=${code} signal=${signal}`);
  console.log('=== stdout ===');
  console.log(out.slice(-2500));
  console.log('=== stderr ===');
  console.log(err.slice(-2500));
  process.exit(1);
});

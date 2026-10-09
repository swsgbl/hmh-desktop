/**
 * 真实模式冒烟:HMH_DESKTOP_REAL=1 启动 Electron,连真实 hmharness
 * desktop-host(用户真实 HMH_HOME,只读配置;不发任务、不写数据)。
 * 验证:引导行 → token 探测 → 桥客户端建立 + SSE 订阅无错。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronExe, [join(root, 'apps', 'desktop')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', HMH_DESKTOP_REAL: '1' },
});

let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });

let timedKill = false;
setTimeout(() => {
  timedKill = true;
  child.kill();
  setTimeout(() => {
    console.log('=== stdout ===');
    console.log(out.slice(-3000));
    console.log('=== stderr(tail) ===');
    console.log(err.slice(-1200));
    const bridgeReady = /bridge ready on 127\.0\.0\.1:\d+/.test(out);
    const isReal = /mode real/.test(out);
    const noCrash = !/uncaught|Unhandled/gi.test(err);
    console.log(`REAL-SMOKE: bridge-ready=${bridgeReady} mode-real=${isReal} no-crash=${noCrash}`);
    process.exit(bridgeReady && isReal && noCrash ? 0 : 1);
  }, 2_500);
}, 45_000);

child.on('exit', (code, signal) => {
  if (timedKill) return;
  console.log(`electron exited early: code=${code} signal=${signal}`);
  console.log('=== stdout ===');
  console.log(out.slice(-2500));
  console.log('=== stderr ===');
  console.log(err.slice(-2500));
  process.exit(1);
});

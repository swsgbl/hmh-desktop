/**
 * 打包产品冒烟:直接运行 win-unpacked 的 HMH Desktop.exe(app.isPackaged=true
 * 路径:fake host 走 resources/fake-host.cjs,不需要 tsx/Node)——验证安装包
 * 形态自包含可跑。装包/卸载本身留给用户(NOT RUN)。
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const t0 = Date.now();
const child = spawn(exe, [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
let coldStartMs = null;
child.stdout.on('data', (d) => {
  out += d.toString();
  if (coldStartMs === null && /bridge ready on 127\.0\.0\.1:\d+/.test(out)) coldStartMs = Date.now() - t0;
});
child.stderr.on('data', (d) => { err += d.toString(); });
let timedKill = false;
setTimeout(() => {
  timedKill = true;
  child.kill();
  setTimeout(() => {
    console.log('=== stdout ===');
    console.log(out.slice(-1500));
    console.log('=== stderr(tail) ===');
    console.log(err.slice(-800));
    const ready = /bridge ready on 127\.0\.0\.1:\d+/.test(out);
    const noCrash = !/uncaught|Unhandled/gi.test(err);
    console.log(`PACKAGED-SMOKE: bridge-ready=${ready} no-crash=${noCrash} cold-start=${coldStartMs ?? 'n/a'}ms`);
    process.exit(ready && noCrash ? 0 : 1);
  }, 2_000);
}, 30_000);
child.on('exit', (code, signal) => {
  if (timedKill) return;
  console.log(`packaged app exited early: code=${code} signal=${signal}`);
  console.log(out.slice(-1500));
  console.log(err.slice(-800));
  process.exit(1);
});

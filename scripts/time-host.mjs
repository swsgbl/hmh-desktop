/** 手动计时真实 desktop-host 冷启动(引导行出现耗时)。 */
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--import', 'tsx', 'G:/hmharness/packages/web/src/desktop-host.ts'], {
  cwd: 'G:/hmharness',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HMH_DESKTOP_TOKEN: '0123456789abcdef0123456789abcdef' },
});
const t0 = Date.now();
let out = '';
child.stdout.on('data', (d) => {
  out += d.toString();
  if (out.includes('hmhDesktopHostReady')) {
    console.log(`ready in ${Date.now() - t0}ms: ${out.trim().slice(0, 120)}`);
    child.kill();
    process.exit(0);
  }
});
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (c) => { console.log(`exited ${c} after ${Date.now() - t0}ms; out=${out.slice(0, 300)}`); process.exit(1); });
setTimeout(() => { console.log(`TIMEOUT 30s; out=${out.slice(0, 300)}`); child.kill(); process.exit(1); }, 30_000);

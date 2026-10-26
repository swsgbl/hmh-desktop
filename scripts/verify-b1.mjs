/** B1:runtime.cjs 独立可跑(引导行)。 */
import { spawn } from 'node:child_process';
const c = spawn(process.execPath, ['apps/desktop/resources/runtime/runtime.cjs'], {
  cwd: 'G:/hmh-desktop',
  env: { ...process.env, HMH_DESKTOP_TOKEN: '0123456789abcdef0123456789abcdef' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
c.stdout.on('data', (d) => {
  out += d.toString();
  if (out.includes('hmhDesktopHostReady')) {
    console.log('B1 PASS:', out.split('\n').find((l) => l.includes('hmhDesktopHostReady')).slice(0, 100));
    c.kill();
    process.exit(0);
  }
});
c.stderr.on('data', (d) => { out += d.toString(); });
setTimeout(() => { console.log('B1 FAIL:', out.slice(0, 300)); try { c.kill(); } catch {} process.exit(1); }, 30_000);

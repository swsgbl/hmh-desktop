/** 手动启动打包版 fake-host.cjs 并探测各 API 路由。 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const child = spawn(process.execPath, ['apps/desktop/release/win-unpacked/resources/fake-host.cjs'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HMH_DESKTOP_TOKEN: 'x'.repeat(40) },
});
let boot = '';
const p = new Promise((resolve) => {
  child.stdout.once('data', (d) => { boot += d.toString(); resolve(); });
});
await Promise.race([p, delay(5000)]);
console.log('boot line:', boot.trim());
const m = /"port":(\d+)/.exec(boot);
if (m === null) { child.kill(); process.exit(1); }
const port = m[1];
for (const path of ['/api/state', '/api/fs?files=1', '/api/diff', '/api/cognitive', '/api/sessions']) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-hmh-key': 'x'.repeat(40) } });
  const body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
  console.log(`${path} -> ${r.status} ${body}`);
}
child.kill();
process.exit(0);

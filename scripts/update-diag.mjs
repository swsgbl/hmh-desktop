/** 更新器诊断:跑 win-unpacked 0.2.2(带日志),抓 stdout,看 check→download 全链。 */
import { spawn } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const child = spawn('G:/hmh-desktop/apps/desktop/release/win-unpacked/HMH Desktop.exe', [], {
  cwd: 'G:/hmh-desktop/apps/desktop',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
const t0 = Date.now();
let found = '';
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  if (out.includes('hmh-desktop:update')) process.stdout.write('.');
  const hits = readdirSync(tmpdir()).filter((f) => /HMH-Desktop-Setup-0\.2\.3.*\.exe$/i.test(f));
  if (hits.length > 0) { found = join(tmpdir(), hits[0]); break; }
  if (out.includes('已下载')) break;
}
console.log('\n=== update logs ===');
console.log(out.split('\n').filter((l) => l.includes('update') || l.includes('host')).join('\n').slice(0, 1500));
console.log('=== temp 0.2.3 installer:', found !== '' ? found : '(未出现)');
try { child.kill(); } catch { /* ok */ }
try { spawn('taskkill', ['/IM', 'HMH Desktop.exe', '/F']); } catch { /* ok */ }

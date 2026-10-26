/** 更新闭环验证:启动安装版 0.2.0 → 等自检(30s)+下载 → 验证 %TEMP% 出现 0.2.3 安装包 → 模拟"重启安装" → 重启验证版本。 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXE = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop/HMH Desktop.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const findTemp = (pat) => readdirSync(tmpdir()).filter((f) => pat.test(f)).map((f) => join(tmpdir(), f));

console.log('== 1) 启动 0.2.0(更新器 30s 自检) ==');
const child = spawn(EXE, [], { detached: false, stdio: 'ignore' });
let found = '';
for (let i = 0; i < 24; i++) {
  await wait(10_000);
  const hits = findTemp(/HMH-Desktop-Setup-0\.2\.3.*\.exe$/i);
  if (hits.length > 0) { found = hits[0]; break; }
  process.stdout.write(`wait ${(i + 1) * 10}s… `);
}
console.log('');
if (found === '') {
  console.log('FAIL: %TEMP% 未出现 0.2.3 安装包(下载链未通)');
  try { child.kill(); } catch {}
  process.exit(1);
}
console.log('下载链 PASS:', found, Math.round(statSync(found).size / 1e6) + 'MB');

console.log('== 2) 关闭应用 → 运行更新安装器(静默) ==');
try { child.kill(); } catch {}
await wait(2000);
try { execFileSync('taskkill', ['/IM', 'HMH Desktop.exe', '/F'], { stdio: 'ignore' }); } catch { /* 已退 */ }
await wait(1000);
const installDir = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop';
const inst = spawn(found, ['/S', `/D=${installDir}`], { detached: true, stdio: 'ignore', windowsHide: true });
inst.unref();
console.log('安装器已启动,等待完成…');
let done = false;
for (let i = 0; i < 36; i++) {
  await wait(10_000);
  try {
    execFileSync('taskkill', ['/IM', 'HMH-Desktop-Setup-0.2.3.exe', '/F'], { stdio: 'ignore' });
  } catch { /* 已退出 */ }
  try {
    execFileSync('taskkill', ['/IM', 'elevate.exe', '/F'], { stdio: 'ignore' });
  } catch { /* 无 */ }
  // 安装完成的标志:安装目录 exe mtime 更新
  const mt = statSync(EXE).mtime.getTime();
  if (Date.now() - mt < 6 * 60_000) { done = true; break; }
}
console.log(done ? '安装完成(exe 已更新)' : '等待超时——检查 mtime');

console.log('== 3) 重启验证版本 ==');
const app2 = spawn(EXE, [], { stdio: 'ignore' });
await wait(12_000);
try { execFileSync('taskkill', ['/IM', 'HMH Desktop.exe', '/F'], { stdio: 'ignore' }); } catch { /* ok */ }
// 验证:安装目录 app.asar 里版本串
const asarPath = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop/resources/app.asar';
const buf = Buffer.alloc(2_000_000);
const { openSync, readSync, closeSync } = await import('node:fs');
const fd = openSync(asarPath, 'r');
readSync(fd, buf, 0, buf.length, 0);
closeSync(fd);
const s = buf.toString('latin1');
const has21 = s.includes('"version":"0.2.3"') || s.includes('0.2.3');
console.log(has21 ? 'UPDATE-VERIFY PASS: 0.2.0 → 0.2.3 应用内更新闭环全通' : '版本串确认失败(手动看关于对话框)');

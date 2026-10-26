/** 更新安装段验证:temp 已有 0.2.3 安装包 → 静默装 → 重启验证版本。 */
import { spawn, execFileSync } from 'node:child_process';
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXE = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop/HMH Desktop.exe';
const SRC = join(tmpdir(), 'HMH-Desktop-Setup-0.2.3.exe');
const INSTALL_DIR = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const running = (name) => {
  try { execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV'], { encoding: 'utf8' }).includes(`"${name}"`); return true; } catch { return false; }
};
// tasklist 输出匹配
const alive = (name) => {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV'], { encoding: 'utf8' });
    return out.toLowerCase().includes(name.toLowerCase());
  } catch { return false; }
};

console.log('== 静默安装 0.2.3 →', INSTALL_DIR);
try { execFileSync('taskkill', ['/IM', 'HMH Desktop.exe', '/F'], { stdio: 'ignore' }); } catch { /* ok */ }
await wait(1500);
const inst = spawn(SRC, ['/S', `/D=${INSTALL_DIR}`], { detached: true, stdio: 'ignore', windowsHide: true });
inst.unref();
let done = false;
for (let i = 0; i < 60; i++) {
  await wait(5000);
  const instRunning = alive('HMH-Desktop-Setup-0.2.3.exe') || alive('elevate.exe');
  let exeOk = false;
  try { exeOk = statSync(EXE).mtime.getTime() > Date.now() - 10 * 60_000; } catch { exeOk = false; }
  if (!instRunning && exeOk) { done = true; break; }
  process.stdout.write(`.${instRunning ? 'I' : '-'}${exeOk ? 'N' : 'x'}`);
}
console.log('\n安装状态:', done ? '完成' : '超时(继续验证)');

console.log('== 启动验证版本 ==');
const app2 = spawn(EXE, [], { stdio: 'ignore' });
await wait(14_000);
const buf = Buffer.alloc(3_000_000);
const fd = openSync('C:/Users/hongfu/AppData/Local/Programs/HMH Desktop/resources/app.asar', 'r');
readSync(fd, buf, 0, buf.length, 0);
closeSync(fd);
const s = buf.toString('latin1');
console.log('asar 含 0.2.3:', s.includes('0.2.3'), '| 含 0.2.2:', s.includes('0.2.2'));
try { execFileSync('taskkill', ['/IM', 'HMH Desktop.exe', '/F'], { stdio: 'ignore' }); } catch { /* ok */ }

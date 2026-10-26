/** 急救:cmd /c 形式跑安装器(/D 不带引号),轮询等 exe 恢复。 */
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';

const SETUP = 'C:/Users/hongfu/AppData/Local/Temp/HMH-Desktop-Setup-0.2.3.exe';
const DIR = 'C:/Users/hongfu/AppData/Local/Programs/HMH Desktop';
// cmd /c 双引号包裹整条,内部路径加引号,但 /D= 值不加引号(NSIS 规则)
const cmdline = `"${SETUP}" /S /D=${DIR}`;
console.log('cmd:', cmdline);
exec(`cmd /c ""${SETUP}" /S /D=${DIR}"`, { windowsHide: true, timeout: 300_000 });

const t0 = Date.now();
const tick = setInterval(() => {
  if (existsSync(`${DIR}/HMH Desktop.exe`)) {
    console.log(`exe 恢复(${Math.round((Date.now() - t0) / 1000)}s)`);
    clearInterval(tick);
    process.exit(0);
  }
  if (Date.now() - t0 > 300_000) { console.log('TIMEOUT'); clearInterval(tick); process.exit(1); }
}, 5000);

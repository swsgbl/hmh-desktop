/** 用 gh CLI 给历史版本打指针。 */
import { execFileSync } from 'node:child_process';
const note = '⚠️ 历史版本——请下载最新版 [v0.2.6](https://github.com/swsgbl/hmh-desktop/releases/tag/v0.2.6)（含按操作系统选包的详细指南：Windows 10/11 x64 用 Setup.exe；深开鸿/OpenHarmony 设备用 HAP）。';
for (const v of ['v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']) {
  try {
    execFileSync('gh', ['release', 'edit', v, '--notes', note, '-R', 'swsgbl/hmh-desktop'], { encoding: 'utf8', timeout: 60_000 });
    console.log(v, 'OK');
  } catch (e) { console.log(v, 'FAIL', String(e.message).slice(0, 60)); }
}

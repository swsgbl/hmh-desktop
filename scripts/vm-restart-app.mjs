/** 杀 app 进程→重启→截图。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 20_000) => {
  try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); }
  catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 70)}`; }
};
console.log(run(['shell', 'aa', 'force-stop', 'com.hmh.desktop.ohos']));
await new Promise((r) => setTimeout(r, 1500));
console.log(run(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.hmh.desktop.ohos']).split('\n')[0]);
await new Promise((r) => setTimeout(r, 5000));
console.log(run(['shell', 'snapshot_display', '-f', '/data/local/tmp/ohos-v024.jpeg']).split('\n').pop());
console.log(run(['file', 'recv', '/data/local/tmp/ohos-v024.jpeg', 'evidence/ohos/v3/v024-installed.jpeg']).split('\n')[0]);

/** VM 截图(相对路径 recv,修 cwd 拼接问题)。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 15_000) => { try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); } catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 90)}`; } };
console.log(run(['shell', 'snapshot_display', '-f', '/data/local/tmp/ohos-check.jpeg']).split('\n').pop());
console.log(run(['file', 'recv', '/data/local/tmp/ohos-check.jpeg', 'evidence/ohos/ohos-check.jpeg']).split('\n')[0]);
console.log(run(['shell', 'bm', 'dump', '-n', 'com.hmh.desktop.ohos']).split('\n').filter((l) => /bundleName|installTime|updateTime/.test(l)).slice(0, 3).join(' | ') || '(bundle missing)');

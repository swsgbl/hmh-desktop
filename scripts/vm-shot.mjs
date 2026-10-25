/** VM 截图(指定 -t 目标)。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 15_000) => { try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t }).trim(); } catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 90)}`; } };
console.log(run(['shell', 'snapshot_display', '-f', '/data/local/tmp/ohos-check.jpeg']));
console.log(run(['file', 'recv', '/data/local/tmp/ohos-check.jpeg', 'G:/hmh-desktop/evidence/ohos/ohos-check.jpeg']));

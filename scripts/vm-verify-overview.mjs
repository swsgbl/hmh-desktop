/** 验收:点击总览页签→截图。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 15_000) => { try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); } catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 90)}`; } };
// 拉应用到前台
console.log(run(['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.hmh.desktop.ohos']).split('\n')[0]);
await new Promise((r) => setTimeout(r, 1500));
// 点击总览 tab(之前 dump 的坐标 ~[972,95])
console.log(run(['shell', 'uitest', 'uiInput', 'click', '972', '95']));
await new Promise((r) => setTimeout(r, 1200));
console.log(run(['shell', 'snapshot_display', '-f', '/data/local/tmp/ov.jpeg']).split('\n').pop());
console.log(run(['file', 'recv', '/data/local/tmp/ov.jpeg', 'evidence/ohos/v3/overview-check.jpeg']).split('\n')[0]);

/** 正确 send 0.2.4 → VM 签+装 → 回收。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 120_000) => {
  try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); }
  catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 90)}`; }
};
console.log('send:', run(['file', 'send', '.hm-tmp/entry-024-unsigned.hap', '/data/local/tmp/entry-api23-unsigned.hap']).split('\n')[0]);
console.log('sign+install:', run(['shell', 'sh', '/data/local/tmp/vm-sign23.sh']).split('\n').slice(-2).join(' | '));
console.log('recv:', run(['file', 'recv', '/data/local/tmp/hmh-api23-signed.hap', 'apps/ohos/release-hap/HMH-OHOS-0.2.4.hap']).split('\n')[0]);

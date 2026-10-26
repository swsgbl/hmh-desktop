/** 0.2.4 HAP 签名链:send → VM 签名 → 回收签名 HAP → 装机启动。 */
import { execFileSync } from 'node:child_process';

const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (a, t = 60_000) => {
  try { return execFileSync(HDC, ['-t', T, ...a], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); }
  catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 100)}`; }
};

console.log('send:', run(['file', 'send', 'G:/hmh-desktop/.hm-tmp/entry-024-unsigned.hap', '/data/local/tmp/entry-api23-unsigned.hap']).split('\n')[0]);
console.log('mkdir:', run(['shell', 'mkdir', '-p', '/data/local/tmp/hmhsign']).split('\n')[0] ?? 'ok');
console.log('sign+install:', run(['shell', 'sh', '/data/local/tmp/vm-sign23.sh'], 120_000).split('\n').slice(0, 5).join(' | '));
console.log('recv signed:', run(['file', 'recv', '/data/local/tmp/hmh-api23-signed.hap', 'apps/ohos/release-hap/HMH-OHOS-0.2.4.hap']).split('\n')[0]);

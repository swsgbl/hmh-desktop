/** 0.2.5 签名链:send(反斜杠)→VM 签+装→回收。 */
import { execFileSync } from 'node:child_process';
const T = '192.168.161.137:10178';
const sh = (cmd, t = 120_000) => {
  try { return execFileSync('cmd', ['/c', cmd], { encoding: 'utf8', timeout: t, cwd: 'G:/hmh-desktop' }).trim(); }
  catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 90)}`; }
};
console.log('send:', sh(`hdc -t ${T} file send G:\\hmh-desktop\\.hm-tmp\\entry-025-unsigned.hap /data/local/tmp/entry-api23-unsigned.hap`).split('\n')[0]);
console.log('sign+install:', sh(`hdc -t ${T} shell "sh /data/local/tmp/vm-sign23.sh"`).split('\n').slice(-2).join(' | '));
console.log('recv:', sh(`hdc -t ${T} file recv /data/local/tmp/hmh-api23-signed.hap G:\\hmh-desktop\\apps\\ohos\\release-hap\\HMH-OHOS-0.2.5.hap`).split('\n')[0]);

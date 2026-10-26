/** 查 VM 上当年的本地 hmh 环境(/data/local/hmh)是否还在。 */
import { execFileSync } from 'node:child_process';
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const T = '192.168.161.137:10178';
const run = (cmd, t = 15_000) => {
  try { return execFileSync(HDC, ['-t', T, 'shell', cmd], { encoding: 'utf8', timeout: t }).trim(); }
  catch (e) { return `FAIL ${String(e.message ?? e).slice(0, 70)}`; }
};
console.log('== /data/local 目录 ==');
console.log(run('ls /data/local'));
console.log('== /data/local/hmh ==');
console.log(run('ls /data/local/hmh 2>/dev/null | head -8'));
console.log('== node 二进制 ==');
console.log(run('ls -la /data/local/hmh/node* 2>/dev/null; /data/local/hmh/node/bin/node -v 2>/dev/null || /data/local/hmh/node/bin/node.exe -v 2>/dev/null || echo no-node-bin'));
console.log('== 7788 本地服务 ==');
console.log(run('netstat -tln 2>/dev/null | grep 7788 || echo not-listening'));

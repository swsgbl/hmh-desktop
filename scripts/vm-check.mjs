/** VM 实机取证:连接/安装/运行/截图/布局。 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const run = (args, t = 10_000) => {
  try { return execFileSync(HDC, args, { encoding: 'utf8', timeout: t }).trim(); } catch (e) { return `FAIL: ${String(e.message ?? e).slice(0, 100)}`; }
};

console.log('== tconn ==\n', run(['tconn', '192.168.161.137:10178']));
console.log('== bundle ==\n', run(['shell', 'bm', 'dump', '-n']).split('\n').filter((l) => l.includes('hmh')).join('\n') || '(no hmh bundle)');
console.log('== running ==\n', run(['shell', 'aa', 'dump', '-l']).split('\n').filter((l) => /hmh|desktop/i.test(l)).slice(0, 5).join('\n') || '(not running)');
console.log('== screenshot ==');
const shot = run(['shell', 'snapshot_display', '-f', '/data/local/tmp/ohos-check.jpeg'], 15_000);
console.log(shot);
console.log(run(['file', 'recv', '/data/local/tmp/ohos-check.jpeg', 'G:/hmh-desktop/evidence/ohos/ohos-check.jpeg'], 15_000));
try { writeFileSync('G:/hmh-desktop/evidence/ohos/.check-done', String(Date.now())); } catch { /* ignore */ }

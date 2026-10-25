/** token 泄漏审计:.hm-tmp 与 evidence/ohos 与 ACCEPTANCE 不得含 web.token 明文。 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// runtime 的 web.token(只用于比对,不打印)
let token = '';
try {
  const cfg = JSON.parse(readFileSync(process.env.HMH_HOME ?? `${process.env.USERPROFILE}/.hmharness`, { encoding: 'utf8' }).toString());
} catch { /* HMH_HOME 是目录;config.json 在其下 */ }
let cfgPath = `${process.env.HMH_HOME ?? process.env.USERPROFILE + '/.hmharness'}/config.json`;
let webToken = '';
try {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  webToken = cfg?.web?.token ?? '';
} catch (e) { console.log('config read fail:', String(e).slice(0, 80)); }
console.log('web.token present:', webToken !== '', 'len:', webToken.length);

const scan = (dir) => {
  const hits = [];
  for (const f of readdirSync(dir)) {
    const p = `${dir}/${f}`;
    let t = '';
    try { t = readFileSync(p, 'utf8'); } catch { continue; }
    if (webToken !== '' && t.includes(webToken)) hits.push(p);
  }
  return hits;
};
const leak1 = scan('G:/hmh-desktop/.hm-tmp');
const leak2 = scan('G:/hmh-desktop/evidence/ohos');
console.log('leaks in .hm-tmp:', leak1.length === 0 ? '无' : leak1.join(', '));
console.log('leaks in evidence/ohos:', leak2.length === 0 ? '无' : leak2.join(', '));

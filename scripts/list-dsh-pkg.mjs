/** 列解包结构(独立目录)。 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 每包解到独立目录
const out = 'G:/hmh-desktop/evidence/dsh/src';
for (const pkg of ['dsh-web-frontend', 'dsh-client-ui-chat']) {
  const dir = `${out}/${pkg}`;
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', `G:/hmh-desktop/.hm-tmp/${pkg}.tgz`, '-C', dir], { timeout: 30000 });
  } catch { /* already */ }
}
const list = (d, pre, depth, acc) => {
  if (depth > 4) return acc;
  let es = [];
  try { es = readdirSync(d); } catch { return acc; }
  for (const f of es) {
    if (f.length > 45) continue;
    const p = `${d}/${f}`;
    const st = statSync(p);
    acc.push(`${pre}${f}${st.isDirectory() ? '/' : ` ${st.size}b`}`);
    if (st.isDirectory()) list(p, `${pre}  `, depth + 1, acc);
  }
  return acc;
};
const lines = [
  ...list(`${out}/dsh-web-frontend`, '', 0, []),
  '=== chat ===',
  ...list(`${out}/dsh-client-ui-chat`, '', 0, []),
];
writeFileSync(`${out}/tree.txt`, lines.join('\n'), 'utf8');
console.log(lines.slice(0, 40).join('\n'));

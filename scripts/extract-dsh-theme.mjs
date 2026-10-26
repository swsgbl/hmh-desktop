/** 提取 dsh alias 主题映射(深浅双主题)——设计蓝本核心。 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const assets = 'G:/hmh-desktop/evidence/dsh/src/dsh-web-frontend/package/dist/assets';
let all = '';
for (const f of readdirSync(assets)) {
  if (f.endsWith('.css')) all += readFileSync(`${assets}/${f}`, 'utf8');
}
// alias 定义(含 dark/light 选择器块)
const aliasBlocks = (all.match(/[^{}]*(?:dark|light|data-theme|\.theme)[^{}]*\{[^}]*--dsw-alias[^}]*\}/g) ?? []);
// 以及所有含 --dsw-alias- 定义的规则块
const ruleBlocks = all.split('}').map((s) => s + '}').filter((s) => s.includes('--dsw-alias-'));
const out = [...new Set([...ruleBlocks, ...aliasBlocks])].join('\n\n');
writeFileSync('G:/hmh-desktop/evidence/dsh/src/alias-theme.css', out, 'utf8');
console.log('alias rule blocks:', new Set([...ruleBlocks, ...aliasBlocks]).size, 'bytes:', out.length);

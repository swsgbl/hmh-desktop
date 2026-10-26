/** 从 dsh-web-frontend dist 提取 CSS 主文件的设计 token。 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dist = 'G:/hmh-desktop/evidence/dsh/src/dsh-web-frontend/package/dist';
const cssFiles = readdirSync(`${dist}/assets`).filter((f) => f.endsWith('.css'));
console.log('css files:', cssFiles.join(', '));
let all = '';
for (const f of cssFiles) all += readFileSync(`${dist}/assets/${f}`, 'utf8');
console.log('css bytes:', all.length);
// 1) :root 变量定义块
const rootBlocks = all.match(/:root[^{]*\{[^}]+\}/g) ?? [];
writeFileSync('G:/hmh-desktop/evidence/dsh/src/root-vars.css', rootBlocks.join('\n\n'), 'utf8');
console.log('root blocks:', rootBlocks.length, 'bytes:', rootBlocks.join('').length);
// 2) 常见设计变量名采样
const vars = [...new Set((all.match(/--[a-z][a-z0-9-]+(?=\s*:)/g) ?? []))];
console.log('unique vars:', vars.length);
console.log(vars.slice(0, 60).join('\n'));
writeFileSync('G:/hmh-desktop/evidence/dsh/src/var-names.txt', vars.join('\n'), 'utf8');

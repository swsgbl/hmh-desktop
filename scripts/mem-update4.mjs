/** 记忆:0.23.40 npm 发布收官。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('npm 0.23.40 已发')) { console.log('already'); process.exit(0); }
const add = `\n**npm 0.23.40 发布收官(43b4161)**:用户提供 Granular token→publish-02340.mjs 驱动(token 经 env 临时注入 ~/.npmrc,发布完 finally 清除;脚本无 token 字面量;验证 npmrc 零残留)→publish.cjs 16 包顺序发布→**npm registry 16/16 全部 0.23.40**(npm view 逐包验证)。**发版材料链=CHANGELOG+release-notes.json(packages/cli/)+website 四文件一致性+publish-preflight.cjs+tag+本地 publish.cjs(token)**;CI publish workflow 全历史 failure 属摆设,本地链才是真流程。桌面 v0.2.6 内置内核已带 0.23.40(早于 npm 发布,同源码)。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('updated');

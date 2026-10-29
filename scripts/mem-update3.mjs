/** 记忆:第三十轮。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('第三十轮')) { console.log('already'); process.exit(0); }
const add = `\n**第三十轮(36f2196/b658bf5,2026-10-26)v0.2.6+hmharness 0.23.40 发版**:全面回归全绿(向导 35/35+real-task 11/11+安全 7/7+鸿蒙 68/68+零泄漏)→桌面 v0.2.6(内置内核从 0.23.40 源码重打带挂死修复)+HAP 0.2.6 双端 Releases+装回。hmharness 0.23.40:CHANGELOG+17 包版本+briefing(release-notes.json 在 packages/cli/)+website 四文件一致性+预检过+tag 已推——**CI publish workflow 全历史 failure(0.23.33 起每次,实为摆设;真发版=本地 publish.cjs)且本机无 npm 登录态→npm 发布待用户 Granular token**。发现:hmharness 发版一致性五件套=CHANGELOG/release-notes.json/llms.txt/llms-full.txt/index.html+faq.html。桌面 commit message 含中文长破折号曾致 git 129——纯 ASCII message 稳。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('updated');

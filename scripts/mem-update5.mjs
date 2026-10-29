/** 记忆:CI publish 修复收官。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('CI publish 根修收官')) { console.log('already'); process.exit(0); }
const add = `\n**CI publish 根修收官(ac529d5,2026-10-26)**:0.23.33 起全部 CI failure 的真根因=**全新 npm install 给子包装嵌套实体 @hmharness/*(registry 旧版)遮蔽 workspace 链接**——agent tsc 读到无 signal 的 0.23.39 声明(traceResolution 定位解析到 packages/agent/node_modules/;本地开发从不触发因本地 node_modules 无嵌套)。修复三件套:workflow 加 build 步骤+install 后清嵌套(PS 清 packages/*/node_modules/@hmharness)+挂点续跑;终验 run 40346907585:清 9 包→build 全过→953→PREFLIGHT OK→swsgbl 认证(NPM_TOKEN secret 有效)→正确停在 changed-source-without-bump 防呆(0.23.40 已发+tag 后又推 CI 修复=预期)。**从此推 tag 即全自动发版**。调试方法沉淀:manual-chain.mjs 逐步建+kernelState 跟踪/tsc --traceResolution 找真实解析目标。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('updated');

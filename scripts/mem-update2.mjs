/** 记忆更新:runt住死修复收官。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('第二十九轮')) { console.log('already'); process.exit(0); }
const add = `\n**第二十九轮(5299c8d,2026-10-26)runtime 挂死根修**:登记多时的"interrupt 无效/空壳会话永久 busy"由 Claude Code 修复(G:\\hmharness 44ee943):根因=busy 只在子进程 exit 清+interrupt 只写 stdin abort+signal 不进飞行中 provider.chat(keep-alive ping 挂起 SSE 时 180s 流保护被刷新→永不返回);三层修复(kernel ChatOptions.signal 贯穿 fetch+loop 传递/web interrupt 5s 宽限后 kill 兜底/busy 竞态锁存);**Zode 亲验:953/953 零回退(新增 interrupt-race/stuck 测试)+复现脚本实测 busy 0s 清除**;发版 PINS 同步分拆独立 chore;双镜像推送。**发版留用户裁决(修复已在源码,源码发现模式立即生效;内置 runtime bundle 下次重打包时带入)**。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('updated');

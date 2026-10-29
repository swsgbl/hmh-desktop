/** 记忆:release 页选包指南。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('选包指南')) { console.log('already'); process.exit(0); }
const add = `\n**Release 页选包指南(4caa917,2026-10-26)**:用户反馈"没接触过深开鸿的根本不知道哪个包是什么系统"——v0.2.6 notes 重写:一句话选包表+Windows 适用范围(Win10/11 x64,不支持 7/8/32 位/ARM 原生;Setup 内置内核开箱即用)+**深开鸿科普**(OpenHarmony=底座,HarmonyOS NEXT/KaihongOS=发行版,类比 Linux 内核 vs Ubuntu/Debian;HAP=API23+/架构不限;签名限制如实)+其他 OS 段(npm CLI 即用)。历史 v0.2.0-0.2.5 全盖"请用 v0.2.6"指针(gh release edit;API PATCH 401 无权限走 gh CLI)。README 同步选包表+科普。**教训:面向公众的 Release 页要当用户完全不懂你的生态来写——每个包必须标注操作系统/架构/前置条件**。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('updated');

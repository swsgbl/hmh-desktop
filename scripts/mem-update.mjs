/** 记忆更新(独立脚本)。 */
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'C:/Users/hongfu/.zcode/cli/memories/projects/hmharness-753ac60028695054/memory/hmh-desktop-line.md';
let s = readFileSync(p, 'utf8');
if (s.includes('第二十八轮')) { console.log('already'); process.exit(0); }
const add = `\n**第二十八轮(28b100d,2026-10-26)v0.2.5 开箱即用+智能安装向导**:用户需求"有 CLI 默认共享/没有自己下载/默认全局配置/成熟安装步骤"——双端全量落地。Windows(Claude Code:v5 fc13fd8 内置 runtime esbuild 单文件 1.39MB/226 模块,新机器装完直连,外部优先零破坏,+0.46MB;v5.1 6c94582 六步向导:欢迎→检测(有 hmh→默认共享推荐)→三选一(下载完整 CLI(npm/自研 tgz 双路径+镜像+进度)/内置/演示)→Provider→完成,持久+重入):Zode 亲验 TC/46 单测(10 新)/35 向导 UIVERIFY/WZ3 npm 完整链 4-4(44 包 6s→热切换→连上)/安全 7-7(补 v4 漏项)。深开鸿(hmharness:v6 3bde5d7+v6.1 df090eb+收官 f2450c4):设备装 hmharness 15 包本地共享 L1-L4(应用 ESTABLISHED/三端同核同屏)+一键 deploy-local-kernel+SW1-4 向导(探测 127.0.0.1 自动连本地);68/68。Releases v0.2.5 双端资产;**Claude Code 限流再现实锤=配额常态,退避重试是标准动作**。\n`;
const anchor = 'NSIS assisted 静默必须';
s = s.replace(anchor, `${add}\n${anchor}`);
writeFileSync(p, s, 'utf8');
console.log('memory updated');

/** Claude Code headless:v5.1 智能安装向导。 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = `你是 Claude Code,承接 Zode 签发的任务。完整阅读并严格遵循 G:\\hmh-desktop\\docs\\prompts\\hmh-windows-dev-prompt-v51.md(Windows 版首启智能安装向导:检测已有 hmh CLI 默认共享/未装则向导三选一(下载安装完整 CLI 默认全局配置/内置精简内核/演示)/成熟安装步骤(欢迎→检测→选择→安装进度→配置→完成)/全局配置提示)。工程约束:main 新 IPC(detect-runtime/install-runtime+进度事件)、禁改 apps/ohos 与 G:\\hmharness、全套验证绿+向导 UIVERIFY 新步、证据 evidence/setup-wizard/。完成后 git commit(v5.1 安装向导)。`;
writeFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt-v51.txt', prompt, 'utf8');
const child = spawn(process.execPath, [
  'C:/Users/hongfu/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
  '-p', prompt, '--dangerously-skip-permissions',
], {
  cwd: 'G:/hmh-desktop',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' },
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (code) => {
  writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v51.log', out, 'utf8');
  console.log(`CLAUDE-EXIT ${code}; ${out.length}b`);
});
setTimeout(() => { try { child.kill(); } catch {} writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v51.log', out + '\n[TIMEOUT]', 'utf8'); console.log('CLAUDE-TIMEOUT'); }, 3_600_000);

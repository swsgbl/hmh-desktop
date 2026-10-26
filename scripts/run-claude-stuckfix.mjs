/** Claude Code headless:runtime 挂死修复(G:\hmharness)。 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = `你是 Claude Code,承接 Zode 签发的修复任务。完整阅读并严格遵循 G:\\hmh-desktop\\docs\\prompts\\hmharness-fix-stuck-executor.md(修复 G:\\hmharness 生产仓的"执行器挂死时 interrupt 无效/空壳会话永久 busy"缺陷):先定位/复现(server.ts+task-runner 的 busy 置位清除全路径),最小侵入修复(AbortController 贯穿/provider 超时/interrupt 兜底强清),补单测+全量测试零回退(855+ 基线),禁升版本禁发版,diff 最小聚焦。完成后在 G:\\hmharness git commit(注明根因)。`;
writeFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt-stuck.txt', prompt, 'utf8');
const child = spawn(process.execPath, [
  'C:/Users/hongfu/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
  '-p', prompt, '--dangerously-skip-permissions',
], {
  cwd: 'G:/hmharness',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' },
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (code) => {
  writeFileSync('G:/hmh-desktop/.hm-tmp/claude-stuckfix.log', out, 'utf8');
  console.log(`CLAUDE-EXIT ${code}; ${out.length}b`);
});
setTimeout(() => { try { child.kill(); } catch {} writeFileSync('G:/hmh-desktop/.hm-tmp/claude-stuckfix.log', out + '\n[TIMEOUT]', 'utf8'); console.log('CLAUDE-TIMEOUT'); }, 3_600_000);

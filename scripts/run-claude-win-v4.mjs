/** 直接用 node 驱动 Claude Code headless(绕开 PowerShell 编码坑)。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = `你是 Claude Code,承接 Zode 签发的开发任务。完整阅读并严格遵循 G:\\hmh-desktop\\docs\\prompts\\hmh-windows-dev-prompt-v4.md(Windows 版 DSH 设计风格全面重设计;设计蓝本 docs/prompts/design-language-dsh.md 是唯一视觉真相;证据 evidence/dsh/src/alias-theme.css)。要点:ui-tokens 重写为 DSH alias 语义 token(深浅双主题,浅色默认)/app.css 全量换肤(胶囊按钮/8px 输入/12px 菜单/#3964fe 品牌)/布局功能零改动/验证全绿(typecheck+36 单测+UIVERIFY fake 31)/禁改 apps/ohos 与 G:\\hmharness。开始执行,完成后 git commit(message 注明 v4 DSH 设计语言)。`;
writeFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt.txt', prompt, 'utf8');

const child = spawn(process.execPath, [
  'C:/Users/hongfu/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
  '-p', prompt,
  '--dangerously-skip-permissions',
], {
  cwd: 'G:/hmh-desktop',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe' },
});
let out = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (code) => {
  writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v4.log', out, 'utf8');
  console.log(`CLAUDE-EXIT ${code}; output ${out.length} bytes → .hm-tmp/claude-win-v4.log`);
});
setTimeout(() => { try { child.kill(); } catch {} writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v4.log', out + '\n[TIMEOUT 80min]', 'utf8'); console.log('CLAUDE-TIMEOUT'); }, 4_800_000);

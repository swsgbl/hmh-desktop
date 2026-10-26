/** Claude Code headless:v5 内置 runtime。 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = `你是 Claude Code,承接 Zode 签发的任务。完整阅读并严格遵循 G:\\hmh-desktop\\docs\\prompts\\hmh-windows-dev-prompt-v5.md(Windows 版内置 runtime——开箱即用):esbuild 把 G:\\hmharness 的 packages/web/src/desktop-host.ts 打成单文件 resources/runtime.cjs(零 npm 依赖,node: 全 external);main 发现顺序加内置兜底(外部优先,内置保新机器);打包 extraResources;新增"无外部 runtime 环境"验证(连内置,实证留 evidence/bundled-runtime/);全套验证绿。禁改 apps/ohos 与 G:\\hmharness。完成后 git commit(v5 内置 runtime)。`;
writeFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt-v5.txt', prompt, 'utf8');

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
  writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v5.log', out, 'utf8');
  console.log(`CLAUDE-EXIT ${code}; ${out.length}b → .hm-tmp/claude-win-v5.log`);
});
setTimeout(() => { try { child.kill(); } catch {} writeFileSync('G:/hmh-desktop/.hm-tmp/claude-win-v5.log', out + '\n[TIMEOUT]', 'utf8'); console.log('CLAUDE-TIMEOUT'); }, 3_600_000);

/** Claude Code 带重试驱动(限流 529 时 20 分钟后重试,最多 3 次)。 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = readFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt.txt', 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`attempt ${attempt} @ ${new Date().toISOString()}`);
  const code = await new Promise((resolve) => {
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
    child.on('exit', (c) => {
      writeFileSync(`G:/hmh-desktop/.hm-tmp/claude-win-v4-a${attempt}.log`, out, 'utf8');
      // 529/限流 → 重试;正常退出(0)或已产出 commit → 成功
      resolve(out.includes('529') || out.includes('访问量过大') ? 529 : (c ?? 1));
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve(99); }, 3_600_000);
  });
  console.log(`attempt ${attempt} result: ${code}`);
  if (code !== 529) { console.log(code === 0 ? 'DONE' : `EXIT ${code}(非限流,停止重试)`); process.exit(0); }
  if (attempt < 3) { console.log('rate-limited, waiting 20min…'); await wait(20 * 60_000); }
}
console.log('ALL-ATTEMPTS-RATE-LIMITED');

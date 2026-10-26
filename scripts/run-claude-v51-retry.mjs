/** v5.1 带退避重试(20min×3)。 */
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const prompt = readFileSync('G:/hmh-desktop/.hm-tmp/claude-prompt-v51.txt', 'utf8');
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
      writeFileSync(`G:/hmh-desktop/.hm-tmp/claude-win-v51-a${attempt}.log`, out, 'utf8');
      const bad = out.includes('529') || out.includes('unrecognized_model') || out.length < 400;
      resolve(bad ? 529 : (c ?? 1));
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve(99); }, 3_600_000);
  });
  console.log(`attempt ${attempt}: ${code}`);
  if (code !== 529) { process.exit(0); }
  if (attempt < 3) { console.log('backoff 20min…'); await wait(20 * 60_000); }
}
console.log('ALL-RATE-LIMITED');

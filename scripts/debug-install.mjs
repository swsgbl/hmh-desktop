import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const setup = join(here, '..', 'apps', 'desktop', 'release', 'HMH-Desktop-Setup-0.1.0-alpha.0.exe');
const installDir = 'C:\\Users\\hongfu\\AppData\\Local\\Programs\\HMH Desktop';

console.log('setup exists:', existsSync(setup), existsSync(setup) ? Math.round(statSync(setup).size / 1024 / 1024) + 'MB' : '');
const p = spawn(setup, ['/S'], { stdio: 'ignore' });
p.on('error', (e) => { console.log('spawn error:', e.code); process.exit(1); });
p.on('exit', (code) => {
  console.log('setup exit code:', code);
  let n = 0;
  const iv = setInterval(() => {
    n += 1;
    if (existsSync(installDir)) {
      try {
        const files = readdirSync(installDir);
        console.log(`after ${(n * 2)}s: dir exists, ${files.length} entries:`, files.slice(0, 8).join(' | '));
        if (files.includes('HMH Desktop.exe')) {
          console.log('INSTALLED OK');
          clearInterval(iv);
          process.exit(0);
        }
      } catch (e) { console.log('readdir:', String(e).slice(0, 80)); }
    } else if (n % 5 === 0) {
      console.log(`after ${(n * 2)}s: install dir still absent`);
    }
    if (n > 45) { console.log('TIMEOUT 90s'); clearInterval(iv); process.exit(1); }
  }, 2_000);
});

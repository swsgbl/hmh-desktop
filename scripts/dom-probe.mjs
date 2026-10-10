/** DOM 探针驱动:启动打包版(real 模式),抓 DOMPROBE JSON 行落盘。 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const useDev = process.argv.includes('--dev');
const exe = useDev
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const args = useDev ? [join(root, 'apps', 'desktop', 'dist-electron', 'main', 'index.js')] : [];
const out = join(root, 'dom-probe.json');

const child = spawn(exe, args, {
  cwd: join(root, 'apps', 'desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  env: { ...process.env, HMH_DESKTOP_DOMPROBE: '1', HMH_DESKTOP_DOMPROBE_DELAY_MS: '9000' },
});
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });
child.stderr.on('data', (d) => { buf += d.toString(); });
child.on('exit', (code) => {
  const lines = buf.split(/\r?\n/).filter((l) => l.startsWith('DOMPROBE ') || l.includes('[hmh-desktop:'));
  for (const l of lines) console.log(l.slice(0, 400));
  const json = lines.find((l) => l.startsWith('DOMPROBE {'));
  if (json) {
    void writeFile(out, json.slice('DOMPROBE '.length), 'utf8').then(() => console.log(`\nwrote ${out}`));
  } else {
    console.error('no DOMPROBE line captured');
    process.exitCode = 1;
  }
  console.log(`exit=${code}`);
});
setTimeout(() => { try { child.kill(); } catch {} }, 60_000);

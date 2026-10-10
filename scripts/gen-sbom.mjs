/**
 * SBOM(CycloneDX)生成:发布产物溯源(02 号路线图 4.3 供应链要求的最小落地)。
 * 产物:build/sbom.json(含依赖树;dev 依赖在生产包不出现,此处全量记录)。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'build'), { recursive: true });

const out = join(root, 'build', 'sbom.json');
// npm_execpath:调用我们的 npm 可执行文件(由 npm run 传入);直跑回退 npm.cmd
const npmExec = process.env.npm_execpath ?? 'npm';
const isJs = npmExec.endsWith('.js') || npmExec.endsWith('.cjs') || npmExec.endsWith('.mjs');
const child = isJs
  ? spawn(process.execPath, [npmExec, 'sbom', '--sbom-format', 'cyclonedx'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  : spawn(npmExec, ['sbom', '--sbom-format', 'cyclonedx'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: true });
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });
child.on('exit', (code) => {
  if (code !== 0) {
    console.error('npm sbom failed');
    process.exit(1);
  }
  writeFileSync(out, buf);
  console.log(`SBOM → ${out} (${buf.length} bytes)`);
});

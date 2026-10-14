/** dump DSH workspace/session 相关 UI 包 + 关键词上下文。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const fd = readFileSync('C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources/app.asar');
let jsonLen = 0, hdrBase = 0;
for (let i = 0; i < 4096; i++) { if (fd[i] === 0x7b) { hdrBase = i; jsonLen = fd.readUInt32LE(i - 4); break; } }
const header = JSON.parse(fd.slice(hdrBase, hdrBase + jsonLen).toString('utf8'));
const readAsar = (node) => {
  const off = Number(node.offset) + hdrBase + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
const scoped = header.files.node_modules.files['@deepseek-ai'].files;
const all = Object.keys(scoped);
console.log('all packages:', all.length);
console.log(all.slice(60).join(', '));
const wanted = all.filter((p) => /workspace|session|conversation|goal|sidebar|chat\b|new-chat/.test(p));
console.log('\nwanted:', wanted.join(', '));
const outDir = 'C:/Users/hongfu/AppData/Local/Temp/dsh-ref';
mkdirSync(outDir, { recursive: true });
let corpus = '';
for (const pkg of wanted) {
  const node = scoped[pkg];
  const walk = (dir, pre) => {
    for (const [n, m] of Object.entries(dir.files ?? {})) {
      if (m.files !== undefined) { walk(m, `${pre}.${n}`); continue; }
      if (!/\.m?js$/.test(n)) continue;
      const txt = readAsar(m);
      corpus += txt;
      writeFileSync(`${outDir}/${pkg}--${pre}${n}`, txt);
    }
  };
  if (node !== undefined) walk(node, '');
}
console.log(`corpus ${Math.round(corpus.length / 1e6)}MB`);
for (const k of ['工作区', 'workspace', 'WorkspacePicker', 'newSession', '新建会话', 'cwd', 'pickWorkspace', 'workspaceId']) {
  console.log(`  ${k}: ${corpus.split(k).length - 1}`);
}

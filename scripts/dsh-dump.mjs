/** 提取 DSH 关键功能包源码到本地临时目录,供对标分析。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const fd = readFileSync('C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources/app.asar');
let jsonLen = 0;
let hdrBase = 0;
for (let i = 0; i < 4096; i++) {
  if (fd[i] === 0x7b) { hdrBase = i; jsonLen = fd.readUInt32LE(i - 4); break; }
}
const header = JSON.parse(fd.slice(hdrBase, hdrBase + jsonLen).toString('utf8'));
const readAsar = (node) => {
  const off = Number(node.offset) + hdrBase + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
const scoped = header.files.node_modules.files['@deepseek-ai'].files;
const wanted = [
  'dsh-client-ui-attachment', 'dsh-attachment-local', 'dsh-client-file-upload',
  'dsh-client-locale', 'dsh-client-ui-directory-picker-browse', 'dsh-client-ui-directory-picker-native',
];
const outDir = 'C:/Users/hongfu/AppData/Local/Temp/dsh-ref';
mkdirSync(outDir, { recursive: true });
for (const pkg of wanted) {
  const node = scoped[pkg];
  if (node === undefined) { console.log(`MISSING ${pkg}`); continue; }
  const walk = (dir, pre) => {
    for (const [n, m] of Object.entries(dir.files ?? {})) {
      if (m.files !== undefined) { walk(m, `${pre}.${n}`); continue; }
      if (!/\.(js|cjs|mjs|yaml|json)$/.test(n)) continue;
      writeFileSync(`${outDir}/${pkg}--${pre}${n}`, readAsar(m));
      console.log(`dumped ${pkg}/${pre}${n} (${m.size})`);
    }
  };
  walk(node, '');
}

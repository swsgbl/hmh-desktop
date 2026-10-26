/** 从 DSH GitHub 拉设计系统源文件(UI tokens/theme/css 变量)。 */
import { writeFileSync, mkdirSync } from 'node:fs';

const out = 'G:/hmh-desktop/evidence/dsh/src';
mkdirSync(out, { recursive: true });

// dsh-desktop 仓库:src 结构先探
const files = [
  // 可能的设计 token 位置(逐个试)
  'src/renderer/src/styles/variables.css',
  'src/renderer/src/styles/tokens.css',
  'src/renderer/styles/variables.css',
  'src/renderer/src/App.css',
  'src/renderer/src/main.css',
];
for (const f of files) {
  const r = await fetch(`https://raw.githubusercontent.com/dataelement/dsh-desktop/main/${f}`).catch(() => null);
  if (r !== null && r.ok) {
    const t = await r.text();
    writeFileSync(`${out}/${f.split('/').pop()}`, t, 'utf8');
    console.log('OK', f, t.length);
  } else {
    console.log('miss', f, r?.status ?? 'err');
  }
}
// 仓库树探 src 结构
const tree = await (await fetch('https://api.github.com/repos/dataelement/dsh-desktop/git/trees/main?recursive=1')).json();
const css = (tree.tree ?? []).filter((n) => /\.(css|scss|less)$/.test(n.path) && n.type === 'blob').map((n) => n.path);
console.log('css files in repo:', css.length);
for (const c of css.slice(0, 40)) console.log(' ', c);
writeFileSync(`${out}/css-list.txt`, css.join('\n'), 'utf8');

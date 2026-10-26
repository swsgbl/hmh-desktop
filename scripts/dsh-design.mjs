/** 挖 DSH 设计系统:asar 里找 CSS 变量定义/色板/字体/圆角。 */
import { readFileSync } from 'node:fs';

const fd = readFileSync('C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources/app.asar');
let jsonLen = 0, hdrBase = 0;
for (let i = 0; i < 4096; i++) { if (fd[i] === 0x7b) { hdrBase = i; jsonLen = fd.readUInt32LE(i - 4); break; } }
const header = JSON.parse(fd.slice(hdrBase, hdrBase + jsonLen).toString('utf8'));
const readAsar = (node) => {
  const off = Number(node.offset) + hdrBase + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
// 找 renderer 的 css/js(含 --dsw 变量定义)
const scoped = header.files.node_modules.files['@deepseek-ai'].files;
let corpus = '';
for (const [pkg, node] of Object.entries(scoped)) {
  for (const [n, m] of Object.entries(node.files ?? {})) {
    if (m.files !== undefined || !/\.(css|m?js)$/.test(n)) continue;
    const t = readAsar(m);
    if (t.includes('--dsw-')) corpus += t;
  }
}
console.log('corpus with --dsw:', Math.round(corpus.length / 1e6), 'MB');
// 提取 :root/--dsw-alias 定义块
const roots = corpus.match(/--dsw-[a-z-]+:\s*[^;}]+/gi) ?? [];
const uniq = [...new Set(roots.map((s) => s.replace(/\s+/g, ' ')))];
console.log('unique --dsw tokens:', uniq.length);
// 只打印 alias(语义层)与基础色
for (const t of uniq.filter((s) => /alias|bg|color|font|radius|space|border/.test(s)).slice(0, 80)) console.log(' ', t);
// 字体与圆角线索
for (const t of uniq.filter((s) => /radius|height|space|gap/.test(s)).slice(0, 30)) console.log(' R', t);

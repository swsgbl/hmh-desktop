/** 解析 DSH Desktop 的 app.asar:列目录树(截断)+读 package.json。 */
import { readFileSync } from 'node:fs';

const asar = 'C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources/app.asar';
const fd = readFileSync(asar);
// asar pickle 头:尝试两种布局,找到以 '{' 开头的 JSON
let jsonLen = 0;
let base = 0;
for (const [lenOff, start] of [[4, 8], [8, 12]]) {
  const len = fd.readUInt32LE(lenOff);
  if (len > 0 && len < 50_000_000 && fd[start] === 0x7b) { jsonLen = len; base = start; break; }
}
if (base === 0) {
  // 兜底:扫描前 4KB 找第一个 '{'
  for (let i = 0; i < 4096; i++) {
    if (fd[i] === 0x7b) { base = i; jsonLen = fd.readUInt32LE(i - 4); break; }
  }
}
console.log(`header: jsonLen=${jsonLen} base=${base}`);
const header = JSON.parse(fd.slice(base, base + jsonLen).toString('utf8'));

const files = header.files ?? {};
console.log('== top-level ==');
for (const [name, meta] of Object.entries(files)) {
  console.log(name, meta.files ? `(dir, ${Object.keys(meta.files).length} entries)` : `(${meta.size ?? '?'} bytes @${meta.offset ?? '?'})`);
}
const readAsarFile = (node) => {
  const off = Number(node.offset) + 8 + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
if (files['package.json'] !== undefined) {
  console.log('\n== package.json ==');
  console.log(readAsarFile(files['package.json']).slice(0, 2500));
}
if (files['out']?.files !== undefined) {
  console.log('\n== out/ ==');
  for (const [n, m] of Object.entries(files['out'].files)) {
    console.log(n, m.files ? `(dir, ${Object.keys(m.files).length})` : `(${m.size})`);
  }
}

// 深挖:node_modules/@deepseek-ai/dsh-* 包的 JS 是功能本体
const readAsar = (node) => {
  const off = Number(node.offset) + base + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
const collect = (node, acc, prefix = '') => {
  for (const [n, m] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${n}`;
    if (m.files !== undefined) collect(m, acc, p);
    else if (p.includes('@deepseek-ai') && /\.m?js$/.test(n)) acc.push([p, m]);
  }
  return acc;
};
const jsFiles = collect(files, []);
console.log(`\n@deepseek-ai js files: ${jsFiles.length}`);
let corpus = '';
for (const [n, m] of jsFiles) {
  if (Number(m.size) > 8_000_000) continue;
  corpus += readAsar(m);
}
console.log(`corpus: ${Math.round(corpus.length / 1e6)}MB`);
const keywords = ['粘贴', '上传', '拖拽', '拖放', 'drop', 'paste', 'clipboard', 'image', '图片', '截图', 'language', '语言', '中文', 'English', 'folder', '文件夹', '工作区', 'session-history', '会话'];
for (const k of keywords) {
  console.log(`  ${k}: ${corpus.split(k).length - 1}`);
}



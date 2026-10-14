/** 读 DSH out/main/index.js(+preload),量化功能关键词与关键 UI 文案。 */
import { readFileSync } from 'node:fs';

const base = 'C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources';
const fd = readFileSync(`${base}/app.asar`);
let jsonLen = 0;
let hdrBase = 0;
for (const [lenOff, start] of [[4, 8], [8, 12], [12, 16]]) {
  const len = fd.readUInt32LE(lenOff);
  if (len > 0 && len < 50_000_000 && fd[start] === 0x7b) { jsonLen = len; hdrBase = start; break; }
}
if (hdrBase === 0) {
  for (let i = 0; i < 4096; i++) {
    if (fd[i] === 0x7b) { hdrBase = i; jsonLen = fd.readUInt32LE(i - 4); break; }
  }
}
const header = JSON.parse(fd.slice(hdrBase, hdrBase + jsonLen).toString('utf8'));
const readAsar = (node) => {
  const off = Number(node.offset) + hdrBase + jsonLen;
  return fd.slice(off, off + Number(node.size)).toString('utf8');
};
const listDir = (label, node) => {
  console.log(`== ${label} ==`);
  for (const [n, m] of Object.entries(node.files ?? {})) console.log(' ', n, m.files ? '(dir)' : `(${m.size})`);
};
listDir('out', header.files.out);
listDir('out/main', header.files.out.files.main);
listDir('out/preload', header.files.out.files.preload);

let corpus = '';
for (const dir of ['main', 'preload']) {
  for (const [n, m] of Object.entries(header.files.out.files[dir].files ?? {})) {
    if (m.files === undefined && /\.m?js$/.test(n) && Number(m.size) < 200_000_000) corpus += readAsar(m);
  }
}
console.log(`corpus: ${Math.round(corpus.length / 1e6)}MB`);
const kws = ['粘贴', '上传', '拖放', '拖拽', 'drop', 'paste', 'clipboard', 'readImage', 'image/', '图片', '截图', '语言', '中文', 'English', 'zh-CN', 'folder', '文件夹', '选择文件夹', '工作区', 'approval', '会话'];
for (const k of kws) console.log(`  ${k}: ${corpus.split(k).length - 1}`);

// 提取语言切换/附件相关的上下文片段
const ctx = (k, n = 2) => {
  let i = 0;
  const out = [];
  while (out.length < n) {
    i = corpus.indexOf(k, i);
    if (i < 0) break;
    out.push(corpus.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' '));
    i += k.length;
  }
  return out;
};
for (const k of ['粘贴', '语言', '文件夹']) {
  console.log(`\n-- ctx ${k} --`);
  for (const c of ctx(k)) console.log('   …' + c + '…');
}

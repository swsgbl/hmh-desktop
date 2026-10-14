/** 列出 DSH asar 里 node_modules/@deepseek-ai 的包结构与示例文件。 */
import { readFileSync } from 'node:fs';

const fd = readFileSync('C:/Users/hongfu/AppData/Local/Programs/DSH Desktop/resources/app.asar');
let jsonLen = 0;
let hdrBase = 0;
for (let i = 0; i < 4096; i++) {
  if (fd[i] === 0x7b) { hdrBase = i; jsonLen = fd.readUInt32LE(i - 4); break; }
}
const header = JSON.parse(fd.slice(hdrBase, hdrBase + jsonLen).toString('utf8'));
const nm = header.files.node_modules.files;
console.log('node_modules entries:', Object.keys(nm).length);
console.log('sample:', Object.keys(nm).slice(0, 10).join(', '));
const scoped = nm['@deepseek-ai'];
if (scoped === undefined) {
  console.log('no @deepseek-ai scope');
} else {
  const pkgs = Object.keys(scoped.files ?? {});
  console.log(`@deepseek-ai packages: ${pkgs.length}`);
  console.log(pkgs.slice(0, 60).join(', '));
  // 看一个 UI 包的文件布局
  for (const probe of ['dsh-client-ui-attachment', 'dsh-client-locale', 'dsh-attachment-local', 'dsh-client-ui-chat-input']) {
    const p = scoped.files[probe];
    if (p === undefined) continue;
    console.log(`\n-- ${probe} --`);
    const walk = (node, pre) => {
      for (const [n, m] of Object.entries(node.files ?? {})) {
        if (m.files !== undefined) walk(m, `${pre}/${n}`);
        else console.log(`  ${pre}/${n} (${m.size}${m.unpacked ? ' unpacked' : ''})`);
      }
    };
    walk(p, probe);
  }
}

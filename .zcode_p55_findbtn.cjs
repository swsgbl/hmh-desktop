const fs = require('fs');
const t = fs.readFileSync('G:/hmh-desktop/p55_layout.json', 'utf8');
const re = /"text"\s*:\s*"跳过"/g;
let m;
while ((m = re.exec(t)) !== null) {
  const seg = t.substring(Math.max(0, m.index - 3000), m.index + 60);
  const all = [...seg.matchAll(/"bounds"\s*:\s*\[([^\]]+)\]/g)];
  if (all.length) console.log('跳过 bounds:', all[all.length - 1][1]);
}
const re2 = /"text"\s*:\s*"下一步"/g;
while ((m = re2.exec(t)) !== null) {
  const seg = t.substring(Math.max(0, m.index - 3000), m.index + 60);
  const all = [...seg.matchAll(/"bounds"\s*:\s*\[([^\]]+)\]/g)];
  if (all.length) console.log('下一步 bounds:', all[all.length - 1][1]);
}

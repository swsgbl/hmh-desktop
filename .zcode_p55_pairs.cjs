const fs = require('fs');
// dump fresh layout from device? no - use existing recv flow. This script prints texts + bounds pairs from a layout json.
const p = process.argv[2] || 'G:/hmh-desktop/p55_layout.json';
const t = fs.readFileSync(p, 'utf8');
// ArkUI layout: each attribute block has "text":"X" and "origBounds":"[..][..]" — pair them by node
const re = /"origBounds":"(\[[^\]]+\]\[[^\]]+\])"[^}]*?"text":"([^"]{1,30})"/g;
let m;
const out = [];
while ((m = re.exec(t)) !== null) {
  if (m[2].trim()) out.push(m[2] + ' @ ' + m[1]);
}
// also reversed order variant
const re2 = /"text":"([^"]{1,30})"[^}]*?"origBounds":"(\[[^\]]+\]\[[^\]]+\])"/g;
const out2 = [];
while ((m = re2.exec(t)) !== null) {
  if (m[1].trim()) out2.push(m[1] + ' @ ' + m[2]);
}
console.log('--- pattern1 (bounds before text) ---');
out.forEach(x => console.log(x));
console.log('--- pattern2 (text before bounds) ---');
out2.forEach(x => console.log(x));

const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

// Fix stray "}" after handleSnapshot (patch2 residue): "  }\n}\n\n  // ---------- [P43] diff"
const re = /return snapResp\r?\n  \}\r?\n\}\r?\n\r?\n(  \/\/ ---------- \[P43\] diff)/;
if (re.test(t)) {
  t = t.replace(re, "return snapResp\n  }\n\n$1");
  console.log('stray brace fixed');
} else {
  console.log('pattern not found — checking alternative');
  const i = t.indexOf('return snapResp');
  console.log(JSON.stringify(t.substring(i, i + 90)));
  process.exit(1);
}
fs.writeFileSync(p, t);
console.log('OK len', t.length);

const fs = require('fs');
const t = fs.readFileSync('G:/hmh-desktop/p55_layout.json', 'utf8');
// print all "text" values to see what's on screen
const re = /"text"\s*:\s*"([^"]{0,40})"/g;
let m, seen = new Set();
while ((m = re.exec(t)) !== null) {
  if (m[1].trim() && !seen.has(m[1])) { seen.add(m[1]); console.log(JSON.stringify(m[1])); }
}

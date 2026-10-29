const fs = require('fs');
const p = 'D:/BrowserOS - KaihongOS/entry/src/main/ets/service/MCPServer.ets';
let t = fs.readFileSync(p, 'utf8');

const startIdx = t.indexOf('private handleAct');
const endIdx = t.indexOf('private static readonly DOM_HELPERS');
if (startIdx < 0 || endIdx < 0) { console.log('SCOPE NOT FOUND'); process.exit(1); }
let body = t.substring(startIdx, endIdx);

// Replace the whole ref-decl block (CRLF-safe via [\s\S]*?)
const re = /const ref = \(params\['ref'\] as string\) \|\| \(params\['selector'\] as string\)[\s\S]*?const sel = selectorArg/;
const newBlock = [
  "const ref = (params['ref'] as string) || (params['selector'] as string)",
  "    // P55: Stable SnapshotRef - e<N> refs from snapshot resolve to [data-bcp-ref] CSS selector",
  "    let sel = ''",
  "    if (ref && /^e\\d+$/.test(ref)) {",
  "      sel = `[data-bcp-ref=\"${ref}\"]`",
  "    } else {",
  "      sel = ref",
  "    }"
].join('\n');
if (!re.test(body)) { console.log('DECL BLOCK NOT FOUND'); process.exit(1); }
body = body.replace(re, newBlock);

// engine + helper calls: use resolved sel
body = body.split('BCPEngine.click(ref)').join('BCPEngine.click(sel)');
body = body.split('BCPEngine.type(ref, text)').join('BCPEngine.type(sel, text)');
body = body.split('${JSON.stringify(ref)}').join('${JSON.stringify(sel)}');

if (body.indexOf('selectorArg') >= 0) { console.log('selectorArg still present'); process.exit(1); }
if (body.indexOf("let sel = ''") < 0) { console.log('let sel missing'); process.exit(1); }

t = t.substring(0, startIdx) + body + t.substring(endIdx);
fs.writeFileSync(p, t);
console.log('ACT PATCHED len', t.length,
  'click(sel):', body.includes('BCPEngine.click(sel)'),
  'type(sel):', body.includes('BCPEngine.type(sel, text)'),
  'str(sel):', body.includes('${JSON.stringify(sel)}'));

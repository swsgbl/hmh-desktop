const http = require('http');
const { execSync } = require('child_process');
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
function sh(cmd) {
  return execSync('"' + HDC + '" -t 192.168.161.137:10178 shell "' + cmd + '"', { encoding: 'utf8', timeout: 30000 });
}
function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: 19222, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('timeout')); });
    req.write(data); req.end();
  });
}
(async () => {
  const tokRaw = sh('more /data/app/el2/100/base/com.browseros.kaihong/haps/entry/files/mcp_token.txt');
  const lines = tokRaw.split(/\r?\n/).filter(x => x.trim().length > 0);
  const token = (lines[lines.length - 1] || '').trim();
  const qs = '/mcp?token=' + token;
  let r = await post(qs, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
  const H = { 'Mcp-Session-Id': r.headers['mcp-session-id'] };
  let id = 1;
  const call = async (name, args) => {
    r = await post(qs, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, H);
    let txt = '';
    try { txt = JSON.parse(r.body).result.content[0].text; } catch (e) { txt = r.body.slice(0, 400); }
    return txt;
  };
  await call('tabs', { action: 'new', url: 'https://example.com' });
  await new Promise(r2 => setTimeout(r2, 2500));
  console.log('typeof __bcp_refs:', await call('evaluate', { expression: 'typeof window.__bcp_refs' }));
  console.log('typeof __bcp_snapshot_md:', await call('evaluate', { expression: 'typeof window.__bcp_snapshot_md' }));
  console.log('a count:', await call('evaluate', { expression: 'document.querySelectorAll("a").length' }));
  console.log('refs direct:', (await call('evaluate', { expression: 'window.__bcp_refs ? window.__bcp_refs().substring(0,300) : "NOFN"' })));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

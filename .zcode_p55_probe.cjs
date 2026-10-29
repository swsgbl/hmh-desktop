const http = require('http');
const HDC = 'C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe';
const { execSync } = require('child_process');

function sh(cmd) {
  return execSync('"' + HDC + '" -t 192.168.161.137:10178 shell "' + cmd + '"', { encoding: 'utf8', timeout: 30000 });
}

// read token from device
const tokRaw = sh('more /data/app/el2/100/base/com.browseros.kaihong/haps/entry/files/mcp_token.txt');
const lines = tokRaw.split(/\r?\n/).filter(x => x.trim().length > 0);
const token = (lines[lines.length - 1] || '').trim();
console.log('token:', token.length, 'tail', token.slice(-4));

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: 19222, path: path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

(async () => {
  const qs = '/mcp?token=' + token;
  // initialize
  let r = await post(qs, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p55-probe', version: '1' } } });
  const sid = r.headers['mcp-session-id'];
  console.log('init:', r.code, 'sid=', sid && sid.slice(0, 8));
  const shdr = { 'Mcp-Session-Id': sid };
  // tabs new
  r = await post(qs, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tabs', arguments: { action: 'new', url: 'about:blank' } } }, shdr);
  console.log('tabs.new:', r.body.slice(0, 300));
  // navigate
  r = await post(qs, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'navigate', arguments: { url: 'https://example.com' } } }, shdr);
  console.log('navigate:', r.body.slice(0, 600));
  // snapshot
  r = await post(qs, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'snapshot', arguments: {} } }, shdr);
  console.log('snapshot:', r.body.slice(0, 500));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

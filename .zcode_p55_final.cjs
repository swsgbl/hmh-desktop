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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const tokRaw = sh('more /data/app/el2/100/base/com.browseros.kaihong/haps/entry/files/mcp_token.txt');
  const lines = tokRaw.split(/\r?\n/).filter(x => x.trim().length > 0);
  const token = (lines[lines.length - 1] || '').trim();
  const qs = '/mcp?token=' + token;
  let r = await post(qs, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p55-final', version: '1' } } });
  const H = { 'Mcp-Session-Id': r.headers['mcp-session-id'] };
  let id = 1;
  const call = async (name, args) => {
    r = await post(qs, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, H);
    let txt = '';
    try { txt = JSON.parse(r.body).result.content[0].text; } catch (e) { txt = r.body.slice(0, 500); }
    return txt;
  };
  await call('tabs', { action: 'new', url: 'https://www.bing.com' });
  await sleep(6000);
  const snap = await call('snapshot', {});
  let so;
  try { so = JSON.parse(snap); } catch (e) { console.log('SNAP RAW:', snap.slice(0, 400)); so = {}; }
  if (so.refCount === undefined) { console.log('SNAP RAW:', snap.slice(0, 400)); }
  console.log('snapshot refCount=', so.refCount, 'refs=', JSON.stringify(so.refs));
  console.log('content head:', (so.content || '').slice(0, 120));
  if (so.refCount > 0) {
    const act1 = await call('act', { kind: 'click', ref: 'e1' });
    console.log('act click e1:', act1.slice(0, 220));
    const act2 = await call('act', { kind: 'type', ref: 'e3', text: 'hi' });
    console.log('act type e3:', act2.slice(0, 220));
  }
  // wait selector positive
  console.log('wait #b1:', (await call('wait', { selector: '#b1', timeout: 3000 })).slice(0, 200));
  // wait selector negative (timeout error)
  console.log('wait #nope:', (await call('wait', { selector: '#nope', timeout: 2000 })).slice(0, 260));
  // read
  console.log('read:', (await call('read', {})).slice(0, 200));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

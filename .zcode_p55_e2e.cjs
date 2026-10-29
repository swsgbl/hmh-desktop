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
  let r = await post(qs, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p55-e2e', version: '1' } } });
  const sid = r.headers['mcp-session-id'];
  console.log('1. init:', r.code, 'sid=', sid.slice(0, 8));
  const H = { 'Mcp-Session-Id': sid };
  let id = 1;
  const call = async (name, args) => {
    r = await post(qs, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, H);
    let txt = '';
    try { txt = JSON.parse(r.body).result.content[0].text; } catch (e) { txt = r.body.slice(0, 300); }
    return txt;
  };

  // A. tab_groups create/join/list/leave/ungroup
  console.log('A1. groups.create:', await call('tab_groups', { action: 'create', name: 'research' }));
  const tabsTxt = await call('tabs', { action: 'new', url: 'about:blank' });
  const tabId = JSON.parse(tabsTxt).tabId;
  console.log('A2. tabs.new:', tabId);
  console.log('A3. groups.join:', await call('tab_groups', { action: 'join', group: 'research', tabIds: [tabId] }));
  console.log('A4. groups.list:', await call('tab_groups', { action: 'list' }));
  console.log('A5. groups.leave:', await call('tab_groups', { action: 'leave', group: 'research', tabId }));
  console.log('A6. groups.ungroup:', await call('tab_groups', { action: 'ungroup', group: 'research' }));

  // B. windows list
  console.log('B1. windows.list:', (await call('windows', { action: 'list' })).slice(0, 400));

  // C. snapshot -> refs -> act(e1) upstream flow
  await call('navigate', { url: 'https://example.com' });
  await sleep(3000);
  const snap1 = await call('snapshot', {});
  const snapObj = JSON.parse(snap1);
  console.log('C1. snapshot ok, refCount=', snapObj.refCount, 'content.len=', (snapObj.content || '').length);
  if (Array.isArray(snapObj.refs) && snapObj.refs.length > 0) {
    console.log('C2. first ref:', JSON.stringify(snapObj.refs[0]));
    // C3: act click via ref e1 -> selector [data-bcp-ref="e1"]
    const actTxt = await call('act', { kind: 'click', ref: 'e1' });
    console.log('C3. act click e1:', actTxt.slice(0, 200));
    // C4: act with raw e<N> passed as selector (old client style)
    const actTxt2 = await call('act', { kind: 'click', selector: 'e1' });
    console.log('C4. act click selector=e1:', actTxt2.slice(0, 200));
  } else {
    console.log('C2. NO REFS in snapshot:', snap1.slice(0, 300));
  }

  // D. wait selector
  console.log('D1. wait selector=h1:', (await call('wait', { selector: 'h1', timeout: 5000 })).slice(0, 200));
  // E. evaluate
  console.log('E1. evaluate 1+1:', await call('evaluate', { expression: '1+1' }));
  console.log('E2. evaluate banned nav:', (await call('evaluate', { expression: 'window.location.href="https://x.com"' })).slice(0, 200));
  // F. read
  console.log('F1. read:', (await call('read', {})).slice(0, 150));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

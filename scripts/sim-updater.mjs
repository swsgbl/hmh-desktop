/** 手动模拟更新器网络链:API latest → tag 比较 → asset 下载(测 302 跟随)。 */
const r = await fetch('https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest', {
  headers: { 'user-agent': 'hmh-desktop-updater' },
  signal: AbortSignal.timeout(15000),
});
console.log('API:', r.status);
const rel = await r.json();
console.log('latest tag:', rel.tag_name, '| assets:', (rel.assets ?? []).map((a) => `${a.name}(${a.url})`).join(', '));
const asset = (rel.assets ?? []).find((a) => /^HMH-Desktop-Setup-.*\.exe$/i.test(a.name));
if (asset !== undefined) {
  console.log('downloading', asset.browser_download_url);
  const d = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  console.log('asset fetch:', d.status, 'final-url-host:', new URL(d.url).host);
  const buf = Buffer.from(await d.arrayBuffer());
  console.log('downloaded bytes:', buf.length);
}

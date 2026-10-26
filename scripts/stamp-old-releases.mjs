/** 给历史版本(v0.2.0-v0.2.5)补提示:最新请用 v0.2.6+详细选包指南链接。 */
const note = (v) => `⚠️ 历史版本——请下载最新版 [v0.2.6](https://github.com/swsgbl/hmh-desktop/releases/tag/v0.2.6)（含按操作系统选包的详细指南：Windows 10/11 x64 用 Setup.exe；深开鸿/OpenHarmony 设备用 HAP）。\n\n（本版 ${v} 的原始说明见下方提交历史）`;
for (const v of ['v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.2.3', 'v0.2.4', 'v0.2.5']) {
  const r = await fetch(`https://api.github.com/repos/swsgbl/hmh-desktop/releases/tags/${v}`, { headers: { 'user-agent': 'zode' } });
  if (!r.ok) { console.log(v, 'skip', r.status); continue; }
  const rel = await r.json();
  const body = note(v) + '\n\n---\n\n' + (rel.body ?? '');
  const u = await fetch(`https://api.github.com/repos/swsgbl/hmh-desktop/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { 'user-agent': 'zode', 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  console.log(v, u.status);
}

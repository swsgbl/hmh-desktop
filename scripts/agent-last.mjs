/** 读指定会话的最后若干条消息。 */
const sid = process.argv[2];
const n = Number(process.argv[3] ?? 6);
const d = await (await fetch(`http://127.0.0.1:7788/api/sessions/${encodeURIComponent(sid)}`)).json();
console.log('cwd:', d.cwd);
for (const m of (d.messages ?? []).slice(-n)) {
  console.log('=== ' + m.role + ' tools:[' + (m.tools ?? []).join(',') + ']');
  console.log(String(m.text ?? '').slice(0, 700));
}

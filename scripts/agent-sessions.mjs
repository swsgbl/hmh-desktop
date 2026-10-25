/** 列出最近会话(带 outcome)。 */
const r = await fetch('http://127.0.0.1:7788/api/sessions?limit=10');
const d = await r.json();
for (const s of (d.sessions ?? []).slice(0, 10)) {
  console.log(s.id, '|', s.outcome, '| turns:' + s.turns, '|', String(s.task ?? s.title ?? '').slice(0, 60).replace(/\s+/g, ' '));
}

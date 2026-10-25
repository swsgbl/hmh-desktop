/** 看两个忙碌会话的任务与最后消息。 */
for (const sid of ['web-mvnwl06d', 'web-mvny1uxd']) {
  try {
    const d = await (await fetch(`http://127.0.0.1:7788/api/sessions/${encodeURIComponent(sid)}`)).json();
    console.log(`=== ${sid} cwd=${d.cwd ?? '-'} msgs=${(d.messages ?? []).length}`);
    const first = (d.messages ?? [])[0];
    if (first !== undefined) console.log('task:', String(first.text ?? '').slice(0, 120).replace(/\s+/g, ' '));
    const last = (d.messages ?? []).slice(-1)[0];
    if (last !== undefined) console.log('last:', last.role, String(last.text ?? '').slice(0, 200).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(sid, 'ERR', String(e).slice(0, 80));
  }
}

/** 看当前两个忙碌会话的任务与最后消息。 */
for (const sid of ['2026-10-25T10-11-01-uldni1', 'web-mvog8dg1']) {
  try {
    const d = await (await fetch(`http://127.0.0.1:7788/api/sessions/${encodeURIComponent(sid)}`)).json();
    const msgs = d.messages ?? [];
    console.log(`=== ${sid} cwd=${d.cwd ?? '-'} msgs=${msgs.length}`);
    const first = msgs[0];
    if (first !== undefined) console.log('task:', String(first.text ?? '').slice(0, 80).replace(/\s+/g, ' '));
    const last = msgs.slice(-1)[0];
    if (last !== undefined) console.log('last:', last.role, String(last.text ?? '').slice(0, 150).replace(/\s+/g, ' '));
  } catch (e) {
    console.log(sid, 'ERR', String(e).slice(0, 60));
  }
}

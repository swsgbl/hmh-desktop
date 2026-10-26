/** 打断指定会话并回报 busy。 */
const sid = process.argv[2];
const r = await fetch('http://127.0.0.1:7788/api/interrupt', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: sid }),
});
console.log('interrupt', sid, r.status);
await new Promise((r) => setTimeout(r, 4000));
const s = await (await fetch('http://127.0.0.1:7788/api/state')).json();
console.log('busy now:', JSON.stringify(s.busySessions));

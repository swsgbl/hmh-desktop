/** 打断卡死空壳会话→立即派 v2 棒 2(带新症状证据)。 */
const BASE = 'http://127.0.0.1:7788';

for (const sid of ['web-mvnwl06d', 'web-mvny1uxd']) {
  const r = await fetch(`${BASE}/api/interrupt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: sid }),
  });
  console.log('interrupt', sid, r.status);
}
await new Promise((r) => setTimeout(r, 3000));
const s = await (await fetch(`${BASE}/api/state`)).json();
console.log('busy now:', JSON.stringify(s.busySessions));
if (Array.isArray(s.busySessions) && s.busySessions.length > 0) {
  console.log('STILL BUSY, abort dispatch');
  process.exit(1);
}
const text = `【Zode 续棒令 · v2 棒 2 · 附新实锤症状】

棒 1 侦查简报已审(反例成立,Zode 取证有误已在案;受控重启对比照做)。**用户实测期间 Zode 抓到 P0 新实锤**:

runtime 上出现两个空壳卡死会话 web-mvnwl06d / web-mvny1uxd(0 条消息却永久 busy,系 VM 应用内发送所致,Zode 已 interrupt 清理)——即"发送→卡 busy→无回复上屏"。这大概率就是用户说"不能用"的直接体验。优先排查 app 端发送链:POST /api/task 请求体构造(sessionId 是否传了空/undefined 导致 runtime 侧会话建立异常)、响应处理、SSE 事件是否被归约丢弃;PC 端可用 curl 等价请求对比。修复后 VM 内实测发送→回复上屏。

然后按 RESUME-STATE-V2.md 断点继续:P0 收口(受控重启定性+deploy.mjs+preferences 持久化)→矩阵 20 项。棒次纪律/诚实条款/token 安全不变;上下文将尽先更新 RESUME-STATE-V2.md。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

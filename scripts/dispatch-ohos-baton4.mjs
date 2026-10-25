/** 棒 4:收尾——补截图+ACCEPTANCE 终态(极省上下文版)。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · 棒 4 · 最后收尾(省上下文,直奔目标)】

棒 3 已实证 app 内"已连接"+真实任务送达 runtime(12:51-12:53 的探针任务)。棒 4 只做收尾,严格按序:

1. 读 RESUME-STATE.md 尾部(勿读服务端代码);
2. 用现成 uitest 手法(hdc shell uitest uiInput):会话页发"请只回复两个字:收到"→等回复上屏→截 shot-chat.jpeg;若出现审批卡(先在设置把审批模式切 auto 免审批,或直接批准)截 shot-approval.jpeg;
3. evidence/ohos/ 应有 ≥4 张截图(home/settings/chat/approval);
4. ACCEPTANCE.md 更新终态:门 4=E2E 实录(应用内连接+任务+回复,引 runtime 会话记录为证),门 5=截图清单;未尽事项如实;
5. RESUME-STATE.md 写终态;收棒简报(≤15 行)。
不做任何重构/优化。诚实条款不变。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

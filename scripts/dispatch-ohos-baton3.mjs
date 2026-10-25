/** 棒 3:补完门 4/5(app 内 E2E+截图)。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · 棒 3 · 收尾门 4/5】

棒 2 战果已验收(门 1/2/3/6 ✅,方案 B 批准记录合格)。棒 3 只做两件事:

一、门 4 端到端(app 内真实任务):
1. 先读 RESUME-STATE.md 与 ACCEPTANCE.md 恢复上下文(勿重读服务端大文件);
2. PC 端 7788 已在线;从 PC 的 HMH_HOME config.json 读 web.token(只用于 hdc uiInput 注入,**不写入任何文件/日志/截图**);
3. 用 hdc shell uitest uiInput(click/text)驱动 VM 内应用:设置页填 PC 的 LAN 地址+token → 连接测试通过 → 会话页新建会话 → 发短任务"请只回复两个字:收到" → 等回复上屏;任务若请求审批,在审批卡点批准;
4. 每步截图存 evidence/ohos/:shot-settings.jpeg、shot-chat.jpeg、shot-approval.jpeg(≥3 张含已有 home);
5. 若 uitest 不可用,试 hdc shell uinput / 直接 hdc shell aa start 带参数?先探明再动,路径如实记录。

二、门 5/6 收尾:ACCEPTANCE.md 把门 4/5 改终态(全证据路径),未尽事项如实保留;RESUME-STATE.md 更新终态。

诚实条款不变:做不到的写 BLOCKED+原因,不假造。完成后收棒简报。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

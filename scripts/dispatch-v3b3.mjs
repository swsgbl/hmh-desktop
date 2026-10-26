/** 派 v3 棒 3:Overview 数据链收口+终验准备。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v3 棒 3 · Overview 数据链接口+收尾】

棒 2+图标令已审并收录(59f3f9b/ee2b7c7):蓝 H 图标真机实证(标题栏+任务栏)、composer 单行修复、SSE 流式渲染活体证据——Zode 亲验截图确认。

唯一剩余缺陷:Overview/Dock 数据行"无数据"。你的诊断已定位(DIAG st=NULL/sse=down/baseUrl=set,hello/bootstrap/refreshState 三关键帧 0 命中,新进程疑似未走 bootstrap;next=EntryAbility grep)。

本棒:
1. 修通:EntryAbility→AppStore 初始化链排查(bootstrap 触发时机/SSE 订阅建立/hello 帧消费),Dock 数据行出真实值(runtime 0.23.39/lan/glm-5.3/会话数/运行状态);
2. 六页签数据全部接真(文件/变更/证据/日志/远程——远程页签要能探到 7788 状态);
3. hvigorw 构建+deploy.mjs 装机+截图举证(Overview 有数据+各页签);
4. 61+ 单测不回退;ACCEPTANCE.md V3 矩阵行滚动更新;
5. 完成后 RESUME-STATE-V3 终态+收棒简报。纪律不变。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

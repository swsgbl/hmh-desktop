/** 派 v2 棒 4:ArkTS UI 装配。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v2 棒 4 · ArkTS UI 装配】

棒 3 已审:52/52 单测 Zode 亲跑复验通过,契约事实已入断点。

本棒任务:把纯逻辑层装配进 ArkTS UI——
1. 聊天流:工具折叠卡/交付物卡/回合汇总接入 SessionsPage(turn-items 数据源);
2. 会话列表:分组头▸▾/收藏★/状态过滤 chips/运行点(接 session-list+busySessions);
3. 总览+日志两个新 Tab(接 /api/state 与 SSE line 累积);
4. 主题(深/浅/系统)+i18n(设置切换,接 i18n-dict,preferences 持久);
5. 每项装配完即 VM dump/截图举证,ACCEPTANCE 矩阵行滚动更新;
6. hvigorw 真构建过+deploy.mjs 装机验证(新增页面能起不崩);
7. 断点纪律/token 纪律不变;完成多少算多少,如实简报。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

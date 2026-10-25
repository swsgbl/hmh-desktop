/** 派发 v2 提示词(1:1 复刻+可用性根修)。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 派发 · 鸿蒙版 v2 · 1:1 复刻 + 可用性根修】

用户实测结论:"深开鸿版本的还不能用"。Zode 已实机取证并完成对比盘点,全部写进新任务书:

第一步(必做):完整阅读 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v2.md 并严格遵循。

要点速览:
- §〇 P0:Zode 实测 VM 上应用已消失(bm dump 无此包)——先诊断丢失原因(数据盘非持久?),交付一键重装 apps/ohos/scripts/deploy.mjs + 配置 preferences 持久化+启动自动重连;
- §一 20 项 1:1 复刻矩阵(蓝本=apps/desktop 同名功能;工具卡/交付物卡/回合汇总/会话分组/收藏/状态过滤/归档删除导出/运行点/加载更多/相册图片附件/@文件引用/模型选择/审批模式/Provider/总览/日志/主题/i18n/通知);明确"不做"清单已列(托盘→通知替代等);
- §三 v2 验收门 A-E(持久性/矩阵/通知/安全/用户实测);
- 纪律不变:棒次接力+RESUME-STATE 断点+token 永不落盘(Zode 会复审 hilog)+诚实条款。

从 P0 开始,先修"不能用",再按矩阵逐项推进。每项完成即自测举证。开工先回一句话计划。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

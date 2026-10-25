/** 派 v2 棒 3:矩阵 20 项实施。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v2 棒 3 · 矩阵实施】

棒 2 已审:P0 三件套(deploy.mjs/Bootstrap 自动重连/卡死闭环)验收通过,commit 22fc379 收录。

本棒任务:§一 20 项 1:1 矩阵,按断点序推进(建议序:纯 UI 项先易后难——工具折叠卡/交付物卡/回合汇总 → 总览/日志页签 → 主题/i18n → 收藏/分组/过滤/归档删除导出/运行点/加载更多 → 模型选择/审批模式/Provider → @文件引用 → 通知 → 相册图片附件)。

要求:
1. 每完成一项:布局 dump 或截图举证,ACCEPTANCE.md 矩阵表滚动更新该行;
2. 纯逻辑(分组/过滤/归约扩展)进 tests/ 跟随单测;
3. i18n 文案直接抄 apps/desktop/renderer/src/i18n.ts 对应词条(语义 1:1);
4. 通知项(approvalReq→@ohos.notificationManager,点击拉起会话页)需 dump/截图实证一次;
5. 上下文将尽先更新 RESUME-STATE-V2.md 再收棒;token 纪律不变。
完成多少算多少,如实简报。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

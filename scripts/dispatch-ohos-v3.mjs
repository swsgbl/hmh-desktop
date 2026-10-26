/** 派发 v3:GUI 布局 1:1 三栏复刻。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 派发 · 鸿蒙版 v3 · GUI 布局 1:1 复刻(三栏工作台)】

用户实测反馈:功能有了,但布局不是一模一样——现在是底部 Tab 单栏切换,要的是 Windows 版的三栏同屏工作台。Zode 实机截图确认此差距。

第一步(必做):完整阅读 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v3.md 并严格遵循。

要点:
- 蓝本=apps/desktop 的 App.tsx JSX 树+app.css 逐值(尺寸/配色/类名同名);参考截图 ui-shot-groups.png / ui-shot-lang.png;
- 目标:.app-shell 三栏(左 264 会话管理 / 中 topbar+stream+composer / 右 dock 360 六页签)+36px titlebar+设置居中弹层;响应式断点照抄(VM 1280×800 横屏走三栏);
- 交互细节全 1:1(▾菜单/模型菜单/审批卡/@弹层/上传/注入/停止);
- 实施:新建三栏容器页,现有 Tab 页内容降级为 dock-body/弹层组件复用,逻辑不删只挪;
- 验收门 V3-1..V3-6(三栏同屏 dump 断言+逐区截图对比+交互走通+不回退 61/61+用户实测);
- 禁止用"平台差异"回到 Tab 布局;实现不了的逐条列差异交 Zode 裁决。

从左栏+中栏骨架开始,每区完成即 VM 截图+dump 对比。开工先回一句话计划。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

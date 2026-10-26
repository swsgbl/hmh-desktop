/** 派鸿蒙 v4(DSH 设计重设计)给 hmharness 智能体。 */
const BASE = 'http://127.0.0.1:7788';
const text = `【Zode 派发 · 鸿蒙版 v4 · DSH 设计风格全面重设计】

用户反馈:当前 GUI 太丑、不干净整洁——要求参考 DSH Desktop 官方设计风格全面重新设计。

第一步(必做):完整阅读两份文件——
1. G:\\hmh-desktop\\docs\\prompts\\design-language-dsh.md(Zode 从 DSH 官方 npm 包提取的代码级设计规范:浅色分层/品牌蓝紫#3964fe/胶囊按钮18px/输入8px/菜单12px/细边框/四级文字色/紧凑留白;证据 evidence/dsh/src/alias-theme.css 153 规则块可查组件写法,参考截图 evidence/dsh/dsh-hero.png);
2. G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v4.md(任务书:Theme.ets 按 alias token 重写深浅双主题/全部组件换肤/默认切浅色/三栏结构与功能零改动只换视觉/验收门 D1-D6)。

纪律不变(棒次/断点/token 安全/如实)。开工先回一句话计划。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 140));

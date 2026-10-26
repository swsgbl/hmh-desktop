/** 清障+派 v3(带卡死复发证据)。 */
const BASE = 'http://127.0.0.1:7788';

const r1 = await fetch(`${BASE}/api/interrupt`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'web-mvoerwi5' }),
});
console.log('interrupt:', r1.status);
await new Promise((r) => setTimeout(r, 4000));
let s = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(s.busySessions) && s.busySessions.length > 0) {
  console.log('interrupt ineffective, restarting daemon…');
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('node', ['--import', 'tsx', 'G:/hmharness/packages/cli/src/main.ts', 'web', 'stop'], { encoding: 'utf8', timeout: 30000 }); } catch (e) { console.log('stop fail'); }
  await new Promise((r) => setTimeout(r, 3000));
  try { execFileSync('node', ['--import', 'tsx', 'G:/hmharness/packages/cli/src/main.ts', 'web', 'start', '--exposure=lan'], { encoding: 'utf8', timeout: 60000 }); } catch (e) { console.log('start fail'); }
  await new Promise((r) => setTimeout(r, 8000));
  s = await (await fetch(`${BASE}/api/state`)).json();
}
console.log('busy now:', JSON.stringify(s.busySessions));
if (Array.isArray(s.busySessions) && s.busySessions.length > 0) { console.log('STILL BUSY'); process.exit(1); }

const text = `【Zode 派发 · v3 · GUI 布局 1:1 三栏复刻】

先读任务书 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v3.md(完整遵循;蓝本=apps/desktop 的 App.tsx JSX+app.css 逐值;六道 V3 验收门)。

**附新实锤(棒 2"不复现"结论修正)**:刚又出现一个空壳卡死会话 web-mvoerwi5(0 消息却 busy,interrupt 无效,Zode 重启守护清障)——卡死问题间歇复现,与昨晚同款。请在 v3 工作中安排排查:VM 应用发送链在什么条件下产生 0 消息 busy 会话(请求是否到达 runtime?sessionId 生成?mode?),尽力定位;若在 runtime 侧,上报 Zode 裁决,不擅自改。

主任务:三栏布局复刻(左 264 会话管理/中 topbar+stream+composer/右 dock 360 六页签/设置弹层;蓝本逐值;VM 1280×800 走三栏;禁止回 Tab)。每区完成即截图+dump 对比蓝本。开工先回一句话计划。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

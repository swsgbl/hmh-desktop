/** 派 v3 棒 2:细节打磨+交互接全。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v3 棒 2 · 细节打磨+交互接全】

棒 1 已审:三栏同屏落地合格(commit cb3c46d),真机截图与蓝本结构一致。本棒修细节+接全交互:

A. 已发现的两个缺陷(真机截图 evidence/ohos/shot-v3-threecol.jpeg 实证):
1. composer 在中栏宽度下文字竖排换行("描述目标(Enter 发送)"一字一行)、发送按钮挤压——对照 app.css .composer/.composer-row/.composer textarea 的 flex 布局修正(textarea flex:1 不压缩、按钮不换行、占位文案单行省略);
2. Overview 数据行全"无数据"——/api/state 拉取链路排查(shouldFetch 时序/字段映射),runtime 版本/模式/当前模型/会话数/运行状态要有真实值(对照 Windows 版 ui-shot-lang.png 右栏)。

B. 交互接全(把 v2 组件接进三栏,禁止回 Tab):
1. 右栏六页签内容完整(文件/变更/证据/日志/远程各页签可切+数据加载);
2. 设置弹层四区(运行时/应用偏好/审批模式/Provider)从 ⚙ 打开,Esc/点外关闭;
3. 模型▾菜单/工作区▾菜单/审批卡/@ 弹层/上传 全部接入三栏版并可走通一次;
4. 顶栏 ⇤ 侧栏收缩+收起上下文按钮生效。

每项 VM 截图/dump 举证;真构建+deploy.mjs 装机;单测 61/61 不回退。断点/token/诚实纪律不变。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

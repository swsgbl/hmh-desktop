/** 图标修复令(独立脚本,防 shell 吞输出)。 */
const text = `【Zode 补充令 · 品牌图标修复(用户指令)】

用户指出:图标用错了——VM 上显示的是 DevEco 模板橙色圆图标,不是 HMH 品牌图标。

修复:①品牌图标源=G:\\hmh-desktop\\apps\\desktop\\build\\icon.png(256 深色圆角方块+蓝 H,Windows 安装包同款;需其他尺寸用 scripts/make-icon.mjs);②替换 apps/ohos/AppScope/resources/base/media/app_icon.png 与 apps/ohos/entry/src/main/resources/base/media/app_icon.png(同名覆盖,$media:app_icon 引用不动);③hvigorw 构建→deploy.mjs 装机→VM 截图验证桌面/任务栏/标题栏全部蓝 H,存 evidence/ohos/v3/icon-fixed.jpeg;④应用内 titlebar 对齐 Windows(只有☰,不放 logo)。先做这个,再继续棒 2 未尽的细节打磨。`;
const r = await fetch('http://127.0.0.1:7788/api/task', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));
const s = await (await fetch('http://127.0.0.1:7788/api/state')).json();
console.log('queue now:', JSON.stringify(s.queue));

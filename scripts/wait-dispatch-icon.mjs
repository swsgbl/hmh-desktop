/** 等空闲→派图标修复令。 */
const BASE = 'http://127.0.0.1:7788';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!Array.isArray(s.busySessions) || s.busySessions.length === 0) break;
    console.log(`busy(${i}):`, s.busySessions.join(','));
  } catch { /* retry */ }
  await wait(30_000);
}
const s = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(s.busySessions) && s.busySessions.length > 0) { console.log('STILL BUSY 30min'); process.exit(1); }

const text = `【Zode 补充令 · 品牌图标修复(用户指令)】

用户指出:HMH Desktop 图标用错了——VM 上标题栏/任务栏/桌面显示的是 DevEco 模板默认的橙色圆形图标,不是 HMH 品牌图标。

修复(小任务,先做):
1. 品牌图标源=G:\\hmh-desktop\\apps\\desktop\\build\\icon.png(256×256 深色圆角方块+蓝 H,Windows 安装包同款);如需其他尺寸用 scripts/make-icon.mjs 重生成;
2. 用它替换 apps/ohos/AppScope/resources/base/media/app_icon.png 与 apps/ohos/entry/src/main/resources/base/media/app_icon.png(同名覆盖,app.json5/module.json5 的 $media:app_icon 引用不动;startWindowIcon 同步生效);
3. hvigorw 真构建→deploy.mjs 装机→VM 截图验证:桌面图标/任务栏/窗口标题栏全部显示蓝 H 品牌图标,截图存 evidence/ohos/v3/icon-fixed.jpeg;
4. 顺手确认应用内 titlebar 是否也需要放品牌小图标(对照 Windows 版——Windows titlebar 无 logo 只有 ☰,则鸿蒙也对齐不放)。

完成后继续棒 2 未尽的细节打磨与交互接全任务。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

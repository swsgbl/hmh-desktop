/** 派 v6(设备本地内核共享)——带排队。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
const busy = Array.isArray(state.busySessions) && state.busySessions.length > 0;
const text = `【Zode 派发 · 鸿蒙版 v6 · 设备本地内核共享】

用户问:"深开鸿上桌面应用不能和 HMH TUI 共享一个本地内核 CLI 吗?"——答案:能,现在就把它跑通。

第一步(必做):完整阅读 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v6.md 并严格遵循。

要点速览:
- 设备装 hmh(VM 192.168.161.137:10178;配方=G:\\hmharness\\docs\\KAIHONGOS.md 的 install-kaihongos.cjs 当年实测同款系统;无 node 则先推匹配 libc 的 node 二进制);
- 设备起 hmh web --exposure=lan(0.0.0.0:7788);密钥只经 hdc 落设备 config,不进仓库/日志/截图;
- HAP 应用切 http://127.0.0.1:7788(--ps hmhUrl 通道已有)→应用与设备 hmh TUI/浏览器三端同核;
- 一键化 deploy-local-kernel.mjs+README"设备独立模式"章节;ACCEPTANCE v6 门 L1-L5;
- 已知边界如实:设备侧独立 HMH_HOME;侧载形态;arm 需换 node。

纪律不变(棒次/断点/token/诚实)。开工先回一句话计划。`;
const body = busy
  ? { text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto', fresh: false }
  : { text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' };
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 140));

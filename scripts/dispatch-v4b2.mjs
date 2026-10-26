/** 派 v4 收尾令:IP 漂移修复+提交。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v4 收尾】

v4 换肤已审:DSH 风格真机生效(浅色分层/胶囊按钮/白卡片/品牌蓝——与蓝本一致,Zode 截图亲验)。两件收尾:

1. **连接故障根因已定性:PC LAN IP 漂移**(192.168.161.1→192.168.8.3,网络环境变更;7788 本身在线)。修复:VM 应用设置里把服务器地址更新为 http://192.168.8.3:7788(token 不变),验证"已连接"恢复+会话列表加载;在 ACCEPTANCE/RESUME 里记录"IP 漂移=已知运维场景"(长期方案:配对二维码/服务发现,登记待 Zode 裁决,本轮不做);
2. **提交 v4 工作**:工作树全部改动(Theme 换肤/组件新肤)整理成清晰 commit(message: v4 DSH 设计语言换肤);61+ 单测跑绿附结果;RESUME-STATE-V3(或新 v4 段)终态+简报。

纪律不变。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

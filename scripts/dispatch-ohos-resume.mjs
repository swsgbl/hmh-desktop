/** 续棒令:读 RESUME-STATE.md,开始写码(M-O1 起)。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · 鸿蒙版开发】

侦查棒简报与 RESUME-STATE.md 已审核通过(方案 B 双协议归约批准,记入 ACCEPTANCE.md;VM 签名链重建按你的备选序执行)。

现在执行:
1. 第一步读 G:\\hmh-desktop\\evidence\\ohos\\RESUME-STATE.md(唯一真相,勿重读服务端大文件);
2. 直接开始写码:M-O1 设置/连接 → 纯逻辑单测(node --import tsx --test 全绿)→ M-O2 会话纵切片 → M-O3 审批 → M-O4 工作区 → M-O5 文件;
3. 上下文将尽时:先写码后简报,断点续写进 RESUME-STATE.md(把已完成/未完成/下一步写清),Zode 会派下一棒;
4. hvigorw assembleHap 与 hdc 部署(192.168.161.137:10178)在 M-O2 纵切片可跑后即插入验证,不要攒到最后;
5. ACCEPTANCE.md 随里程碑滚动更新。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

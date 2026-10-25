/** 派 v2 棒 6:按棒 5 契约执行矩阵收尾。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v2 棒 6 · 按契约执行收尾批】

棒 5 侦查已审(纠错有效:providers 数据源是通的;契约固化合格)。本棒按 RESUME-STATE-V2.md 棒 5 增补段的字段级契约直接写码,勿重新侦查:

1. #12 模型选择:模型 chips 数据源已通——chip 文案改 name:model+当前高亮+点击 POST /api/model{name} 切换,E2E 切换一次回读确认;
2. #13 审批模式:设置页开关→POST /api/config{approval:'ask'|'auto'},dump 举证;
3. #14 Provider:列表(hasKey/末四位)+新增表单(name/baseUrl/model/apiKey 掩码)→POST /api/providers;只验列表渲染+表单校验+保存后列表刷新,不污染真实 config(如实记录);
4. #11 @引用:会话页 @ 按钮→GET /api/fs/search?q= 结果选择→attachments(按契约的路径格式)随任务,E2E 引用一个文件;
5. #19 通知:approvalReq→notificationManager 发通知+点击拉起,实证一次;
6. #10 相册图片:PhotoViewPicker≤3 张≤6MB→base64 数组→images 字段,E2E 发一张图实证 runtime 收到。
每项举证入 ACCEPTANCE 矩阵行;全部完成后矩阵表+RESUME 终态。纪律不变。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

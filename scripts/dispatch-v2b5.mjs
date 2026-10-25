/** 派 v2 棒 5:矩阵收尾批。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v2 棒 5 · 矩阵收尾批】

棒 4 已审:10 项装配+真机举证+52/52 零回归,commit 441107b 收录。

本棒任务(矩阵剩余 6 项,全部有既定 API,蓝本语义见提示词 §一):
1. #12 模型选择(设置页"模型"区:/api/state providers 列表+当前高亮,POST /api/model 切换;E2E 切换一次并回读确认);
2. #13 审批模式(设置页 ask/auto 开关,POST /api/config {approval};dump 举证);
3. #14 Provider 管理(列表 hasKey/末四位+新增表单,POST /api/providers;密钥输入掩码;E2E 保存一个假 provider 后删除?——不污染真实 config 的话只验列表渲染+表单校验,如实记录);
4. #11 @文件引用(会话页 @ 按钮→/api/fs/search 结果选择→attachments 随任务;E2E 引用一个工作区文件);
5. #19 通知(approvalReq→@ohos.notificationManager,点击拉起会话页;dump/截图实证一次);
6. #10 相册图片附件(@ohos.file.picker PhotoViewPicker≤3张≤6MB→base64→POST images;E2E 发一张图任务实证 runtime 收到);
完成后:ACCEPTANCE.md 矩阵表全行终态+RESUME-STATE-V2 终态;Zode 将做门 A-E 终验(含 hilog token 复审)。
纪律不变;完成多少算多少,如实简报。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

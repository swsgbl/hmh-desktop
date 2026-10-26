/** 派 v6.1(首启智能向导)给 hmharness——排队(runtime 可能正跑 v6)。 */
const BASE = 'http://127.0.0.1:7788';
const text = `【Zode 续棒令 · v6.1 · 首启智能检测+安装向导(用户最新需求)】

用户需求:"本地有 hmh cli 就默认共享;没有就自己重新下一个;默认全局配置或安装步骤提示;成熟的安装步骤和指引。"

第一步读 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt-v61.md(完整遵循):
- 首启智能检测:本机 127.0.0.1:7788 通→默认连本地共享(横幅注明与 TUI/浏览器共享);本机装了 hmh 未起服务→给启动指引;都没有→安装向导;
- 安装向导三选一:①在本机安装 hmh 内核(推荐默认,联动 PC 端 deploy-local-kernel.mjs 一键命令+复制按钮+轮询自动连上;装好的 hmh 默认全局配置 /data/local/home/.hmharness 四端共享)②连接电脑(远程)③演示;上一步/跳过/选择持久/设置可重入;
- 全局配置文案与实际 HMH_HOME 一致;README 双模式说明更新;
- 验收门 SW1-SW4;与 v6(本地内核)可同棒或续棒,按你当前进度安排。

纪律不变。开工先回一句话计划。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 140));

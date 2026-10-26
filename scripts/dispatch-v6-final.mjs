/** 派 v6 收官棒:L4 三端同核+L5 文档+SW1-SW4 真机验证。 */
const BASE = 'http://127.0.0.1:7788';
const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}
const text = `【Zode 续棒令 · v6/v6.1 收官棒】

两棒已审:L1-L3 实证合格(设备 hmharness+web+应用 ESTABLISHED——本地共享实锤);v6.1 向导装配+68/68 单测合格。

本棒收官(按 RESUME 断点,勿重新侦查):
1. L4 三端同核:设备上 hmh TUI(或 CLI)与 HAP 应用与设备浏览器(127.0.0.1:7788)同内核同时可用——各截图/dump 存 evidence/ohos/v6/;
2. SW1-SW4 真机验证:伪造无配置态(preferences 清空/新会话)→首启向导出现(SW1 截图);本机 hmh 在线→自动连本地共享横幅(SW2);向导选远程→连 PC 走通+选择持久(SW3);全局配置文案与 /data/local/home/.hmharness 实际一致+README 双模式(SW4);
3. L5:deploy-local-kernel.mjs 从零(卸掉设备 hmh 后)一键复装实证一条命令到底;README-ohos「设备独立模式」章节终稿;
4. ACCEPTANCE v6 门 L1-L5+SW1-SW4 全行终态;RESUME 终态;收棒简报。
纪律不变。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

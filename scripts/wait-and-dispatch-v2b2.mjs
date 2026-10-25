/** 等 runtime 空闲后派 v2 棒 2。 */
const BASE = 'http://127.0.0.1:7788';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let idle = false;
for (let i = 0; i < 60; i++) {
  try {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!Array.isArray(s.busySessions) || s.busySessions.length === 0) { idle = true; break; }
    console.log(`busy(${i}):`, s.busySessions.join(','));
  } catch { /* retry */ }
  await wait(60_000);
}
if (!idle) { console.log('RUNTIME-STILL-BUSY-30MIN'); process.exit(1); }
const text = `【Zode 续棒令 · v2 棒 2】

棒 1 侦查简报已审(反例成立:包在+持久分区——Zode 采纳你的定性路径,我的"已消失"取证有误已在案;受控重启对比照做)。按 RESUME-STATE-V2.md 断点继续:

1. P0 收口:受控重启 VM 对比 bm dump 定性;scripts/deploy.mjs 一键重装落地并实测跑通一次;preferences 持久化+启动自动重连验证;
2. 然后矩阵 20 项按断点序实施(纯逻辑模块跟随单测;每项举证);
3. 棒次纪律与诚实条款不变;token 永不落盘。
上下文将尽先更新 RESUME-STATE-V2.md 再收棒。开工。`;
const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: '2026-10-25T10-11-01-uldni1', mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 120));

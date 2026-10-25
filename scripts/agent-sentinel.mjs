/** 监督哨兵:每 30s 轮询 runtime,智能体任务结束(或 45min 超时)时打印最终简报并退出。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 90; i++) {
  try {
    const s = await (await fetch('http://127.0.0.1:7788/api/state')).json();
    const busy = Array.isArray(s.busySessions) ? s.busySessions.length : 0;
    if (busy === 0) {
      console.log(`AGENT-DONE after ${(i * 30)}s polling`);
      process.exit(0);
    }
  } catch { /* runtime 短暂不可达忽略 */ }
  await wait(30_000);
}
console.log('AGENT-STILL-RUNNING after 45min');

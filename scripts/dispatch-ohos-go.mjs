/** 续派:同一会话下达 M-O1..M-O5 执行令。 */
const BASE = 'http://127.0.0.1:7788';
const sid = process.argv[2];

const state = await (await fetch(`${BASE}/api/state`)).json();
if (Array.isArray(state.busySessions) && state.busySessions.length > 0) {
  console.log('busy, not dispatching:', state.busySessions);
  process.exit(1);
}

const text = `【Zode 执行令 · 承接会话 ${sid}】

侦查结论已收(工具链齐备+VM 在线,合格)。现在按你自己的开工计划开始执行:

1. M-O1 连接与设置 → M-O2 会话纵切片 → M-O3 审批卡 → M-O4 工作区 → M-O5 文件/交付物,顺序推进;
2. 纯逻辑模块(信封归约/SSE 分帧/DTO 守卫)放 apps/ohos/tests/*.test.ts 且与 ArkUI 零依赖,每完成一块就跑 node --import tsx --test 全绿再前进;
3. ArkTS 工程完成后跑 hvigorw assembleHap 真构建;hdc 安装到 192.168.161.137:10178 部署验证;
4. 全部完成后写 apps/ohos/docs/ACCEPTANCE.md(§六表格逐门+证据路径)并简报;
5. 安全不变量与诚实条款全程有效;PC 端 7788 已在线,token 用 web.token(config.json 里已配置的那个,自行读取)。`;

const r = await fetch(`${BASE}/api/task`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, sessionId: sid, mode: 'auto' }),
});
console.log('dispatch:', r.status, JSON.stringify(await r.json()).slice(0, 200));

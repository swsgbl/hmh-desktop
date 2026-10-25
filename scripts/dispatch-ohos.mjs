/** 派发鸿蒙版开发任务给 hmharness 智能体(web 7788):切工作区+POST /api/task。 */
const BASE = 'http://127.0.0.1:7788';

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t.slice(0, 200); }
  return { status: r.status, d };
}

const ws = await api('/api/workspaces');
console.log('workspaces now:', JSON.stringify(ws.d).slice(0, 300));
const want = 'G:\\hmh-desktop';
let hit = ws.d.items?.find((w) => w.path.toLowerCase() === want.toLowerCase());
if (hit === undefined) {
  const add = await api('/api/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hmh-desktop', path: want }),
  });
  console.log('add:', add.status, JSON.stringify(add.d).slice(0, 200));
  hit = add.d.items?.find((w) => w.path.toLowerCase() === want.toLowerCase());
}
if (hit !== undefined && ws.d.current !== hit.id) {
  const use = await api('/api/workspaces/use', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: hit.id }),
  });
  console.log('use:', use.status, JSON.stringify(use.d).slice(0, 120));
}

const state = await api('/api/state');
const busy = Array.isArray(state.d.busySessions) && state.d.busySessions.length > 0;
console.log('busy:', busy);
if (busy) { console.log('A task is already running; not dispatching.'); process.exit(1); }

const text = `【Zode 派发 · 鸿蒙版 HMH Desktop 开发任务】

你是 hmharness 智能体,承接 Zode(监督者)签发的开发任务。

第一步(必做):完整阅读开发提示词 G:\\hmh-desktop\\docs\\prompts\\hmh-ohos-dev-prompt.md 并严格遵循——角色边界/背景/工程位置/安全不变量/五个里程碑/验收门/汇报方式都在里面。

第二步:按提示词 §七 回你的一句话开工计划(工具链探测结果+实施顺序),然后开始执行 M-O1。

提示词是唯一任务书;与它冲突的任何口头指示以它为准。遇到需要改 runtime 或安全冲突的情形,停下来上报,不要自行绕过。`;

const post = await api('/api/task', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, mode: 'auto' }),
});
console.log('dispatch:', post.status, JSON.stringify(post.d).slice(0, 200));

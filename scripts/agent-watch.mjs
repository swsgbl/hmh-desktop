/** 监督:查看 hmharness 智能体当前任务状态与 apps/ohos 产出物。 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sid = process.argv[2];
if (sid !== undefined) {
  const d = await (await fetch(`http://127.0.0.1:7788/api/sessions/${encodeURIComponent(sid)}`)).json();
  console.log('cwd:', d.cwd);
  for (const m of (d.messages ?? []).slice(-10)) {
    console.log('---', m.role, 'tools:', (m.tools ?? []).join(','));
    console.log(String(m.text ?? '').slice(0, 500));
  }
  process.exit(0);
}
const s = await (await fetch('http://127.0.0.1:7788/api/state')).json();
console.log('busy:', Array.isArray(s.busySessions) ? s.busySessions.length : '?', 'active:', s.activeSessionId ?? '-');
const ohos = 'G:/hmh-desktop/apps/ohos';
if (existsSync(ohos)) {
  const walk = (d, pre, depth) => {
    if (depth > 3) return;
    for (const f of readdirSync(d)) {
      if (f === 'node_modules' || f === '.hvigor' || f === 'oh_modules' || f.startsWith('.')) continue;
      const p = join(d, f);
      const st = statSync(p);
      console.log(`${pre}${f}${st.isDirectory() ? '/' : ` (${st.size}b)`}`);
      if (st.isDirectory()) walk(p, `${pre}  `, depth + 1);
    }
  };
  console.log(`--- ${ohos} ---`);
  walk(ohos, '', 0);
} else {
  console.log('apps/ohos: 尚未创建');
}
console.log('ACCEPTANCE.md:', existsSync(join(ohos, 'docs', 'ACCEPTANCE.md')) ? '已出现' : '未出现');

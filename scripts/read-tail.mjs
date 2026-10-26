/** 读会话最后 N 条(角色+文本+工具),诊断棒 2 结束状态。 */
import { writeFileSync } from 'node:fs';
const d = await (await fetch('http://127.0.0.1:7788/api/sessions/2026-10-25T10-11-01-uldni1')).json();
const msgs = d.messages ?? [];
console.log('total msgs:', msgs.length);
for (const m of msgs.slice(-6)) {
  console.log('=== ' + m.role + ' tools:[' + (m.tools ?? []).join(',') + ']');
  console.log(String(m.text ?? '').slice(0, 600));
}

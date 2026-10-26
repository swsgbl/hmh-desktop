/** 找最新一条 user 任务,写文件(shell 吞输出时用)。 */
import { writeFileSync } from 'node:fs';
const d = await (await fetch('http://127.0.0.1:7788/api/sessions/2026-10-25T10-11-01-uldni1')).json();
const m = d.messages ?? [];
let out = 'total=' + m.length + '\n';
for (let i = m.length - 1; i >= 0; i--) {
  if (m[i].role === 'user') {
    out += `latest user @${i}: ` + String(m[i].text ?? '').slice(0, 200).replace(/\s+/g, ' ') + '\n';
    break;
  }
}
writeFileSync('G:/hmh-desktop/.hm-tmp/latest-task.txt', out, 'utf8');
console.log('written');

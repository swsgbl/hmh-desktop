/** 读棒 2 简报全文(写文件避免 shell 吞输出)。 */
import { writeFileSync } from 'node:fs';
const d = await (await fetch('http://127.0.0.1:7788/api/sessions/2026-10-25T10-11-01-uldni1')).json();
const msgs = d.messages ?? [];
const last = msgs[msgs.length - 1];
const text = String(last?.text ?? '');
writeFileSync('G:/hmh-desktop/.hm-tmp/brief2.md', text, 'utf8');
console.log('saved, chars:', text.length);

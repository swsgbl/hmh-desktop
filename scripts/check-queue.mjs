/** 查 runtime 任务队列(排队中的派发会在这里)。 */
import { writeFileSync } from 'node:fs';
const s = await (await fetch('http://127.0.0.1:7788/api/state')).json();
writeFileSync('G:/hmh-desktop/.hm-tmp/queue-state.txt', JSON.stringify({ busy: s.busySessions, queue: s.queue }, null, 1), 'utf8');
console.log('ok');

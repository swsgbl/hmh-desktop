// 最小重现:Last-Event-ID 重连补拉
import { DesktopHostClient, EventStore } from '../packages/host-adapter/src/index.ts';

const client = new DesktopHostClient('http://127.0.0.1:PORT', 'TOK');
const ac = new AbortController();
let n = 0;
let lastId = '';
try {
  for await (const env of client.events('SHOULD_REPLAY_FROM_HERE', ac.signal)) {
    n += 1;
    console.log('env:', env.kind, 'seq', env.seq);
    if (n > 3) break;
  }
} catch (err) {
  console.log('stream error:', String(err));
}
console.log('total', n);
process.exit(0);

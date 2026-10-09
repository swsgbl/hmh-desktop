// 最小 spawn 调试:fake-host 子进程是否输出引导行
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const fakeHostPath = new URL('../packages/host-adapter/src/fake-host.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
console.log('spawning:', process.execPath, '--import', 'tsx', fakeHostPath);

const child = spawn(process.execPath, ['--import', 'tsx', fakeHostPath], {
  env: { ...process.env, HMH_DESKTOP_TOKEN: 'debug-tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const timer = setTimeout(() => {
  console.log('TIMEOUT: no ready line in 10s');
  child.kill();
  process.exit(1);
}, 10_000);
createInterface({ input: child.stdout }).on('line', (l) => {
  console.log('stdout:', l);
  clearTimeout(timer);
  child.kill();
  process.exit(0);
});
child.stderr.on('data', (d) => console.log('stderr:', d.toString()));
child.on('exit', (code) => console.log('exit:', code));

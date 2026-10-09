/**
 * Supervisor 状态机测试(MasterPrompt 阶段 D):
 * starting/ready/disconnected/restarting/stopping/failed 全路径,
 * 全部基于 fake host 子进程(与真实 host 同一 stdout 引导协议)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopRuntimeSupervisor, type HostState } from '../supervisor.ts';
import { isDesktopError } from '@hmh-desktop/contracts';

const fakeHostPath = new URL('../fake-host.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** spawn 真实 fake-host 子进程的 spec。 */
function fakeSpec(env: Record<string, string> = {}): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env };
}

function recorder(): { states: HostState[]; onStateChange: (s: HostState) => void } {
  const states: HostState[] = [];
  return { states, onStateChange: (s: HostState) => { states.push(s); } };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

test('start: 引导行 + 健康探测 → ready,拿到 OS 分配的实际端口', async () => {
  const rec = recorder();
  const sup = new DesktopRuntimeSupervisor(fakeSpec(), { token: 'tok-a', onStateChange: rec.onStateChange });
  try {
    const ep = await sup.start();
    assert.equal(sup.state, 'ready');
    assert.ok(ep.port > 0 && ep.port < 65536, 'port 0 → 实际端口回传');
    assert.equal(ep.token, 'tok-a');
    assert.equal(ep.version, 'fake-0.0.0');
    assert.ok(rec.states.includes('starting') && rec.states.includes('ready'));
  } finally {
    await sup.stop();
  }
  assert.equal(sup.state, 'stopped');
});

test('token 不匹配 → AUTH_FAILED(不进重启循环)', async () => {
  // supervisor 总是把自己的 token 写进 HMH_DESKTOP_TOKEN;fake host 的
  // FAKE_HOST_EXPECT_TOKEN 钩子让 host 期望另一个值,构造真实的不匹配
  const sup = new DesktopRuntimeSupervisor(fakeSpec({ FAKE_HOST_EXPECT_TOKEN: 'tok-b' }), { token: 'tok-wrong' });
  await assert.rejects(
    sup.start(),
    (err: unknown) => isDesktopError(err) && err.code === 'AUTH_FAILED',
  );
  assert.equal(sup.state, 'starting', 'AUTH_FAILED 不自动重启');
  await sup.stop();
});

test('host 启动即死 → start() 抛 RUNTIME_CRASHED', async () => {
  const sup = new DesktopRuntimeSupervisor(fakeSpec({ FAKE_HOST_DIE_AT_BOOT: '1' }), { token: 'tok-x' });
  await assert.rejects(
    sup.start(),
    (err: unknown) => isDesktopError(err) && err.code === 'RUNTIME_CRASHED',
  );
  await sup.stop();
});

test('crash → disconnected/restarting → 新实例 ready(自愈,新端口)', async () => {
  const rec = recorder();
  const sup = new DesktopRuntimeSupervisor(fakeSpec(), { token: 'tok-c', maxRestarts: 3, onStateChange: rec.onStateChange });
  const ep1 = await sup.start();
  // 模拟 runtime 崩溃(die 有 50ms 延迟,先等状态离开 ready 再等自愈)
  await fetch(`http://127.0.0.1:${ep1.port}/api/fake/die`, { method: 'POST', headers: { 'x-hmh-key': 'tok-c' } });
  const left = await waitFor(() => sup.state !== 'ready', 10_000);
  assert.ok(left, 'die 后状态离开 ready');
  const healed = await waitFor(() => sup.state === 'ready', 15_000);
  assert.ok(healed, `supervisor 自愈(实际状态 ${sup.state})`);
  assert.equal(sup.restartsUsed, 1);
  assert.ok(rec.states.includes('restarting'));
  await sup.stop();
});

test('反复 crash 烧完 maxRestarts → failed', async () => {
  const sup = new DesktopRuntimeSupervisor(fakeSpec(), { token: 'tok-d', maxRestarts: 2 });
  await sup.start();
  for (let i = 0; i < 3; i++) {
    const ok = await waitFor(() => sup.state === 'ready', 15_000);
    assert.ok(ok, `第 ${i + 1} 轮 ready(实际 ${sup.state})`);
    const ep = sup.endpoint;
    assert.ok(ep !== null, 'ready 时 endpoint 可用');
    await fetch(`http://127.0.0.1:${ep.port}/api/fake/die`, { method: 'POST', headers: { 'x-hmh-key': 'tok-d' } }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
  }
  const failed = await waitFor(() => sup.state === 'failed', 15_000);
  assert.ok(failed, `烧完重启次数后 failed(实际 ${sup.state})`);
  assert.equal(sup.restartsUsed, 2, 'maxRestarts=2 → 重启恰好 2 次');
  await sup.stop();
});

test('stop: 优雅关闭(shutdown 端点优先),端口随之不可达,且幂等', async () => {
  const sup = new DesktopRuntimeSupervisor(fakeSpec(), { token: 'tok-e' });
  const ep = await sup.start();
  const probe = async (): Promise<number> => {
    try {
      const r = await fetch(`http://127.0.0.1:${ep.port}/api/state`, { headers: { 'x-hmh-key': 'tok-e' }, signal: AbortSignal.timeout(500) });
      return r.status;
    } catch {
      return -1;
    }
  };
  assert.equal(await probe(), 200);
  await sup.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await probe(), -1, 'host 已随 stop 退出');
  assert.equal(sup.state, 'stopped');
  await sup.stop(); // 幂等
});

/**
 * 会话纵切片 e2e(MasterPrompt 阶段 E,fake host 层先行):
 * 发送任务 → SSE 信封流 → EventStore 归约 → completed;
 * 审批批准/拒绝双路径;3 会话并发互不串线;断线重连 Last-Event-ID 补拉;
 * 任务失败 → run.failed(AUTH_FAILED)。
 * 全部走 supervisor spawn 的真实子进程(与 Electron main 同一条链路)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopRuntimeSupervisor, DesktopHostClient, EventStore } from '../index.ts';

const fakeHostPath = new URL('../fake-host.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

interface Rig {
  sup: DesktopRuntimeSupervisor;
  client: DesktopHostClient;
  store: EventStore;
  collect: () => void;
  stop(): Promise<void>;
}

async function startRig(env: Record<string, string> = {}): Promise<Rig> {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env },
    { token: 'e2e-tok' },
  );
  const ep = await sup.start();
  assert.equal(sup.state, 'ready');
  const client = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'e2e-tok');
  const store = new EventStore();
  const ac = new AbortController();
  const pump = (async () => {
    try {
      for await (const env2 of client.events(undefined, ac.signal)) store.apply(env2);
    } catch { /* aborted at teardown */ }
  })();
  // 等 SSE 建连
  await new Promise((r) => setTimeout(r, 150));
  return {
    sup, client, store,
    collect: () => void pump,
    stop: async () => {
      ac.abort();
      await sup.stop();
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return check();
}

test('纵切片:发送 → run.started → 工具 → run.completed(auto 模式)', async () => {
  const rig = await startRig();
  try {
    const r = await rig.client.postJson<{ ok: boolean; runId: string }>('/api/task', {
      text: 'hello desktop', sessionId: 'e2e-s1', mode: 'auto',
    });
    assert.equal(r.ok, true);
    const done = await waitUntil(() => rig.store.view('e2e-s1', r.runId)?.status === 'completed');
    assert.ok(done, `最终 completed(实际 ${rig.store.view('e2e-s1', r.runId)?.status ?? 'none'})`);
    const v = rig.store.view('e2e-s1', r.runId)!;
    assert.match(String((v.events.find((e) => e.kind === 'run.completed')?.payload as { text?: string }).text), /^echo: hello desktop/);
    assert.ok(v.events.some((e) => e.kind === 'run.started'));
    assert.ok(v.events.some((e) => e.kind === 'tool.started'));
    assert.ok(v.events.some((e) => e.kind === 'tool.completed'));
    assert.equal(v.needsCatchUp, false, '顺序到达无缺口');
    // 交付物先于终态(artifact.created 在 run.completed 之前)
    const artIdx = v.events.findIndex((e) => e.kind === 'artifact.created');
    const doneIdx = v.events.findIndex((e) => e.kind === 'run.completed');
    assert.ok(artIdx >= 0 && artIdx < doneIdx, 'artifact.created 先于 run.completed');
    const art = (v.events[artIdx]!.payload as { artifact?: { relPath?: string } }).artifact;
    assert.ok(typeof art?.relPath === 'string' && art.relPath.length > 0, '交付物带工作区相对路径');
  } finally {
    await rig.stop();
  }
});

test('纵切片:ask 模式审批(批准路径)', async () => {
  const rig = await startRig();
  try {
    const r = await rig.client.postJson<{ ok: boolean; runId: string }>('/api/task', {
      text: 'write something', sessionId: 'e2e-s2', mode: 'ask',
    });
    const waiting = await waitUntil(() => rig.store.view('e2e-s2', r.runId)?.status === 'waiting_approval');
    assert.ok(waiting, '审批卡弹出(waiting_approval)');
    const approval = rig.store.view('e2e-s2', r.runId)!.events.find((e) => e.kind === 'approval.required');
    assert.ok(approval, 'approval.required 事件存在');
    const p = approval!.payload as { tool: string; approvalId: string };
    assert.equal(p.tool, 'write_file');

    const a = await rig.client.postJson<{ ok: boolean }>('/api/approve', { granted: true, sessionId: 'e2e-s2' });
    assert.equal(a.ok, true);
    const done = await waitUntil(() => rig.store.view('e2e-s2', r.runId)?.status === 'completed');
    assert.ok(done, '批准后完成');
    const text = String((rig.store.view('e2e-s2', r.runId)!.events.find((e) => e.kind === 'run.completed')?.payload as { text?: string }).text);
    assert.match(text, /已执行写入/);
  } finally {
    await rig.stop();
  }
});

test('纵切片:ask 模式审批(拒绝路径)', async () => {
  const rig = await startRig();
  try {
    const r = await rig.client.postJson<{ ok: boolean; runId: string }>('/api/task', {
      text: 'danger write', sessionId: 'e2e-s3', mode: 'ask',
    });
    await waitUntil(() => rig.store.view('e2e-s3', r.runId)?.status === 'waiting_approval');
    await rig.client.postJson('/api/approve', { granted: false, sessionId: 'e2e-s3' });
    const done = await waitUntil(() => rig.store.view('e2e-s3', r.runId)?.status === 'completed');
    assert.ok(done, '拒绝后任务结束(不执行写入)');
    const text = String((rig.store.view('e2e-s3', r.runId)!.events.find((e) => e.kind === 'run.completed')?.payload as { text?: string }).text);
    assert.match(text, /审批被拒绝/);
  } finally {
    await rig.stop();
  }
});

test('3 会话并发互不串线', async () => {
  const rig = await startRig();
  try {
    const rs = await Promise.all([1, 2, 3].map((i) =>
      rig.client.postJson<{ ok: boolean; runId: string }>('/api/task', {
        text: `task-${i}`, sessionId: `e2e-c${i}`, mode: 'auto',
      })));
    for (let i = 0; i < 3; i++) {
      const done = await waitUntil(() => rig.store.view(`e2e-c${i + 1}`, rs[i]!.runId)?.status === 'completed');
      assert.ok(done, `会话 ${i + 1} 完成`);
      const text = String((rig.store.view(`e2e-c${i + 1}`, rs[i]!.runId)!.events.find((e) => e.kind === 'run.completed')?.payload as { text?: string }).text);
      assert.match(text, new RegExp(`task-${i + 1}`), `会话 ${i + 1} 的回复属于自己的任务`);
    }
  } finally {
    await rig.stop();
  }
});

test('断线重连:Last-Event-ID 补拉不丢最终状态', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'e2e-tok2' },
  );
  const ep = await sup.start();
  try {
    // 第一段连接:收到第一个 tool.completed 立刻断开(保证终态还没到,
    // lastEventId 落在 run.completed 之前——重放环里才有东西可补)
    const store1 = new EventStore();
    const ac1 = new AbortController();
    let lastEventId = '';
    const it1 = (async () => {
      const res = await fetch(`http://127.0.0.1:${ep.port}/api/events`, {
        headers: { 'x-hmh-key': 'e2e-tok2', accept: 'text/event-stream' },
        signal: ac1.signal,
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const f of block.split('\n')) {
            if (f.startsWith('id:')) lastEventId = f.slice(3).trim();
            if (f.startsWith('data:')) {
              try {
                const env = JSON.parse(f.slice(5)) as { kind?: string };
                store1.apply(env as never);
                if (env.kind === 'tool.completed') ac1.abort(); // 中途断线
              } catch { /* not envelope */ }
            }
          }
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    const r = await new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'e2e-tok2')
      .postJson<{ ok: boolean; runId: string }>('/api/task', { text: 'reconnect me', sessionId: 'e2e-r1', mode: 'auto' });
    await it1.catch(() => undefined);
    assert.notEqual(lastEventId, '', '第一段连接收到过帧');
    assert.notEqual(store1.view('e2e-r1', r.runId)?.status, 'completed', '断开时终态未到(前提成立)');

    // 第二段连接:带 Last-Event-ID 重连,必须补齐到 completed
    const store2 = new EventStore();
    const ac2 = new AbortController();
    const it2 = (async () => {
      for await (const env of new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'e2e-tok2').events(lastEventId, ac2.signal)) {
        store2.apply(env);
      }
    })();
    const done = await waitUntil(() => store2.view('e2e-r1', r.runId)?.status === 'completed', 10_000);
    ac2.abort();
    await it2.catch(() => undefined);
    assert.ok(done, `重连后补齐最终状态(实际 ${store2.view('e2e-r1', r.runId)?.status ?? 'none'})`);
    const kinds = store2.view('e2e-r1', r.runId)?.events.map((e) => e.kind) ?? [];
    assert.ok(kinds.includes('run.completed'), '补拉包含终态事件');
  } finally {
    await sup.stop();
  }
});

test('任务失败:run.failed 携带 AUTH_FAILED(错误恢复场景)', async () => {
  const rig = await startRig({ FAKE_HOST_TASK_FAIL: '1' });
  try {
    const r = await rig.client.postJson<{ ok: boolean; runId: string }>('/api/task', {
      text: 'will fail', sessionId: 'e2e-f1', mode: 'auto',
    });
    const failed = await waitUntil(() => rig.store.view('e2e-f1', r.runId)?.status === 'failed');
    assert.ok(failed, '状态 → failed');
    const ev = rig.store.view('e2e-f1', r.runId)!.events.find((e) => e.kind === 'run.failed');
    assert.ok(ev, 'run.failed 事件存在');
    const err = (ev!.payload as { error: { code: string; message: string; retryable: boolean } }).error;
    assert.equal(err.code, 'AUTH_FAILED');
    assert.equal(err.retryable, false);
  } finally {
    await rig.stop();
  }
});

/**
 * EventStore 归约测试(文档 04 §三事件语义):
 * eventId 幂等去重、seq 缺口检测、终态不回退、多会话隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../reducer.ts';
import { EVENT_SCHEMA_VERSION, type EventEnvelope } from '@hmh-desktop/contracts';

let n = 0;
function env(over: Partial<EventEnvelope> & { sessionId: string; runId: string; seq: number; kind: EventEnvelope['kind'] }): EventEnvelope {
  n += 1;
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `evt-${n}`,
    occurredAt: new Date().toISOString(),
    payload: {},
    ...over,
  };
}

test('按序应用:run.started → running,run.completed → completed', () => {
  const store = new EventStore();
  const r1 = store.apply(env({ sessionId: 's1', runId: 'r1', seq: 1, kind: 'run.started' }));
  assert.equal(r1.outcome, 'applied');
  assert.equal(r1.view.status, 'running');
  store.apply(env({ sessionId: 's1', runId: 'r1', seq: 2, kind: 'tool.started' }));
  const r3 = store.apply(env({ sessionId: 's1', runId: 'r1', seq: 3, kind: 'run.completed' }));
  assert.equal(r3.view.status, 'completed');
  // 终态后迟到的 tool.completed 不回退
  const r4 = store.apply(env({ sessionId: 's1', runId: 'r1', seq: 4, kind: 'tool.completed' }));
  assert.equal(r4.view.status, 'completed');
  assert.equal(r4.outcome, 'applied');
});

test('approval.required → waiting_approval;run.failed → failed', () => {
  const store = new EventStore();
  store.apply(env({ sessionId: 's', runId: 'r', seq: 1, kind: 'run.started' }));
  const r = store.apply(env({ sessionId: 's', runId: 'r', seq: 2, kind: 'approval.required' }));
  assert.equal(r.view.status, 'waiting_approval');
  const f = store.apply(env({ sessionId: 's', runId: 'r', seq: 3, kind: 'run.failed' }));
  assert.equal(f.view.status, 'failed');
});

test('重复 eventId 幂等丢弃', () => {
  const store = new EventStore();
  const e = env({ sessionId: 's', runId: 'r', seq: 1, kind: 'run.started' });
  assert.equal(store.apply(e).outcome, 'applied');
  assert.equal(store.apply(e).outcome, 'duplicate');
  assert.equal(store.apply({ ...e }).outcome, 'duplicate');
  const v = store.view('s', 'r')!;
  assert.equal(v.events.length, 1, '重复事件不入列');
});

test('seq 缺口 → gap + needsCatchUp;clearCatchUp 复位', () => {
  const store = new EventStore();
  store.apply(env({ sessionId: 's', runId: 'r', seq: 1, kind: 'run.started' }));
  const r = store.apply(env({ sessionId: 's', runId: 'r', seq: 5, kind: 'tool.started' }));
  assert.equal(r.outcome, 'gap');
  assert.equal(r.view.needsCatchUp, true);
  assert.equal(r.view.lastSeq, 5);
  store.clearCatchUp('s', 'r');
  assert.equal(store.view('s', 'r')!.needsCatchUp, false);
});

test('乱序迟到(旧 seq)不回退 lastSeq', () => {
  const store = new EventStore();
  store.apply(env({ sessionId: 's', runId: 'r', seq: 3, kind: 'tool.started' }));
  const r = store.apply(env({ sessionId: 's', runId: 'r', seq: 2, kind: 'run.started' }));
  assert.equal(r.outcome, 'applied', '旧 seq 不算缺口');
  assert.equal(r.view.lastSeq, 3);
});

test('多会话/多 run 互不串线', () => {
  const store = new EventStore();
  store.apply(env({ sessionId: 's1', runId: 'r1', seq: 1, kind: 'run.started' }));
  store.apply(env({ sessionId: 's2', runId: 'r2', seq: 1, kind: 'run.started' }));
  store.apply(env({ sessionId: 's2', runId: 'r2', seq: 2, kind: 'run.completed' }));
  assert.equal(store.view('s1', 'r1')!.status, 'running');
  assert.equal(store.view('s2', 'r2')!.status, 'completed');
});

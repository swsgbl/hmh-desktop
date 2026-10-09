/**
 * fake host 合同测试:鉴权门、健康探测、SSE 信封、优雅关闭。
 * 这些也是将来真实 desktop-host 必须满足的合同(同一套断言直接复用)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHost } from '../fake-host.ts';
import { DesktopHostClient, parseSseChunk, envelopeFromFrame } from '../client.ts';

test('parseSseChunk: 帧解析(含心跳注释与多行 data)', () => {
  const frames = parseSseChunk('id: 7\nevent: hmh\ndata: {"a":1}\n\n: ping\n\nevent: other\ndata: line1\ndata: line2\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.id, '7');
  assert.equal(frames[0]!.event, 'hmh');
  assert.equal(frames[0]!.data, '{"a":1}');
  assert.equal(frames[1]!.event, 'other');
  assert.equal(frames[1]!.data, 'line1\nline2');
});

test('envelopeFromFrame: 只认 event: hmh 且数据过 guard', () => {
  const good = { event: 'hmh', data: JSON.stringify({ schemaVersion: 1, eventId: 'e1', sessionId: 's', runId: 'r', seq: 1, occurredAt: new Date().toISOString(), kind: 'run.started', payload: {} }) };
  assert.ok(envelopeFromFrame(good) !== null);
  assert.equal(envelopeFromFrame({ event: 'state', data: '{}' }), null);
  assert.equal(envelopeFromFrame({ event: 'hmh', data: '{oops' }), null);
});

test('fake host: 无 token 401,带 token 200(合同:token 不进 URL)', async () => {
  const host = await startFakeHost({ token: 'tok-123', quiet: true });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${host.port}/api/state`);
    assert.equal(noAuth.status, 401);
    const body = (await noAuth.json()) as { code: string };
    assert.equal(body.code, 'AUTH_FAILED');

    const ok = await fetch(`http://127.0.0.1:${host.port}/api/state`, { headers: { 'x-hmh-key': 'tok-123' } });
    assert.equal(ok.status, 200);
    const state = (await ok.json()) as { desktop: boolean };
    assert.equal(state.desktop, true);
  } finally {
    await host.close();
  }
});

test('fake host: SSE 流只发合法 EventEnvelope(event: hmh)', async () => {
  const host = await startFakeHost({ token: 'tok-123', quiet: true });
  const ac = new AbortController();
  try {
    const client = new DesktopHostClient(`http://127.0.0.1:${host.port}`, 'tok-123');
    const iter = client.events(undefined, ac.signal);
    const first = iter.next();
    await new Promise((r) => setTimeout(r, 100));
    host.emit('sess-1', 'run-1', 'run.started', { task: 'hello', mode: 'ask' });
    const { value } = await Promise.race([
      first,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('SSE 超时')), 5_000)),
    ]);
    assert.equal(value.kind, 'run.started');
    assert.equal(value.sessionId, 'sess-1');
    assert.equal(value.seq, 1);
    ac.abort();
    await iter.return?.(undefined).catch(() => undefined);
  } finally {
    ac.abort();
    await host.close();
  }
});

test('fake host: 未知路由 404 + 结构化错误', async () => {
  const host = await startFakeHost({ token: 'tok-123', quiet: true });
  try {
    const r = await fetch(`http://127.0.0.1:${host.port}/api/nope`, { headers: { 'x-hmh-key': 'tok-123' } });
    assert.equal(r.status, 404);
    const body = (await r.json()) as { code: string };
    assert.equal(body.code, 'SCHEMA_MISMATCH');
  } finally {
    await host.close();
  }
});

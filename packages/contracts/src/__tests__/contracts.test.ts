/**
 * contracts 包测试:guards 的正反例 + guard 与 JSON schema 的枚举一致性。
 * 这些是 desktop↔runtime 契约的回归门:任何一边静默漂移都会在这里红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  isEventEnvelope,
  isDesktopError,
  isRunStatus,
  isHostReadyLine,
  desktopError,
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
} from '../index.ts';

const here = dirname(fileURLToPath(import.meta.url));

const goodEnvelope = {
  schemaVersion: 1,
  eventId: 'evt-1',
  sessionId: 's-1',
  runId: 'r-1',
  seq: 3,
  occurredAt: '2026-10-09T12:00:00.000Z',
  kind: 'run.started',
  payload: { task: 'hi', mode: 'ask' },
};

test('isEventEnvelope: 合法信封通过', () => {
  assert.equal(isEventEnvelope(goodEnvelope), true);
});

test('isEventEnvelope: 每个 kind 都被接受', () => {
  for (const kind of EVENT_KINDS) {
    assert.equal(isEventEnvelope({ ...goodEnvelope, kind }), true, kind);
  }
});

test('isEventEnvelope: 拒绝坏形状', () => {
  assert.equal(isEventEnvelope(null), false);
  assert.equal(isEventEnvelope('x'), false);
  assert.equal(isEventEnvelope([]), false);
  assert.equal(isEventEnvelope({ ...goodEnvelope, schemaVersion: 2 }), false, '未知 schemaVersion');
  assert.equal(isEventEnvelope({ ...goodEnvelope, eventId: '' }), false, '空 eventId');
  assert.equal(isEventEnvelope({ ...goodEnvelope, seq: 1.5 }), false, '非整数 seq');
  assert.equal(isEventEnvelope({ ...goodEnvelope, seq: -1 }), false, '负 seq');
  assert.equal(isEventEnvelope({ ...goodEnvelope, occurredAt: 'yesterday' }), false, '非 RFC3339');
  assert.equal(isEventEnvelope({ ...goodEnvelope, kind: 'made.up' }), false, '未知 kind');
  assert.equal(isEventEnvelope({ ...goodEnvelope, payload: 'text' }), false, 'payload 非对象');
});

test('isEventEnvelope: 丢失任一必填字段都拒绝', () => {
  for (const key of ['schemaVersion', 'eventId', 'sessionId', 'runId', 'seq', 'occurredAt', 'kind', 'payload']) {
    const copy: Record<string, unknown> = { ...goodEnvelope };
    delete copy[key];
    assert.equal(isEventEnvelope(copy), false, key);
  }
});

test('isDesktopError: 合法/非法', () => {
  assert.equal(isDesktopError(desktopError('HOST_NOT_READY', 'wait', { retryable: true })), true);
  assert.equal(isDesktopError({ code: 'NOPE', message: 'x', retryable: false }), false);
  assert.equal(isDesktopError({ code: 'AUTH_FAILED', message: 'x', retryable: 'yes' }), false);
  assert.equal(
    isDesktopError(desktopError('STALE_VERSION', 'old', { recoveryAction: 'RECONNECT', sessionId: 's' })),
    true,
  );
  assert.equal(isDesktopError(desktopError('STALE_VERSION', 'old', { recoveryAction: 'DESTROY' as never })), false);
});

test('isRunStatus / isHostReadyLine', () => {
  assert.equal(isRunStatus('running'), true);
  assert.equal(isRunStatus('sleeping'), false);
  assert.equal(isHostReadyLine({ hmhDesktopHostReady: true, port: 8080, version: '0.23.33' }), true);
  assert.equal(isHostReadyLine({ hmhDesktopHostReady: true, port: 0, version: '0.23.33' }), false, 'port 0 非法');
  assert.equal(isHostReadyLine({ hmhDesktopHostReady: true, port: 99999, version: 'x' }), false);
  assert.equal(isHostReadyLine({ hmhDesktopHostReady: false, port: 8080, version: 'x' }), false);
});

test('guards 与 JSON schema 的枚举一致(漂移即红)', () => {
  const envelopeSchema = JSON.parse(
    readFileSync(join(here, '../../schemas/event-envelope.schema.json'), 'utf8'),
  ) as {
    properties: { kind: { enum: string[] }; schemaVersion: { const: number } };
    required?: string[];
  };
  const errorSchema = JSON.parse(
    readFileSync(join(here, '../../schemas/desktop-error.schema.json'), 'utf8'),
  ) as { properties: { code: { enum: string[] }; recoveryAction: { enum: string[] } } };

  assert.deepEqual([...envelopeSchema.properties.kind.enum].sort(), [...EVENT_KINDS].sort());
  assert.deepEqual(
    [...errorSchema.properties.code.enum].sort(),
    [...(['HOST_NOT_READY', 'AUTH_FAILED', 'RUNTIME_CRASHED', 'PORT_BIND_FAILED', 'STALE_VERSION', 'SCHEMA_MISMATCH'] as const)].sort(),
  );
  assert.equal(envelopeSchema.properties.schemaVersion.const, EVENT_SCHEMA_VERSION);
  assert.equal(
    envelopeSchema.required !== undefined && envelopeSchema.required.length,
    8,
    'envelope 必填字段数 = 8',
  );
  assert.deepEqual([...errorSchema.properties.recoveryAction.enum!].sort(), [...( ['RECONNECT', 'RESUME', 'EXPORT', 'OPEN_LOGS'] as const)].sort());
});

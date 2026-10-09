/**
 * @hmh-desktop/contracts — runtime 校验(guards)。
 *
 * 每个跨信任边界的数据(runtime→renderer、host→main)进入前先过 guard;
 * 校验失败的数据按 SCHEMA_MISMATCH 结构化错误处理,不静默接受。
 * 手写守卫而不是引第三方 schema 库:契约面小,零依赖文化(hmharness 同源)。
 */
import {
  EVENT_KINDS,
  EVENT_SCHEMA_VERSION,
  type EventEnvelope,
  type EventKind,
} from './event.ts';
import { ERROR_CODES, RECOVERY_ACTIONS, type DesktopError } from './error.ts';
import { RUN_STATUSES, type RunStatus } from './dto.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const isRfc3339 = (v: string): boolean => {
  const t = Date.parse(v);
  return Number.isFinite(t) && /\d{4}-\d{2}-\d{2}T/.test(v);
};

export function isEventEnvelope(v: unknown): v is EventEnvelope {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== EVENT_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(v.eventId)) return false;
  if (!isNonEmptyString(v.sessionId)) return false;
  if (!isNonEmptyString(v.runId)) return false;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (!isNonEmptyString(v.occurredAt) || !isRfc3339(v.occurredAt)) return false;
  if (!EVENT_KINDS.includes(v.kind as EventKind)) return false;
  return isRecord(v.payload);
}

export function isDesktopError(v: unknown): v is DesktopError {
  if (!isRecord(v)) return false;
  if (!ERROR_CODES.includes(v.code as never)) return false;
  if (typeof v.message !== 'string') return false;
  if (typeof v.retryable !== 'boolean') return false;
  if (v.sessionId !== undefined && !isNonEmptyString(v.sessionId)) return false;
  if (v.runId !== undefined && !isNonEmptyString(v.runId)) return false;
  if (v.recoveryAction !== undefined && !RECOVERY_ACTIONS.includes(v.recoveryAction as never)) return false;
  return true;
}

export function isRunStatus(v: unknown): v is RunStatus {
  return typeof v === 'string' && RUN_STATUSES.includes(v as RunStatus);
}

/** Host 引导行(stdout 第一行)。 */
export function isHostReadyLine(v: unknown): v is { hmhDesktopHostReady: true; port: number; version: string } {
  if (!isRecord(v)) return false;
  if (v.hmhDesktopHostReady !== true) return false;
  if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65535) return false;
  return isNonEmptyString(v.version);
}

/**
 * @hmh-desktop/contracts — 结构化桌面错误(开发计划文档 04 §三)。
 *
 * host-not-ready / auth-failed / stale-version / runtime-crashed /
 * port-bind-failed / schema-mismatch 必须是结构化错误码,并提供下一步动作。
 * message 是纯文本,渲染端永不把它当 HTML。
 */
export const ERROR_CODES = [
  'HOST_NOT_READY',
  'AUTH_FAILED',
  'RUNTIME_CRASHED',
  'PORT_BIND_FAILED',
  'STALE_VERSION',
  'SCHEMA_MISMATCH',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const RECOVERY_ACTIONS = ['RECONNECT', 'RESUME', 'EXPORT', 'OPEN_LOGS'] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface DesktopError {
  code: ErrorCode;
  /** 纯文本,永不信任为 HTML。 */
  message: string;
  retryable: boolean;
  sessionId?: string;
  runId?: string;
  recoveryAction?: RecoveryAction;
}

/** 构造一个 DesktopError(exactOptionalPropertyTypes 友好)。 */
export function desktopError(
  code: ErrorCode,
  message: string,
  opts: { retryable?: boolean; sessionId?: string; runId?: string; recoveryAction?: RecoveryAction } = {},
): DesktopError {
  const e: DesktopError = { code, message, retryable: opts.retryable === true };
  if (opts.sessionId !== undefined) e.sessionId = opts.sessionId;
  if (opts.runId !== undefined) e.runId = opts.runId;
  if (opts.recoveryAction !== undefined) e.recoveryAction = opts.recoveryAction;
  return e;
}

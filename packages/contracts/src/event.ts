/**
 * @hmh-desktop/contracts — 事件信封(开发计划文档 04 §三)
 *
 * 一条 UI 事件的唯一形状。前端 reducer 必须按 sessionId/runId/seq 处理;
 * 重复 eventId 幂等丢弃;seq 缺口触发补拉;非幂等动作不由 SSE 自动重发。
 */

import type { ArtifactRef } from './dto.ts';
import type { DesktopError } from './error.ts';

/** 事件种类(判别键)。新增 kind = schemaVersion 升级,不允许静默扩枚举。 */
export const EVENT_KINDS = [
  'run.started',
  'plan.updated',
  'tool.started',
  'tool.completed',
  'approval.required',
  'verification.updated',
  'artifact.created',
  'run.completed',
  'run.failed',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_SCHEMA_VERSION = 1;
export type EventSchemaVersion = 1;

/** SSE 流上的每一条事件。 */
export interface EventEnvelope<T = unknown> {
  schemaVersion: EventSchemaVersion;
  /** 全局唯一;重连/补拉后重复出现时接收方幂等丢弃。 */
  eventId: string;
  sessionId: string;
  runId: string;
  /** 会话内单调递增;缺口意味着丢事件,需要补拉。 */
  seq: number;
  /** RFC3339。 */
  occurredAt: string;
  kind: EventKind;
  payload: T;
}

/** run.started 的 payload。 */
export interface RunStartedPayload {
  task: string;
  mode: 'ask' | 'auto' | 'yolo';
}

/** plan.updated 的 payload(计划步骤列表,来自 runtime 的结构化计划,不是 chain-of-thought)。 */
export interface PlanUpdatedPayload {
  steps: Array<{ title: string; status: 'pending' | 'active' | 'done' | 'failed' }>;
}

/** tool.started 的 payload。 */
export interface ToolStartedPayload {
  name: string;
  /** 参数以文本呈现,渲染端永不 eval;大对象由 runtime 截断。 */
  argsPreview: string;
}

/** tool.completed 的 payload。 */
export interface ToolCompletedPayload {
  name: string;
  isError: boolean;
  outputPreview: string;
}

/** approval.required 的 payload。审批权威在 runtime 后端;UI 只是转述。 */
export interface ApprovalRequiredPayload {
  approvalId: string;
  tool: string;
  argsPreview: string;
  /** 影响范围/风险的人类可读说明,由 runtime 生成。 */
  risk: string;
}

/** verification.updated 的 payload。 */
export interface VerificationUpdatedPayload {
  summary: string;
  passed: boolean | null; // null = 未知/进行中(NEEDS-DATA 时不假填)
}

/** artifact.created 的 payload。 */
export interface ArtifactCreatedPayload {
  artifact: ArtifactRef;
}

/** run.completed 的 payload。 */
export interface RunCompletedPayload {
  text: string;
  turns: number;
  toolUses: number;
  usage?: { promptTokens: number; completionTokens: number };
}

/** run.failed 的 payload。 */
export interface RunFailedPayload {
  error: DesktopError;
}

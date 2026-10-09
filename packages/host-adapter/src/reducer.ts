/**
 * EventStore — 前端事件流归约的纯逻辑(文档 04 §三事件语义)。
 *
 * - 重复 eventId 幂等丢弃(重连补发与实时流重叠);
 * - 会话内 seq 必须连续,缺口标记 needsCatchUp(UI 显示补拉状态);
 * - run 状态由 kind 推导(planning/running/waiting_approval/...);
 * - 该类不执行任何副作用:非幂等动作永远不由事件流自动重发。
 */
import type { EventEnvelope, EventKind, RunStatus } from '@hmh-desktop/contracts';
import { RUN_STATUSES } from '@hmh-desktop/contracts';

export interface SessionRunView {
  sessionId: string;
  runId: string;
  status: RunStatus;
  /** 已应用的最后一个 seq(缺口检测基准)。 */
  lastSeq: number;
  /** 检测到 seq 缺口,需要从 host 补拉。 */
  needsCatchUp: boolean;
  /** 应用过的事件(按到达顺序;UI 自己决定折叠/虚拟化)。 */
  events: EventEnvelope[];
}

const STATUS_BY_KIND: Partial<Record<EventKind, RunStatus>> = {
  'run.started': 'running',
  'plan.updated': 'planning',
  'tool.started': 'running',
  'tool.completed': 'running',
  'approval.required': 'waiting_approval',
  'verification.updated': 'verifying',
  'artifact.created': 'running',
  'run.completed': 'completed',
  'run.failed': 'failed',
};

export function statusForKind(kind: EventKind, previous: RunStatus): RunStatus {
  const next = STATUS_BY_KIND[kind];
  if (next === undefined) return previous;
  // 终态不回退:run.completed 之后迟到的 tool.completed 不再把状态拉回 running
  if ((previous === 'completed' || previous === 'failed' || previous === 'cancelled') && next === 'running') {
    return previous;
  }
  return next;
}

export interface ApplyResult {
  outcome: 'applied' | 'duplicate' | 'gap';
  view: SessionRunView;
}

export class EventStore {
  private readonly seenEventIds = new Set<string>();
  private readonly runs = new Map<string, SessionRunView>(); // key: sessionId + '\0' + runId
  private evictedEventIds = 0;

  constructor(private readonly maxEventIds = 50_000) {}

  /** 应用一条事件;返回应用结果与该 run 的最新视图。 */
  apply(env: EventEnvelope): ApplyResult {
    if (this.seenEventIds.has(env.eventId)) {
      const view = this.runs.get(this.key(env));
      if (view) return { outcome: 'duplicate', view };
      // 重复但视图已不存在(被清退):构造一个只带去重事实的视图
      return { outcome: 'duplicate', view: this.freshView(env) };
    }
    this.remember(env.eventId);

    const key = this.key(env);
    const prev = this.runs.get(key);
    const view: SessionRunView = prev ?? this.freshView(env);
    const gap = prev !== undefined && env.seq > prev.lastSeq + 1;
    // 乱序迟到(比 lastSeq 旧)不回退 lastSeq,也不标记缺口
    if (prev === undefined || env.seq > prev.lastSeq) view.lastSeq = env.seq;
    view.status = statusForKind(env.kind, view.status);
    view.needsCatchUp = view.needsCatchUp || gap;
    view.events.push(env);
    this.runs.set(key, view);
    return { outcome: gap ? 'gap' : 'applied', view };
  }

  /** 补拉完成后的手动复位。 */
  clearCatchUp(sessionId: string, runId: string): void {
    const v = this.runs.get(`${sessionId}\0${runId}`);
    if (v) v.needsCatchUp = false;
  }

  view(sessionId: string, runId: string): SessionRunView | undefined {
    return this.runs.get(`${sessionId}\0${runId}`);
  }

  get dedupedCount(): number {
    return this.evictedEventIds;
  }

  private freshView(env: EventEnvelope): SessionRunView {
    const initial: RunStatus = env.kind === 'run.started' ? 'running' : 'recovering';
    return {
      sessionId: env.sessionId,
      runId: env.runId,
      status: RUN_STATUSES.includes(initial) ? initial : 'recovering',
      lastSeq: 0,
      needsCatchUp: false,
      events: [],
    };
  }

  private key(env: { sessionId: string; runId: string }): string {
    return `${env.sessionId}\0${env.runId}`;
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > this.maxEventIds) {
      const first = this.seenEventIds.values().next().value as string;
      this.seenEventIds.delete(first);
      this.evictedEventIds += 1;
    }
  }
}

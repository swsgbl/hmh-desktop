/**
 * @hmh-desktop/contracts — 跨进程 DTO(开发计划文档 04 §四 shared contracts 行)。
 *
 * SessionSummary / RunStatus / ApprovalRequest / ToolEvent / ArtifactRef /
 * EvidenceSummary。字段对齐 hmharness v0.23.33 web API 的真实输出
 * (docs/architecture-baseline.md §API 矩阵),UI 只消费这些形状。
 */

/** 左栏会话列表的一行(来自 GET /api/sessions)。 */
export interface SessionSummary {
  id: string;
  title: string;
  task: string;
  outcome: string;
  turns: number;
  toolUses: number;
  time: string;
  cwd: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

/** 可见运行状态(信息架构文档 03 §六)。 */
export const RUN_STATUSES = [
  'planning',
  'running',
  'waiting_approval',
  'verifying',
  'recovering',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 审批卡数据(来自 approval.required 事件)。 */
export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  runId: string;
  tool: string;
  argsPreview: string;
  risk: string;
  requestedAt: string;
}

/** 工具轨迹的一行(Context Dock / 折叠的工具过程)。 */
export interface ToolEvent {
  name: string;
  argsPreview: string;
  outputPreview: string;
  isError: boolean;
  at: string;
}

/** 交付物引用(Files/Diff 面板;路径永远来自后端授权 DTO)。 */
export interface ArtifactRef {
  /** 工作区相对路径(渲染端只显示,不解析绝对路径)。 */
  relPath: string;
  kind: 'file' | 'diff' | 'report';
  title: string;
  sizeBytes?: number;
}

/** 证据摘要(Evidence 面板)。证据字段缺失时 UI 显示"无证据/未测",不假填 0。 */
export interface EvidenceSummary {
  label: string;
  /** null = NEEDS-DATA(缺失),绝不映射成 0。 */
  value: number | null;
  unit: string;
  source: string;
}

/** GET /api/state 的桌面视图(从 runtime state 投影,裁剪到 UI 需要的字段)。 */
export interface DesktopStateView {
  runtimeVersion: string;
  model: string;
  locale: string;
  busySessions: string[];
  approvalPending: boolean;
  sessions: SessionSummary[];
}

/** Host 引导行:host 进程绑定 127.0.0.1:0 后写到 stdout 的第一行 JSON。 */
export interface HostReadyLine {
  hmhDesktopHostReady: true;
  port: number;
  version: string;
}

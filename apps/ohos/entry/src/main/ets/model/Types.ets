/**
 * HMH Desktop 鸿蒙版 · 全部 DTO 与领域类型
 * 契约来源:G:\hmharness\packages\web\src\server.ts (LAN 7788)
 * 注意:ArkTS 严苛模式——只用接口/类,不用 any,不用字面量推类型
 */

// ---------- /api/state ----------
export interface WorkspaceInfo {
  id: string
  name: string
  path: string
}

export interface StateObj {
  model: string
  chatProvider: string
  home: string
  locale: string
  busy: boolean
  busySessions: string[]
  approvalPending: boolean
  queue: number
  activeSessionId: string
  activeThreadCwd: string
  exposure: string
  workspace: WorkspaceInfo | null
  daemonVersion: string
  providers?: object[]
  settings?: object
}

// ---------- /api/sessions ----------
export interface SessionInfo {
  id: string
  title: string
  task: string
  outcome: string
  turns: number
  toolUses: number
  time: string
  cwd: string
  branch: string
  createdAt: string
  updatedAt: string
}

export interface SessionsResp {
  sessions: SessionInfo[]
  nextCursor: string
  workspace: string
}

export interface SessionMessage {
  role: string
  text: string
  tools: string[]
}

export interface SessionDetail {
  id: string
  model: string
  cwd: string
  messages: SessionMessage[]
}

// ---------- /api/workspaces ----------
export interface WorkspacesResp {
  current: string
  items: WorkspaceInfo[]
}

// ---------- /api/fs ----------
export interface FsSegment {
  name: string
  path: string
}

export interface FsEntry {
  name: string
  path: string
}

export interface FsDirResp {
  path: string
  segments: FsSegment[]
  parent: string
  dirs: FsEntry[]
  files?: FsEntry[]
}

export interface FsReadResp {
  path: string
  rel: string
  size: number
  text?: string
  binary: boolean
  truncated?: boolean
}

// ---------- 任务提交 ----------
export type TaskMode = 'ask' | 'auto' | 'yolo'

export interface TaskReq {
  text: string
  sessionId?: string
  mode: TaskMode
}

export interface TaskResp {
  ok: boolean
  queued?: boolean
  position?: number
}

// ---------- 审批 ----------
export interface ApproveReq {
  granted: boolean
  sessionId: string
}

// ---------- SSE 事件(LAN 旧事件名) ----------
export interface RawEvent {
  id: string           // SSE id 行(seq,无则空串)
  event: string        // 事件名:hello/busy/tool/toolResult/line/delta/...
  data: object         // 原始 data JSON
}

// ---------- 归约后统一领域事件(双协议归一) ----------
export type RunEventKind =
  | 'state'          // 全量状态
  | 'run.started'    // busy{busy:true} 或 hmh 信封 run.started
  | 'run.completed'  // final 或信封
  | 'run.failed'     // error 或信封
  | 'delta'          // 流式增量
  | 'line'           // 终端行
  | 'tool.started'   // tool 或信封
  | 'tool.completed' // toolResult 或信封
  | 'approval.required'
  | 'approval.done'
  | 'queued'
  | 'ignored'

export interface RunEvent {
  eventId: string       // 去重键:显式 id > kind:seq 自造
  seq: number           // SSE id 序号(无则递增占位)
  kind: RunEventKind
  sessionId: string     // 无则空串(全局)
  name: string          // 工具名/审批名,无则空
  text: string          // delta chunk / final text / line text / error message
  extra: object         // 原始 data 透传(按需取字段)
}

// ---------- 聊天 UI 状态(归约产物) ----------
export interface ChatMessage {
  role: string       // 'user' | 'assistant' | 'system'
  text: string
  tools: string[]
}

export interface ApprovalCard {
  name: string
  args: object
  sessionId: string
  arrivedAt: number
}

export interface ChatState {
  sessionId: string
  running: boolean
  queuePosition: number
  messages: ChatMessage[]
  streaming: boolean
  streamBuf: string
  approval: ApprovalCard | null
  lastFinalText: string
  lastError: string
  lastEventSeq: number     // 已见最大 SSE seq(重连 Last-Event-ID)
  seenEventIds: Set<string>
}

// ---------- 简单请求体 ----------
export interface SimpleSidReq {
  sessionId: string
}

export interface WsUseReq {
  id: string
}

export function newChatState(sessionId: string): ChatState {
  return {
    sessionId: sessionId,
    running: false,
    queuePosition: 0,
    messages: [],
    streaming: false,
    streamBuf: '',
    approval: null,
    lastFinalText: '',
    lastError: '',
    lastEventSeq: 0,
    seenEventIds: new Set<string>()
  } as ChatState
}

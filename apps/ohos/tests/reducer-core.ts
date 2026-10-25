/**
 * 纯逻辑:事件归约器(与 entry/ets/core/Reducer.ets 同构)
 * 双协议:LAN 旧事件名 + hmh 信封(event:hmh, data 含 kind/schemaVersion/eventId)
 * 职责:RawEvent → RunEvent;eventId 去重;sessionId 过滤(空=全局)
 */
import { SseFramer } from './sse-framer'

export type RunEventKind =
  | 'state' | 'run.started' | 'run.completed' | 'run.failed' | 'delta' | 'line'
  | 'tool.started' | 'tool.completed' | 'approval.required' | 'approval.done' | 'queued' | 'ignored'

export interface RawEvent {
  id: string
  event: string
  data: any
}

export interface RunEvent {
  eventId: string
  seq: number
  kind: RunEventKind
  sessionId: string
  name: string
  text: string
  extra: any
}

export interface ChatState {
  running: boolean
  queuePosition: number
  messages: { role: string, text: string, tools: string[] }[]
  streamBuf: string
  approval: { name: string, args: any, sessionId: string } | null
  lastFinalText: string
  lastError: string
  lastEventSeq: number
  seen: Set<string>
}

export function newChatState(): ChatState {
  return {
    running: false, queuePosition: 0, messages: [], streamBuf: '',
    approval: null, lastFinalText: '', lastError: '', lastEventSeq: 0, seen: new Set()
  }
}

// ---- hmh 信封 kind 映射(方案 B 双协议之一) ----
const ENVELOPE_KIND: Record<string, RunEventKind> = {
  'run.started': 'run.started',
  'run.completed': 'run.completed',
  'run.failed': 'run.failed',
  'delta': 'delta',
  'line': 'line',
  'tool.started': 'tool.started',
  'tool.completed': 'tool.completed',
  'approval.required': 'approval.required',
  'approval.done': 'approval.done',
  'queued': 'queued',
  'state': 'state'
}

/**
 * RawEvent → RunEvent。null 表示解析失败/忽略。
 * 会话过滤:ev.data.sessionId 存在且 ≠ 当前会话 且事件非全局 → null
 */
export function toRunEvent(raw: RawEvent, currentSession: string, seqFallback: number): RunEvent | null {
  const d = raw.data || {}
  const sid = typeof d.sessionId === 'string' ? d.sessionId : ''
  const seq = raw.id !== '' && /^\d+$/.test(raw.id) ? parseInt(raw.id) : seqFallback

  // 全局事件白名单(无 sessionId 也放行)
  const globalKinds = new Set(['state', 'hello'])
  let kind: RunEventKind = 'ignored'
  let name = ''
  let text = ''
  let eventId = ''

  if (raw.event === 'hmh') {
    // hmh 信封协议(desktop 桥模式)
    const k = typeof d.kind === 'string' ? d.kind : ''
    if (!(k in ENVELOPE_KIND)) return null
    kind = ENVELOPE_KIND[k]
    eventId = typeof d.eventId === 'string' && d.eventId !== '' ? d.eventId : `hmh:${seq}`
    name = typeof d.name === 'string' ? d.name : ''
    text = typeof d.text === 'string' ? d.text : (typeof d.chunk === 'string' ? d.chunk : '')
  } else {
    // LAN 旧事件名协议
    switch (raw.event) {
      case 'hello':
      case 'state':
        kind = 'state'
        eventId = `state:${seq}`
        break
      case 'busy':
        kind = d.busy === true ? 'run.started' : 'ignored' // busy:false 的收尾由 final 承担
        eventId = `busy:${seq}`
        break
      case 'delta':
        kind = 'delta'
        eventId = `delta:${seq}`
        text = typeof d.chunk === 'string' ? d.chunk : ''
        break
      case 'line':
        kind = 'line'
        eventId = `line:${seq}`
        text = typeof d.text === 'string' ? d.text : ''
        break
      case 'tool':
        kind = 'tool.started'
        eventId = `tool:${seq}`
        name = typeof d.name === 'string' ? d.name : ''
        break
      case 'toolResult':
        kind = 'tool.completed'
        eventId = `toolResult:${seq}`
        name = typeof d.name === 'string' ? d.name : ''
        text = typeof d.preview === 'string' ? d.preview : ''
        break
      case 'approvalReq':
        kind = 'approval.required'
        eventId = `approvalReq:${seq}`
        name = typeof d.name === 'string' ? d.name : ''
        break
      case 'approvalDone':
        kind = 'approval.done'
        eventId = `approvalDone:${seq}`
        name = typeof d.name === 'string' ? d.name : ''
        break
      case 'final':
        kind = 'run.completed'
        eventId = `final:${seq}`
        text = typeof d.text === 'string' ? d.text : ''
        break
      case 'error':
        kind = 'run.failed'
        eventId = `error:${seq}`
        text = typeof d.message === 'string' ? d.message : ''
        break
      case 'queued':
        kind = 'queued'
        eventId = `queued:${seq}`
        break
      default:
        return null
    }
  }

  // 会话过滤:非全局事件且带 sessionId 且 ≠ 当前 → 丢弃
  if (kind !== 'state' && sid !== '' && currentSession !== '' && sid !== currentSession) {
    return null
  }
  return { eventId, seq, kind, sessionId: sid, name, text, extra: d }
}

/** 状态归约:RunEvent → 新 ChatState(纯函数,不改入参) */
export function reduce(st: ChatState, ev: RunEvent): ChatState {
  // 去重
  if (st.seen.has(ev.eventId)) return st
  const seen = new Set(st.seen)
  seen.add(ev.eventId)
  const base: ChatState = { ...st, seen, lastEventSeq: Math.max(st.lastEventSeq, ev.seq) }

  switch (ev.kind) {
    case 'state':
      return base
    case 'run.started':
      return { ...base, running: true, queuePosition: 0, streamBuf: '' }
    case 'queued':
      return { ...base, queuePosition: typeof ev.extra.position === 'number' ? ev.extra.position : base.queuePosition }
    case 'delta': {
      const streamBuf = base.streamBuf + ev.text
      return { ...base, streaming: true, streamBuf }
    }
    case 'run.completed': {
      const messages = base.messages.concat([{ role: 'assistant', text: ev.text !== '' ? ev.text : base.streamBuf, tools: [] }])
      return { ...base, running: false, streaming: false, streamBuf: '', messages, lastFinalText: ev.text }
    }
    case 'run.failed':
      return { ...base, running: false, streaming: false, lastError: ev.text }
    case 'approval.required':
      return { ...base, approval: { name: ev.name, args: ev.extra.args || {}, sessionId: ev.sessionId } }
    case 'approval.done':
      return { ...base, approval: null }
    case 'tool.started':
      return base
    case 'tool.completed':
    case 'line':
    case 'ignored':
    default:
      return base
  }
}

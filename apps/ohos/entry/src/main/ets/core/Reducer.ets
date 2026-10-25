/**
 * 事件归约器(与 tests/reducer-core.ts 逻辑同构,ArkTS 严苛模式版)
 * 双协议:LAN 旧事件名 + hmh 信封。去重/sessionId 过滤/状态转移。
 */
import { RunEvent, RunEventKind, RawEvent, ChatState, ChatMessage, ApprovalCard } from '../model/Types'

export function toRunEvent(raw: RawEvent, currentSession: string, seqFallback: number): RunEvent | null {
  const d = raw.data as Record<string, Object>
  const sidObj = d['sessionId']
  const sid = typeof sidObj === 'string' ? sidObj : ''
  const idStr = raw.id
  const seq = idStr !== '' && isNum(idStr) ? parseInt(idStr) : seqFallback

  let kind: RunEventKind = 'ignored'
  let name = ''
  let text = ''
  let eventId = ''

  if (raw.event === 'hmh') {
    const k = typeof d['kind'] === 'string' ? d['kind'] as string : ''
    if (!ENVELOPE_KIND.has(k)) {
      return null
    }
    kind = ENVELOPE_KIND.get(k) as RunEventKind
    eventId = typeof d['eventId'] === 'string' && (d['eventId'] as string) !== '' ? d['eventId'] as string : `hmh:${seq}`
    name = typeof d['name'] === 'string' ? d['name'] as string : ''
    text = typeof d['text'] === 'string' ? d['text'] as string : (typeof d['chunk'] === 'string' ? d['chunk'] as string : '')
  } else {
    switch (raw.event) {
      case 'hello':
      case 'state':
        kind = 'state'
        eventId = `state:${seq}`
        break
      case 'busy':
        kind = d['busy'] === true ? 'run.started' : 'ignored'
        eventId = `busy:${seq}`
        break
      case 'delta':
        kind = 'delta'
        eventId = `delta:${seq}`
        text = typeof d['chunk'] === 'string' ? d['chunk'] as string : ''
        break
      case 'line':
        kind = 'line'
        eventId = `line:${seq}`
        text = typeof d['text'] === 'string' ? d['text'] as string : ''
        break
      case 'tool':
        kind = 'tool.started'
        eventId = `tool:${seq}`
        name = typeof d['name'] === 'string' ? d['name'] as string : ''
        break
      case 'toolResult':
        kind = 'tool.completed'
        eventId = `toolResult:${seq}`
        name = typeof d['name'] === 'string' ? d['name'] as string : ''
        text = typeof d['preview'] === 'string' ? d['preview'] as string : ''
        break
      case 'approvalReq':
        kind = 'approval.required'
        eventId = `approvalReq:${seq}`
        name = typeof d['name'] === 'string' ? d['name'] as string : ''
        break
      case 'approvalDone':
        kind = 'approval.done'
        eventId = `approvalDone:${seq}`
        name = typeof d['name'] === 'string' ? d['name'] as string : ''
        break
      case 'final':
        kind = 'run.completed'
        eventId = `final:${seq}`
        text = typeof d['text'] === 'string' ? d['text'] as string : ''
        break
      case 'error':
        kind = 'run.failed'
        eventId = `error:${seq}`
        text = typeof d['message'] === 'string' ? d['message'] as string : ''
        break
      case 'queued':
        kind = 'queued'
        eventId = `queued:${seq}`
        break
      default:
        return null
    }
  }

  if (kind !== 'state' && sid !== '' && currentSession !== '' && sid !== currentSession) {
    return null
  }
  const ev: RunEvent = {
    eventId: eventId,
    seq: seq,
    kind: kind,
    sessionId: sid,
    name: name,
    text: text,
    extra: raw.data
  }
  return ev
}

const ENVELOPE_KIND: Map<string, string> = new Map([
  ['run.started', 'run.started'],
  ['run.completed', 'run.completed'],
  ['run.failed', 'run.failed'],
  ['delta', 'delta'],
  ['line', 'line'],
  ['tool.started', 'tool.started'],
  ['tool.completed', 'tool.completed'],
  ['approval.required', 'approval.required'],
  ['approval.done', 'approval.done'],
  ['queued', 'queued'],
  ['state', 'state']
])

function isNum(s: string): boolean {
  if (s === '') {
    return false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 48 || c > 57) {
      return false
    }
  }
  return true
}

/** 状态归约:返回新状态(浅拷贝+数组重建,驱动 ArkUI @State 刷新) */
export function reduce(st: ChatState, ev: RunEvent): ChatState {
  if (st.seenEventIds.has(ev.eventId)) {
    return st
  }
  const seen = new Set<string>(st.seenEventIds)
  seen.add(ev.eventId)
  const next: ChatState = {
    sessionId: st.sessionId,
    running: st.running,
    queuePosition: st.queuePosition,
    messages: st.messages,
    streaming: st.streaming,
    streamBuf: st.streamBuf,
    approval: st.approval,
    lastFinalText: st.lastFinalText,
    lastError: st.lastError,
    lastEventSeq: Math.max(st.lastEventSeq, ev.seq),
    seenEventIds: seen
  }

  const extra = ev.extra as Record<string, Object>
  switch (ev.kind) {
    case 'run.started':
      next.running = true
      next.queuePosition = 0
      next.streamBuf = ''
      break
    case 'queued':
      if (typeof extra['position'] === 'number') {
        next.queuePosition = extra['position'] as number
      }
      break
    case 'delta':
      next.streaming = true
      next.streamBuf = next.streamBuf + ev.text
      break
    case 'run.completed': {
      const text = ev.text !== '' ? ev.text : next.streamBuf
      const msgs: ChatMessage[] = next.messages.slice()
      msgs.push({ role: 'assistant', text: text, tools: [] } as ChatMessage)
      next.messages = msgs
      next.running = false
      next.streaming = false
      next.streamBuf = ''
      next.lastFinalText = ev.text
      break
    }
    case 'run.failed':
      next.running = false
      next.streaming = false
      next.lastError = ev.text
      break
    case 'approval.required': {
      const argsRaw: Object | undefined = extra['args']
      const emptyArgs: Record<string, Object> = {}
      const argsObj: Object = argsRaw !== undefined ? argsRaw : emptyArgs
      const ac: ApprovalCard = {
        name: ev.name,
        args: argsObj as object,
        sessionId: ev.sessionId,
        arrivedAt: Date.now()
      }
      next.approval = ac
      break
    }
    case 'approval.done':
      next.approval = null
      break
    default:
      break
  }
  return next
}

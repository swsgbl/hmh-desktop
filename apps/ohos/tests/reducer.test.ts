import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toRunEvent, reduce, newChatState } from './reducer-core.ts'

const S1 = 'sess-aaa'

function raw(event: string, data: any, id = ''): any {
  return { id, event, data }
}

// ---------- 双协议映射 ----------

test('LAN 旧事件名:busy true/false/final/error 语义映射', () => {
  const st = newChatState()
  let ev = toRunEvent(raw('busy', { busy: true, sessionId: S1 }), S1, 1)
  assert.equal(ev!.kind, 'run.started')
  ev = toRunEvent(raw('busy', { busy: false, sessionId: S1 }), S1, 2)
  assert.equal(ev!.kind, 'ignored') // busy:false 不直接驱动,由 final 承担
  ev = toRunEvent(raw('final', { text: 'done', sessionId: S1 }), S1, 3)
  assert.equal(ev!.kind, 'run.completed')
  assert.equal(ev!.text, 'done')
  ev = toRunEvent(raw('error', { message: 'boom', sessionId: S1 }), S1, 4)
  assert.equal(ev!.kind, 'run.failed')
  assert.equal(ev!.text, 'boom')
})

test('LAN:tool/toolResult/approvalReq/approvalDone 映射', () => {
  assert.equal(toRunEvent(raw('tool', { name: 'run_command', sessionId: S1 }), S1, 1)!.kind, 'tool.started')
  const tr = toRunEvent(raw('toolResult', { name: 'run_command', preview: 'ok', sessionId: S1 }), S1, 2)!
  assert.equal(tr.kind, 'tool.completed')
  assert.equal(tr.text, 'ok')
  assert.equal(toRunEvent(raw('approvalReq', { name: 'harmony_install', args: {}, sessionId: S1 }), S1, 3)!.kind, 'approval.required')
  assert.equal(toRunEvent(raw('approvalDone', { name: 'harmony_install', granted: true, sessionId: S1 }), S1, 4)!.kind, 'approval.done')
})

test('hmh 信封协议:kind 直接映射 + eventId 字段', () => {
  const ev = toRunEvent(raw('hmh', { schemaVersion: 1, eventId: 'env-9', kind: 'tool.started', name: 'web_search', sessionId: S1 }), S1, 1)
  assert.equal(ev!.kind, 'tool.started')
  assert.equal(ev!.eventId, 'env-9')
  assert.equal(ev!.name, 'web_search')
  // 未知 kind → null
  assert.equal(toRunEvent(raw('hmh', { kind: '???', eventId: 'x' }), S1, 2), null)
})

// ---------- 会话过滤 ----------

test('会话过滤:他人会话事件丢弃,全局事件放行', () => {
  assert.equal(toRunEvent(raw('delta', { chunk: 'x', sessionId: 'sess-bbb' }), S1, 1), null)
  assert.equal(toRunEvent(raw('state', { busy: false }), S1, 2)!.kind, 'state')
  // 无 sessionId 的 delta(理论不该有)也放行归约
  assert.equal(toRunEvent(raw('delta', { chunk: 'y' }), S1, 3)!.kind, 'delta')
})

// ---------- 去重 ----------

test('eventId 去重:同 id 重复投递只算一次', () => {
  let st = newChatState()
  const ev1 = toRunEvent(raw('delta', { chunk: 'a', sessionId: S1 }, '10'), S1, 10)!
  const ev2 = toRunEvent(raw('delta', { chunk: 'a', sessionId: S1 }, '10'), S1, 10)!
  st = reduce(st, ev1)
  const len = st.streamBuf.length
  st = reduce(st, ev2)
  assert.equal(st.streamBuf.length, len) // 未重复拼接
})

// ---------- 状态归约全流程 ----------

test('全流程:run.started→delta×2→final 完整一轮', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('busy', { busy: true, sessionId: S1 }), S1, 1)!)
  assert.equal(st.running, true)
  st = reduce(st, toRunEvent(raw('delta', { chunk: '你好', sessionId: S1 }), S1, 2)!)
  st = reduce(st, toRunEvent(raw('delta', { chunk: '，世界', sessionId: S1 }), S1, 3)!)
  assert.equal(st.streamBuf, '你好，世界')
  st = reduce(st, toRunEvent(raw('final', { text: '你好，世界！', sessionId: S1 }), S1, 4)!)
  assert.equal(st.running, false)
  assert.equal(st.messages.length, 1)
  assert.equal(st.messages[0].text, '你好，世界！')
  assert.equal(st.streamBuf, '')
})

test('审批卡:required→卡出现,done→卡消失', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('approvalReq', { name: 'harmony_install', args: { hap: 'x.hap' }, sessionId: S1 }), S1, 1)!)
  assert.ok(st.approval)
  assert.equal(st.approval!.name, 'harmony_install')
  st = reduce(st, toRunEvent(raw('approvalDone', { name: 'harmony_install', granted: true, sessionId: S1 }), S1, 2)!)
  assert.equal(st.approval, null)
})

test('排队:queued 事件记录 position', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('queued', { position: 2, sessionId: S1 }), S1, 1)!)
  assert.equal(st.queuePosition, 2)
})

test('error 事件:running 复位 + lastError', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('busy', { busy: true, sessionId: S1 }), S1, 1)!)
  st = reduce(st, toRunEvent(raw('error', { message: 'tool failed', sessionId: S1 }), S1, 2)!)
  assert.equal(st.running, false)
  assert.equal(st.lastError, 'tool failed')
})

test('final 缺 text 时回退 streamBuf', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('delta', { chunk: 'fallback', sessionId: S1 }), S1, 1)!)
  st = reduce(st, toRunEvent(raw('final', { sessionId: S1 }), S1, 2)!)
  assert.equal(st.messages[st.messages.length - 1].text, 'fallback')
})

test('lastEventSeq 单调推进(SSE 重连锚点)', () => {
  let st = newChatState()
  st = reduce(st, toRunEvent(raw('delta', { chunk: 'x', sessionId: S1 }, '10'), S1, 10)!)
  st = reduce(st, toRunEvent(raw('delta', { chunk: 'y', sessionId: S1 }, '3'), S1, 3)!)
  assert.equal(st.lastEventSeq, 10) // seq 回退不回退锚点
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseFramer } from './sse-framer.ts'
import { toRunEvent, reduce, newChatState } from './reducer-core.ts'

/**
 * 门 1 端到端:SSE 原始字节流(模拟 server.ts LAN 真实输出)→ 分帧 → 归约 → 断言 UI 状态
 */

const SESSION = 'sess-e2e'

test('E2E:真实形状字节流(含心跳/多帧粘包/跨块切割)完整一轮对话', () => {
  // 模拟 server.ts 逐段写出的流(块边界故意切在帧中间)
  const chunks = [
    ': ok\n\n',
    'id: 1\nevent: hello\ndata: {"model":"glm","busy":false,"sessionId":"' + SESSION + '"}\n\n',
    'id: 2\nevent: busy\ndata: {"busy":true,"task":"写个脚本","mode":"ask","sessionId":"' + SESSION + '"}\n\nid: 3\nevent: tool\ndata: {"name":"run_command","args":{"command":"node -v"},"sessionId":"' + SESSION + '"}\n\n',
    'id: 4\nevent: toolResult\ndata: {"name":"run_command","isError":false,"preview":"v22.23.3","sessionId":"' + SESSION + '"}\n\n',
    'id: 5\nevent: delta\ndata: {"kind":"assistant","chunk":"命令输出 v22","sessionId":"' + SESSION + '"}\n\nevent: delta\ndata: {"kind":"assistant","chunk":".23.3,正常","sessionId":"' + SESSION + '"}\n\n',
    'id: 7\nevent: final\ndata: {"text":"node 版本 v22.23.3,一切正常。","sessionId":"' + SESSION + '","turns":1}\n\n',
    'id: 8\nevent: busy\ndata: {"busy":false,"sessionId":"' + SESSION + '"}\n\n'
  ]

  const framer = new SseFramer()
  let st = newChatState()
  let seq = 0
  for (const c of chunks) {
    for (const f of framer.push(c)) {
      seq++
      const ev = toRunEvent({ id: f.id, event: f.event, data: safeJson(f.data) }, SESSION, seq)
      if (ev) st = reduce(st, ev)
    }
  }

  assert.equal(st.running, false)            // busy:false 或 final 后归位
  assert.equal(st.messages.length, 1)        // 一条 assistant 消息
  assert.equal(st.messages[0].text, 'node 版本 v22.23.3,一切正常。')
  assert.equal(st.streamBuf, '')             // 流缓冲已清
  assert.equal(st.lastEventSeq, 8)           // 重连锚点=最大 seq
  assert.equal(st.approval, null)
})

test('E2E:审批流(approvalReq → 用户批准 → approvalDone)', () => {
  const framer = new SseFramer()
  let st = newChatState()
  const stream =
    'id: 10\nevent: busy\ndata: {"busy":true,"sessionId":"' + SESSION + '"}\n\n' +
    'id: 11\nevent: approvalReq\ndata: {"name":"harmony_install","args":{"hap":"entry.hap"},"sessionId":"' + SESSION + '"}\n\n' +
    'id: 12\nevent: approvalDone\ndata: {"name":"harmony_install","granted":true,"sessionId":"' + SESSION + '"}\n\n' +
    'id: 13\nevent: final\ndata: {"text":"已安装","sessionId":"' + SESSION + '"}\n\n'
  let seq = 100
  for (const f of framer.push(stream)) {
    seq++
    const ev = toRunEvent({ id: f.id, event: f.event, data: safeJson(f.data) }, SESSION, seq)
    if (ev) st = reduce(st, ev)
  }
  assert.equal(st.messages.length, 1)
  assert.equal(st.messages[0].text, '已安装')
})

test('E2E:断线重连 — Last-Event-ID 之后重放去重(同 seq 帧不重复计入)', () => {
  const framer = new SseFramer()
  let st = newChatState()
  // 第一段流
  let seq = 0
  for (const f of framer.push('id: 20\nevent: busy\ndata: {"busy":true,"sessionId":"' + SESSION + '"}\n\nid: 21\nevent: delta\ndata: {"chunk":"半句话","sessionId":"' + SESSION + '"}\n\n')) {
    seq++
    const ev = toRunEvent({ id: f.id, event: f.event, data: safeJson(f.data) }, SESSION, seq)
    if (ev) st = reduce(st, ev)
  }
  assert.equal(st.streamBuf, '半句话')
  // 重连:服务端从 id 21 重放(重放环行为)
  const framer2 = new SseFramer()
  for (const f of framer2.push('id: 21\nevent: delta\ndata: {"chunk":"半句话","sessionId":"' + SESSION + '"}\n\nid: 22\nevent: final\ndata: {"text":"完整答案","sessionId":"' + SESSION + '"}\n\n')) {
    seq++
    const ev = toRunEvent({ id: f.id, event: f.event, data: safeJson(f.data) }, SESSION, seq)
    if (ev) st = reduce(st, ev)
  }
  // delta id21 去重:streamBuf 不该变成"半句话半句话"
  assert.equal(st.messages[st.messages.length - 1].text, '完整答案')
  assert.ok(!st.messages.some(m => m.text.includes('半句话半句话')))
})

function safeJson(s: string): any {
  try { return JSON.parse(s) } catch { return {} }
}

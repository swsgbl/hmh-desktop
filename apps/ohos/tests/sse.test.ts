import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseFramer } from './sse-framer.ts'

test('单帧完整块:标准 id/event/data', () => {
  const f = new SseFramer()
  const out = f.push('id: 42\nevent: busy\ndata: {"busy":true}\n\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '42')
  assert.equal(out[0].event, 'busy')
  assert.equal(out[0].data, '{"busy":true}')
})

test('字节块任意切割:半帧跨 chunk 拼接', () => {
  const f = new SseFramer()
  const a = f.push('id: 1\nev')
  assert.equal(a.length, 0)
  const b = f.push('ent: delta\nda')
  assert.equal(b.length, 0)
  const c = f.push('ta: {"chunk":"你"}\n')
  assert.equal(c.length, 0)
  const d = f.push('\n')
  assert.equal(d.length, 1)
  assert.equal(d[0].event, 'delta')
  assert.equal(d[0].data, '{"chunk":"你"}')
})

test('CRLF 归一:windows 风格行尾', () => {
  const f = new SseFramer()
  const out = f.push('id: 7\r\nevent: final\r\ndata: {"text":"hi"}\r\n\r\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '7')
  assert.equal(out[0].event, 'final')
})

test('多帧粘包:一次 chunk 含 3 帧', () => {
  const f = new SseFramer()
  const out = f.push('id: 1\nevent: a\ndata: 1\n\nid: 2\nevent: b\ndata: 2\n\nid: 3\nevent: c\ndata: 3\n\n')
  assert.equal(out.length, 3)
  assert.deepEqual(out.map(x => x.id), ['1', '2', '3'])
})

test('data 多行拼接:JSON 分行下发', () => {
  const f = new SseFramer()
  const out = f.push('event: hmh\ndata: {"kind":"delta",\ndata: "chunk":"x"}\n\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].data, '{"kind":"delta",\n"chunk":"x"}')
  assert.equal(JSON.parse(out[0].data.replace('\n', '')).kind, 'delta')
})

test('注释行忽略 + 无 event 只有 data 也能吐帧', () => {
  const f = new SseFramer()
  const out = f.push(': keep-alive\n\ndata: ping\n\n')
  assert.equal(out.length, 1)
  assert.equal(out[0].event, '')
  assert.equal(out[0].data, 'ping')
})

test('flush 残余块:流尾无空行也收尾', () => {
  const f = new SseFramer()
  f.push('event: error\ndata: {"message":"eof"}')
  const out = f.flush()
  assert.equal(out.length, 1)
  assert.equal(out[0].event, 'error')
})

test('心跳注释块不产生帧', () => {
  const f = new SseFramer()
  const out = f.push(': hb\n\n')
  assert.equal(out.length, 0)
})

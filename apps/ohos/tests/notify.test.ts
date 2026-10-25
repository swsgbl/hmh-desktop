/**
 * #19 通知去重纯逻辑(与 ArkTS Notify.ets 同构)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

function notifyIdFor(toolName: string): number {
  let h = 0
  for (let i = 0; i < toolName.length; i++) {
    h = (h * 31 + toolName.charCodeAt(i)) | 0
  }
  return (h >>> 0) % 100000 + 1
}

const DEDUP_WINDOW_MS = 10_000

function shouldNotify(id: number, now: number, lastSent: Map<number, number>): { shouldPublish: boolean; notifyId: number } {
  const prev = lastSent.get(id)
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
    return { shouldPublish: false, notifyId: id }
  }
  lastSent.set(id, now)
  return { shouldPublish: true, notifyId: id }
}

test('notifyIdFor: 稳定正整数且不同工具不同 id(大概率)', () => {
  const a = notifyIdFor('run_command')
  const b = notifyIdFor('run_command')
  const c = notifyIdFor('write_file')
  assert.ok(Number.isInteger(a) && a > 0 && a <= 100000)
  assert.equal(a, b)           // 稳定
  assert.notEqual(a, c)        // 不同工具不同 id(1e5 空间碰撞概率可忽略)
})

test('shouldNotify: 10s 窗口内同 id 去重,过期放行', () => {
  const m = new Map<number, number>()
  const r1 = shouldNotify(42, 1000, m)
  assert.equal(r1.shouldPublish, true)
  const r2 = shouldNotify(42, 1000 + 9999, m)   // 窗口内
  assert.equal(r2.shouldPublish, false)
  const r3 = shouldNotify(42, 1000 + 10_001, m) // 恰过期
  assert.equal(r3.shouldPublish, true)
  const r4 = shouldNotify(43, 1000, m)          // 不同 id 不受影响
  assert.equal(r4.shouldPublish, true)
})

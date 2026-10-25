import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DTO 守卫:server.ts 响应形状的运行时校验(缺字段/错型 → 安全默认值)
 * 与 entry/ets/model/Guards.ets 同构
 */

export function asString(v: unknown, dft = ''): string {
  return typeof v === 'string' ? v : dft
}
export function asNumber(v: unknown, dft = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dft
}
export function asBool(v: unknown, dft = false): boolean {
  return typeof v === 'boolean' ? v : dft
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export interface SessionInfoDto {
  id: string, title: string, outcome: string, turns: number, toolUses: number, updatedAt: string, cwd: string
}

export function guardSessionInfo(v: unknown): SessionInfoDto | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const id = asString(o.id)
  if (id === '') return null
  return {
    id,
    title: asString(o.title, '(untitled)'),
    outcome: asString(o.outcome),
    turns: asNumber(o.turns),
    toolUses: asNumber(o.toolUses),
    updatedAt: asString(o.updatedAt || o.time),
    cwd: asString(o.cwd)
  }
}

export interface StateDto {
  model: string, busy: boolean, approvalPending: boolean, queue: number,
  activeSessionId: string, exposure: string, workspaceName: string
}

export function guardState(v: unknown): StateDto | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const ws = (typeof o.workspace === 'object' && o.workspace !== null) ? (o.workspace as Record<string, unknown>) : null
  return {
    model: asString(o.model),
    busy: asBool(o.busy),
    approvalPending: asBool(o.approvalPending),
    queue: asNumber(o.queue),
    activeSessionId: asString(o.activeSessionId),
    exposure: asString(o.exposure),
    workspaceName: ws ? asString(ws.name) : ''
  }
}

// ---------- 单测 ----------

test('guardSessionInfo:合法对象全字段', () => {
  const s = guardSessionInfo({ id: 's1', title: 'T', outcome: 'ok', turns: 3, toolUses: 5, updatedAt: '2026-10-25', cwd: 'G:\\x' })
  assert.equal(s!.id, 's1')
  assert.equal(s!.turns, 3)
})

test('guardSessionInfo:缺 id → null', () => {
  assert.equal(guardSessionInfo({ title: 'no id' }), null)
  assert.equal(guardSessionInfo(null), null)
  assert.equal(guardSessionInfo('string'), null)
})

test('guardSessionInfo:错型字段回退默认', () => {
  const s = guardSessionInfo({ id: 42, title: 9, turns: 'x' })
  // id 非字符串 → null(严格)
  assert.equal(s, null)
  const s2 = guardSessionInfo({ id: 'ok', turns: 'x', toolUses: null })
  assert.equal(s2!.turns, 0)
  assert.equal(s2!.toolUses, 0)
  assert.equal(s2!.title, '(untitled)')
})

test('guardState:全量与缺 workspace', () => {
  const a = guardState({ model: 'glm', busy: true, approvalPending: false, queue: 2, activeSessionId: 'a1', exposure: 'lan', workspace: { name: 'main', path: 'G:\\' } })
  assert.equal(a!.workspaceName, 'main')
  const b = guardState({ model: 'glm', workspace: null })
  assert.equal(b!.workspaceName, '')
  assert.equal(b!.busy, false)
})

test('guardState:null/非对象 → null;数组(非 null 对象)按缺字段全默认', () => {
  assert.equal(guardState(null), null)
  assert.equal(guardState('str'), null)
  assert.equal(guardState(42), null)
  // 数组 typeof 'object',走宽松路径产出全默认值(安全:不抛异常)
  const arr = guardState([1, 2])
  assert.equal(arr!.model, '')
})

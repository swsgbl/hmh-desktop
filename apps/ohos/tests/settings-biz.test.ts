/**
 * #12 模型选择 / #13 审批模式 / #14 Provider —— 设置页数据装配纯逻辑
 * 同构源:apps/ohos/entry/src/main/ets/model/SettingsBiz.ets
 * 契约(routes/settings.ts 实读):
 *   POST /api/model {name} → {ok, model}
 *   POST /api/config {approval:'ask'|'auto'} → {ok}
 *   POST /api/providers {name,baseUrl,model,apiKey?} → {ok,name}
 *   GET  /api/state.providers[] = [{name, model, purposes?}]
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// ---------- 被测纯逻辑(与 ArkTS SettingsBiz 同构) ----------
interface ProviderRow { name: string; model: string; purposes: string[] }

/** #12 chip 文案:name:model(蓝本"provider+model 对"语义);无 model 降级只显 name */
export function modelChipLabel(name: string, model: string): string {
  if (model === '') return name
  return `${name}:${model}`
}

/** #12 当前高亮判定:/api/model 回读的 model 字段 == provider.model 且该 provider 是当前 chat 路由 */
export function isCurrentProvider(rowName: string, rowModel: string, stateModel: string, stateChat: string): boolean {
  if (stateChat !== '' && rowName === stateChat) return true
  return stateModel !== '' && rowModel !== '' && rowModel === stateModel
}

/** #13 审批模式值域守卫(服务端 400 'approval must be ask|auto') */
export function validApproval(v: string): boolean {
  return v === 'ask' || v === 'auto'
}

/** #14 表单校验(服务端同款:name/baseUrl/model 三必填;apiKey 可空=保留) */
export function validateProviderForm(name: string, baseUrl: string, model: string): string {
  if (name.trim() === '') return 'name required'
  if (baseUrl.trim() === '') return 'baseUrl required'
  if (model.trim() === '') return 'model required'
  return ''
}

/** #14 providers[] 解析守卫(非数组/缺 name 直接空,不抛) */
export function parseProviderRows(raw: unknown): ProviderRow[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderRow[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const o = p as Record<string, unknown>
    if (typeof o['name'] !== 'string' || o['name'] === '') continue
    const model = typeof o['model'] === 'string' ? (o['model'] as string) : ''
    const purposes = Array.isArray(o['purposes'])
      ? (o['purposes'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    out.push({ name: o['name'] as string, model, purposes })
  }
  return out
}

// ---------- #11 @引用:搜索结果 → chip 渲染模型 ----------
interface FsSearchHit { rel: string; path: string; kind: string }

/** rel 截短显示(>28 字符取尾部,保留文件名——蓝本同款省中策略) */
export function relChipText(rel: string): string {
  if (rel.length <= 28) return rel
  return '…' + rel.slice(rel.length - 27)
}

/** 选中集去重追加(同 rel 不重复;上限 5 个,防任务体膨胀) */
export function addAttachment(list: string[], rel: string): string[] {
  if (rel === '' || list.includes(rel) || list.length >= 5) return list
  return [...list, rel]
}

// ---------- 测试 ----------
test('#12 modelChipLabel: name:model 组合与降级', () => {
  assert.equal(modelChipLabel('agnes', 'glm-4.7'), 'agnes:glm-4.7')
  assert.equal(modelChipLabel('deepseek', ''), 'deepseek')
})

test('#12 isCurrentProvider: chat 路由名优先,回退 model 匹配', () => {
  assert.ok(isCurrentProvider('agnes', 'glm-4.7', 'glm-4.7', 'agnes'))
  assert.ok(isCurrentProvider('agnes', 'glm-4.7', 'glm-4.7', ''))       // 无 chat 字段时按 model
  assert.ok(!isCurrentProvider('deepseek', 'deepseek-chat', 'glm-4.7', 'agnes'))
  assert.ok(!isCurrentProvider('x', '', 'glm-4.7', ''))                  // 空 model 永不命中
})

test('#13 validApproval: ask/auto 通过,其余拒绝', () => {
  assert.ok(validApproval('ask'))
  assert.ok(validApproval('auto'))
  assert.ok(!validApproval('yolo'))
  assert.ok(!validApproval(''))
})

test('#14 validateProviderForm: 三必填校验与服务端同序', () => {
  assert.equal(validateProviderForm('', 'http://x', 'm'), 'name required')
  assert.equal(validateProviderForm('n', '  ', 'm'), 'baseUrl required')
  assert.equal(validateProviderForm('n', 'http://x', ''), 'model required')
  assert.equal(validateProviderForm(' n ', ' http://x ', ' m '), '')
})

test('#14 parseProviderRows: 守卫畸形输入', () => {
  assert.deepEqual(parseProviderRows(null), [])
  assert.deepEqual(parseProviderRows('nope'), [])
  assert.deepEqual(parseProviderRows([null, 42, { name: '' }, { model: 'm' }]), [])
  const rows = parseProviderRows([
    { name: 'agnes', model: 'glm-4.7', purposes: ['chat'] },
    { name: 'deepseek', model: 'deepseek-chat', purposes: 'not-array' },
    { name: 'local' },
  ])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { name: 'agnes', model: 'glm-4.7', purposes: ['chat'] })
  assert.deepEqual(rows[1].purposes, [])
  assert.equal(rows[2].model, '')
})

test('#11 relChipText: 短路径原样,长路径省中保尾', () => {
  assert.equal(relChipText('package.json'), 'package.json')
  assert.equal(relChipText('a'.repeat(40)), '…' + 'a'.repeat(27))
})

test('#11 addAttachment: 去重+空串拒绝+5 上限', () => {
  let l: string[] = []
  l = addAttachment(l, 'docs/a.md')
  assert.deepEqual(l, ['docs/a.md'])
  l = addAttachment(l, 'docs/a.md')                    // 重复
  assert.equal(l.length, 1)
  l = addAttachment(l, '')                              // 空串
  assert.equal(l.length, 1)
  l = addAttachment(l, 'b1'); l = addAttachment(l, 'b2'); l = addAttachment(l, 'b3'); l = addAttachment(l, 'b4')
  assert.equal(l.length, 5)
  l = addAttachment(l, 'b6')                            // 超上限
  assert.equal(l.length, 5)
})

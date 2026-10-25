/**
 * 设置页业务纯逻辑(与 tests/settings-biz.test.ts 同构)
 * #12 模型选择 / #13 审批模式 / #14 Provider / #11 @引用 chip
 */
import { ProviderRow, FsSearchHit } from './Types'

export function modelChipLabel(name: string, model: string): string {
  if (model === '') {
    return name
  }
  return `${name}:${model}`
}

export function isCurrentProvider(rowName: string, rowModel: string, stateModel: string, stateChat: string): boolean {
  if (stateChat !== '' && rowName === stateChat) {
    return true
  }
  return stateModel !== '' && rowModel !== '' && rowModel === stateModel
}

export function validApproval(v: string): boolean {
  return v === 'ask' || v === 'auto'
}

export function validateProviderForm(name: string, baseUrl: string, model: string): string {
  if (name.trim() === '') {
    return 'name required'
  }
  if (baseUrl.trim() === '') {
    return 'baseUrl required'
  }
  if (model.trim() === '') {
    return 'model required'
  }
  return ''
}

export function parseProviderRows(raw: object[] | null): ProviderRow[] {
  if (raw === null) {
    return []
  }
  const out: ProviderRow[] = []
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as Record<string, Object>
    const n = p['name']
    if (typeof n !== 'string' || n === '') {
      continue
    }
    const m = p['model']
    const model = typeof m === 'string' ? m as string : ''
    const purposes: string[] = []
    const pu = p['purposes']
    if (pu instanceof Array) {
      const arr = pu as Object[]
      for (let j = 0; j < arr.length; j++) {
        const s = arr[j]
        if (typeof s === 'string') {
          purposes.push(s as string)
        }
      }
    }
    out.push({ name: n as string, model: model, purposes: purposes } as ProviderRow)
  }
  return out
}

export function relChipText(rel: string): string {
  if (rel.length <= 28) {
    return rel
  }
  return '…' + rel.slice(rel.length - 27)
}

export function addAttachment(list: string[], rel: string): string[] {
  if (rel === '' || list.indexOf(rel) >= 0 || list.length >= 5) {
    return list
  }
  const out = list.slice()
  out.push(rel)
  return out
}

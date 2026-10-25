/**
 * 回合条目归约 ArkTS 版(与 tests/turn-items.ts 同构,严苛模式)
 * 蓝本:apps/desktop App.tsx Item 七类的可用子集:
 *   tool 卡(折叠,running/ok/error)/ turnSum 汇总卡 / deliverable 交付物卡
 */
export type ToolStatus = 'running' | 'ok' | 'error'

export class ToolItem {
  kind: string = 'tool'
  name: string = ''
  argsPreview: string = ''
  status: ToolStatus = 'running'
  resultPreview: string = ''
}

export class TurnSumItem {
  kind: string = 'turnSum'
  turns: number = 0
  toolUses: number = 0
  tokens: number = -1  // -1 = 无数据(显示时省略)
}

export class DeliverableItem {
  kind: string = 'deliverable'
  relPath: string = ''
  tool: string = ''
}

export type TurnItem = ToolItem | TurnSumItem | DeliverableItem

const WRITE_TOOLS: Set<string> = new Set<string>([
  'write_file', 'edit_file', 'apply_patch', 'save_file', 'writeFile', 'editFile'
])

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name)
}

/** tool 事件 args 提取预览:path 优先,否则 JSON 截断(蓝本 preview 语义)。 */
export function previewArgs(args: Object | null): string {
  if (args !== null && typeof args === 'object') {
    const a = args as Record<string, Object>
    const p0 = a['path']
    const p1 = a['file_path']
    const p2 = a['file']
    let p = ''
    if (typeof p0 === 'string' && (p0 as string).length > 0) {
      p = p0 as string
    } else if (typeof p1 === 'string' && (p1 as string).length > 0) {
      p = p1 as string
    } else if (typeof p2 === 'string' && (p2 as string).length > 0) {
      p = p2 as string
    }
    if (p !== '') {
      return p
    }
  }
  try {
    const j = JSON.stringify(args ?? {})
    return j.length > 120 ? j.substring(0, 117) + '…' : j
  } catch (e) {
    return ''
  }
}

/** 写类工具 args 里挖交付物路径。 */
export function deliverablePath(args: Object | null): string {
  if (args === null) {
    return ''
  }
  const a = args as Record<string, Object>
  const p0 = a['path']
  const p1 = a['file_path']
  const p2 = a['file']
  if (typeof p0 === 'string' && (p0 as string).length > 0) {
    return p0 as string
  }
  if (typeof p1 === 'string' && (p1 as string).length > 0) {
    return p1 as string
  }
  if (typeof p2 === 'string' && (p2 as string).length > 0) {
    return p2 as string
  }
  return ''
}

export class TurnItemsState {
  items: TurnItem[] = []
  openTool: Map<string, number> = new Map<string, number>()
  /** tool 名 → args(交付物路径提取用) */
  toolArgs: Map<string, Object> = new Map<string, Object>()
}

export function initialTurnItems(): TurnItemsState {
  return new TurnItemsState()
}

export function onTool(s: TurnItemsState, name: string, args: Object | null): TurnItemsState {
  const next = new TurnItemsState()
  next.items = s.items.slice()
  next.openTool = new Map<string, number>(s.openTool)
  next.toolArgs = new Map<string, Object>(s.toolArgs)
  if (name !== '') {
    const emptyArgs: Record<string, Object> = {}
    next.toolArgs.set(name, args !== null ? args : emptyArgs)
  }
  // 同名并发:聚合到既有 running 卡
  if (name !== '' && next.openTool.has(name)) {
    return next
  }
  const item = new ToolItem()
  item.name = name
  item.argsPreview = previewArgs(args)
  item.status = 'running'
  item.resultPreview = ''
  const arr = next.items.slice()
  arr.push(item)
  next.items = arr
  if (name !== '') {
    next.openTool.set(name, arr.length - 1)
  }
  return next
}

export function onToolResult(s: TurnItemsState, name: string, isError: boolean, preview: string): TurnItemsState {
  const next = new TurnItemsState()
  next.toolArgs = new Map<string, Object>(s.toolArgs)
  const idx = name !== '' ? s.openTool.get(name) : undefined
  if (idx === undefined) {
    // 迟到 result:补终态卡
    const item = new ToolItem()
    item.name = name
    item.argsPreview = ''
    item.status = isError ? 'error' : 'ok'
    item.resultPreview = preview.length > 200 ? preview.substring(0, 200) : preview
    const arr = s.items.slice()
    arr.push(item)
    next.items = arr
    next.openTool = new Map<string, number>(s.openTool)
    return next
  }
  const arr = s.items.slice()
  const old = arr[idx]
  if (old instanceof ToolItem) {
    const upd = new ToolItem()
    upd.name = old.name
    upd.argsPreview = old.argsPreview
    upd.status = isError ? 'error' : 'ok'
    upd.resultPreview = preview.length > 200 ? preview.substring(0, 200) : preview
    arr[idx] = upd
  }
  next.items = arr
  const open = new Map<string, number>(s.openTool)
  if (name !== '') {
    open.delete(name)
  }
  next.openTool = open
  return next
}

/** final:追加交付物卡(本轮 write 类工具)+ turnSum 汇总。 */
export function onFinal(s: TurnItemsState, turns: number, toolUses: number, tokens: number): TurnItemsState {
  const next = new TurnItemsState()
  const arr = s.items.slice()
  const seen: Set<string> = new Set<string>()
  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i]
    if (!(it instanceof ToolItem)) {
      continue
    }
    if (!isWriteTool(it.name)) {
      continue
    }
    const args = s.toolArgs.get(it.name) ?? null
    const p = deliverablePath(args)
    if (p !== '' && !seen.has(p)) {
      seen.add(p)
      const d = new DeliverableItem()
      d.relPath = p
      d.tool = it.name
      arr.push(d)
    }
  }
  const sum = new TurnSumItem()
  sum.turns = turns
  sum.toolUses = toolUses
  sum.tokens = tokens
  arr.push(sum)
  next.items = arr
  next.openTool = new Map<string, number>()
  next.toolArgs = new Map<string, Object>()
  return next
}

/** busy:true(新回合)清空条目。 */
export function onRunStart(s: TurnItemsState): TurnItemsState {
  return initialTurnItems()
}

export function turnSumText(turns: number, toolUses: number, tokens: number): string {
  let s = `${turns} 回合 · ${toolUses} 次工具`
  if (tokens > 0) {
    s += ` · ${tokens} tokens`
  }
  return s
}

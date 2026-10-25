/**
 * 会话列表视图模型 ArkTS 版(与 tests/session-list.ts 同构)
 * 分组/收藏置顶/状态过滤/折叠。pin 与折叠为客户端本地偏好(preferences)。
 */
export type StatusFilter = 'all' | 'running' | 'done' | 'failed'

export class SessionRow {
  id: string = ''
  title: string = ''
  task: string = ''
  outcome: string = ''
  workspace: string = ''
  running: boolean = false
  turns: number = 0
  toolUses: number = 0
  pinned: boolean = false
  updatedAt: string = ''
}

export class SessionGroup {
  workspace: string = ''
  collapsed: boolean = false
  rows: SessionRow[] = []
}

export function applyFilter(rows: SessionRow[], f: StatusFilter): SessionRow[] {
  if (f === 'all') {
    return rows
  }
  const out: SessionRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (f === 'running' && r.running) {
      out.push(r)
    } else if (f === 'done' && !r.running && r.outcome !== 'error') {
      out.push(r)
    } else if (f === 'failed' && !r.running && r.outcome === 'error') {
      out.push(r)
    }
  }
  return out
}

/** 组内:pin 置顶 + updatedAt 降序;组间:含 pin 组优先。 */
export function groupByWorkspace(rows: SessionRow[], collapsed: Set<string>): SessionGroup[] {
  const byWs = new Map<string, SessionRow[]>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const key = r.workspace
    if (!byWs.has(key)) {
      byWs.set(key, [])
    }
    (byWs.get(key) as SessionRow[]).push(r)
  }
  const groups: SessionGroup[] = []
  const keys = Array.from(byWs.keys())
  for (let k = 0; k < keys.length; k++) {
    const ws = keys[k]
    const list = (byWs.get(ws) as SessionRow[]).slice()
    list.sort((a: SessionRow, b: SessionRow): number => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1
      }
      if (a.updatedAt === b.updatedAt) {
        return 0
      }
      return a.updatedAt > b.updatedAt ? -1 : 1
    })
    const g = new SessionGroup()
    g.workspace = ws
    g.collapsed = collapsed.has(ws)
    g.rows = list
    groups.push(g)
  }
  groups.sort((a: SessionGroup, b: SessionGroup): number => {
    let pa = 0
    let pb = 0
    for (let i = 0; i < a.rows.length; i++) {
      if (a.rows[i].pinned) {
        pa = 1
        break
      }
    }
    for (let i = 0; i < b.rows.length; i++) {
      if (b.rows[i].pinned) {
        pb = 1
        break
      }
    }
    if (pa !== pb) {
      return pb - pa
    }
    const ta = a.rows.length > 0 ? a.rows[0].updatedAt : ''
    const tb = b.rows.length > 0 ? b.rows[0].updatedAt : ''
    if (ta === tb) {
      return 0
    }
    return ta > tb ? -1 : 1
  })
  return groups
}

export function toggleGroup(collapsed: Set<string>, ws: string): Set<string> {
  const n = new Set<string>(collapsed)
  if (n.has(ws)) {
    n.delete(ws)
  } else {
    n.add(ws)
  }
  return n
}

export function wsGroupLabel(ws: string, n: number): string {
  const name = ws === '' ? '未记录工作区' : ws
  return `${name} · ${n} 个会话`
}

/**
 * DTO 守卫:服务端响应形状的运行时校验(与 tests/dto.test.ts 同构)
 * 一切外部 JSON 经守卫进入 UI,错型回退安全默认值,绝不抛异常。
 */
import { SessionInfo, StateObj, WorkspaceInfo, WorkspacesResp, FsDirResp, FsEntry, FsReadResp, SessionsResp } from './Types'

function asString(v: Object | undefined, dft: string): string {
  return typeof v === 'string' ? v : dft
}
function asNumber(v: Object | undefined, dft: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dft
}
function asBool(v: Object | undefined, dft: boolean): boolean {
  return typeof v === 'boolean' ? v : dft
}

export function guardState(v: Object | undefined): StateObj | null {
  if (typeof v !== 'object' || v === null) {
    return null
  }
  const o = v as Record<string, Object>
  let ws: WorkspaceInfo | null = null
  const rawWs = o['workspace']
  if (typeof rawWs === 'object' && rawWs !== null) {
    const w = rawWs as Record<string, Object>
    ws = {
      id: asString(w['id'], ''),
      name: asString(w['name'], ''),
      path: asString(w['path'], '')
    } as WorkspaceInfo
  }
  const bs: string[] = []
  const rawBs: Object | undefined = o['busySessions']
  if (Array.isArray(rawBs)) {
    const arr: Object[] = rawBs as Object[]
    for (const s of arr) {
      if (typeof s === 'string') {
        bs.push(s as string)
      }
    }
  }
  // server sends queue as string[] (allQueued().map(t=>t.text)); count it
  let qn = 0
  const rawQ: Object | undefined = o['queue']
  if (Array.isArray(rawQ)) {
    qn = rawQ.length
  } else if (typeof rawQ === 'number') {
    qn = rawQ as number
  }
  return {
    model: asString(o['model'], ''),
    chatProvider: asString(o['chatProvider'], ''),
    home: asString(o['home'], ''),
    locale: asString(o['locale'], ''),
    busy: asBool(o['busy'], false),
    busySessions: bs,
    approvalPending: asBool(o['approvalPending'], false),
    queue: qn,
    activeSessionId: asString(o['activeSessionId'], ''),
    activeThreadCwd: asString(o['activeThreadCwd'], ''),
    exposure: asString(o['exposure'], ''),
    workspace: ws,
    daemonVersion: asString(o['daemonVersion'], '')
  } as StateObj
}

export function guardSessionInfo(v: Object | undefined): SessionInfo | null {
  if (typeof v !== 'object' || v === null) {
    return null
  }
  const o = v as Record<string, Object>
  const id = asString(o['id'], '')
  if (id === '') {
    return null
  }
  return {
    id: id,
    title: asString(o['title'], '(untitled)'),
    task: asString(o['task'], ''),
    outcome: asString(o['outcome'], ''),
    turns: asNumber(o['turns'], 0),
    toolUses: asNumber(o['toolUses'], 0),
    time: asString(o['time'], ''),
    cwd: asString(o['cwd'], ''),
    branch: asString(o['branch'], ''),
    createdAt: asString(o['createdAt'], ''),
    updatedAt: asString(o['updatedAt'], '')
  } as SessionInfo
}

export function guardSessionsResp(v: Object | undefined): SessionsResp {
  const empty: SessionsResp = { sessions: [], nextCursor: '', workspace: '' } as SessionsResp
  if (typeof v !== 'object' || v === null) {
    return empty
  }
  const o = v as Record<string, Object>
  const rawList = o['sessions'] as Object[]
  if (!Array.isArray(rawList)) {
    return empty
  }
  const out: SessionInfo[] = []
  for (const item of rawList) {
    const s = guardSessionInfo(item as Object)
    if (s !== null) {
      out.push(s)
    }
  }
  return {
    sessions: out,
    nextCursor: asString(o['nextCursor'], ''),
    workspace: asString(o['workspace'], '')
  } as SessionsResp
}

export function guardWorkspacesResp(v: Object | undefined): WorkspacesResp {
  const empty: WorkspacesResp = { current: '', items: [] } as WorkspacesResp
  if (typeof v !== 'object' || v === null) {
    return empty
  }
  const o = v as Record<string, Object>
  const rawList = o['items'] as Object[]
  const items: WorkspaceInfo[] = []
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (typeof item === 'object' && item !== null) {
        const w = item as Record<string, Object>
        items.push({
          id: asString(w['id'], ''),
          name: asString(w['name'], ''),
          path: asString(w['path'], '')
        } as WorkspaceInfo)
      }
    }
  }
  return { current: asString(o['current'], ''), items: items } as WorkspacesResp
}

export function guardFsDir(v: Object | undefined): FsDirResp | null {
  if (typeof v !== 'object' || v === null) {
    return null
  }
  const o = v as Record<string, Object>
  const dirs: FsEntry[] = []
  const files: FsEntry[] = []
  const rawDirs = o['dirs'] as Object[]
  if (Array.isArray(rawDirs)) {
    for (const d of rawDirs) {
      if (typeof d === 'object' && d !== null) {
        const r = d as Record<string, Object>
        dirs.push({ name: asString(r['name'], ''), path: asString(r['path'], '') } as FsEntry)
      }
    }
  }
  const rawFiles = o['files'] as Object[]
  if (Array.isArray(rawFiles)) {
    for (const f of rawFiles) {
      if (typeof f === 'object' && f !== null) {
        const r = f as Record<string, Object>
        files.push({ name: asString(r['name'], ''), path: asString(r['path'], '') } as FsEntry)
      }
    }
  }
  const segments: FsSegmentLite[] = []
  const rawSegs = o['segments'] as Object[]
  if (Array.isArray(rawSegs)) {
    for (const s of rawSegs) {
      if (typeof s === 'object' && s !== null) {
        const r = s as Record<string, Object>
        segments.push({ name: asString(r['name'], ''), path: asString(r['path'], '') } as FsSegmentLite)
      }
    }
  }
  const resp: FsDirResp = {
    path: asString(o['path'], ''),
    segments: segments as object[],
    parent: asString(o['parent'], ''),
    dirs: dirs
  } as FsDirResp
  if (files.length > 0) {
    resp.files = files
  }
  return resp
}

interface FsSegmentLite {
  name: string
  path: string
}

export function guardFsRead(v: Object | undefined): FsReadResp | null {
  if (typeof v !== 'object' || v === null) {
    return null
  }
  const o = v as Record<string, Object>
  const resp: FsReadResp = {
    path: asString(o['path'], ''),
    rel: asString(o['rel'], ''),
    size: asNumber(o['size'], 0),
    binary: asBool(o['binary'], false)
  } as FsReadResp
  if (typeof o['text'] === 'string') {
    resp.text = o['text'] as string
  }
  if (o['truncated'] === true) {
    resp.truncated = true
  }
  return resp
}

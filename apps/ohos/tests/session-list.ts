/**
 * 会话列表视图模型(纯逻辑,同构 SessionList.ets):工作区分组 + 收藏置顶 + 状态过滤。
 * 蓝本:apps/desktop App.tsx sidebar——
 *   分组:按 workspace(cwd)分组,组头"名称(n 个会话)"可折叠;
 *   收藏:pin 列表,★ 前缀置顶(组内也置顶);
 *   过滤:全部/运行中/已完成/失败。
 */
export type StatusFilter = 'all' | 'running' | 'done' | 'failed';

export interface SessionRow {
  id: string;
  title: string;
  workspace: string; // '' = 未记录
  running: boolean;
  failed: boolean; // 末次运行失败(error 事件)
  turns: number;
  pinned: boolean;
  updatedAt: number; // ms epoch,排序用
}

export interface SessionGroup {
  workspace: string; // '' 显示为"未记录工作区"
  collapsed: boolean;
  rows: SessionRow[];
}

export function applyFilter(rows: SessionRow[], f: StatusFilter): SessionRow[] {
  if (f === 'all') return rows;
  if (f === 'running') return rows.filter((r) => r.running);
  if (f === 'done') return rows.filter((r) => !r.running && !r.failed);
  return rows.filter((r) => r.failed && !r.running);
}

export function groupByWorkspace(rows: SessionRow[], collapsed: Set<string>): SessionGroup[] {
  const byWs = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const key = r.workspace;
    if (!byWs.has(key)) byWs.set(key, []);
    byWs.get(key)!.push(r);
  }
  const groups: SessionGroup[] = [];
  for (const [ws, list] of byWs) {
    // 组内:收藏置顶,其余按 updatedAt 降序。
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    groups.push({ workspace: ws, collapsed: collapsed.has(ws), rows: list });
  }
  // 组间:含收藏会话的组优先,再按组内最新 updatedAt 降序。
  groups.sort((a, b) => {
    const pa = a.rows.some((r) => r.pinned) ? 1 : 0;
    const pb = b.rows.some((r) => r.pinned) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ta = a.rows.length > 0 ? a.rows[0].updatedAt : 0;
    const tb = b.rows.length > 0 ? b.rows[0].updatedAt : 0;
    return tb - ta;
  });
  return groups;
}

export function toggleGroup(collapsed: Set<string>, ws: string): Set<string> {
  const n = new Set(collapsed);
  if (n.has(ws)) n.delete(ws); else n.add(ws);
  return n;
}

export function wsGroupLabel(ws: string, n: number): string {
  const name = ws === '' ? '未记录工作区' : ws;
  return `${name}(${n} 个会话)`;
}

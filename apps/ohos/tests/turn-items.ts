/**
 * 回合条目归约(纯逻辑,与 ArkTS 零依赖,同构 TurnItems.ets)。
 *
 * LAN SSE 事件(server.ts broadcast):
 *   tool       { name, args, sessionId }
 *   toolResult { name, isError, preview, full, sessionId }
 *   final      { text, sessionId, runId, turns, toolUses, usage }
 * 蓝本(desktop App.tsx Item 七类)在鸿蒙侧的可用子集:
 *   tool 卡(折叠,含状态)/ turnSum 汇总卡 / deliverable 交付物卡(write/edit 类)。
 */
export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolItem {
  kind: 'tool';
  name: string;
  argsPreview: string;
  status: ToolStatus;
  resultPreview: string;
}
export interface TurnSumItem {
  kind: 'turnSum';
  turns: number;
  toolUses: number;
  tokens: number | null;
}
export interface DeliverableItem {
  kind: 'deliverable';
  relPath: string;
  tool: string;
}
export type TurnItem = ToolItem | TurnSumItem | DeliverableItem;

/** 写类工具(产物落盘)判定——蓝本交付物=git 变更;LAN 无 artifact 事件,以此近似。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'save_file', 'writeFile', 'editFile']);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

/** 从 tool 事件 args 提取预览(蓝本 preview(): path>0 else JSON 截断)。 */
export function previewArgs(args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const p = a['path'] ?? a['file_path'] ?? a['file'];
    if (typeof p === 'string' && p.length > 0) return p;
  }
  try {
    const j = JSON.stringify(args ?? {});
    return j.length > 120 ? j.slice(0, 117) + '…' : j;
  } catch {
    return '';
  }
}

/** tool 事件的 args 里挖交付物相对路径。 */
export function deliverablePath(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const p = a['path'] ?? a['file_path'] ?? a['file'];
  return typeof p === 'string' && p.length > 0 ? p : null;
}

export interface TurnItemsState {
  items: TurnItem[];
  /** name -> 下标(运行中的 tool 卡,toolResult 到达时回填)。 */
  openTool: Map<string, number>;
}

export function initialTurnItems(): TurnItemsState {
  return { items: [], openTool: new Map() };
}

export interface ToolEv { name: string; args?: unknown }
export interface ToolResultEv { name: string; isError?: boolean; preview?: string }
export interface FinalEv { turns?: number; toolUses?: number; usage?: { totalTokens?: number } | null }

export function onTool(s: TurnItemsState, ev: ToolEv): TurnItemsState {
  const name = ev.name ?? '';
  // 同名并发:聚合到既有 running 卡(蓝本按 run 聚合)。
  if (s.openTool.has(name)) return s;
  const item: ToolItem = {
    kind: 'tool', name, argsPreview: previewArgs(ev.args),
    status: 'running', resultPreview: '',
  };
  return { items: [...s.items, item], openTool: new Map(s.openTool).set(name, s.items.length) };
}

export function onToolResult(s: TurnItemsState, ev: ToolResultEv): TurnItemsState {
  const name = ev.name ?? '';
  const idx = s.openTool.get(name);
  if (idx === undefined) {
    // 迟到的 result(无 running 卡):补一张终态卡。
    const item: ToolItem = {
      kind: 'tool', name, argsPreview: '', status: ev.isError === true ? 'error' : 'ok',
      resultPreview: (ev.preview ?? '').slice(0, 200),
    };
    return { items: [...s.items, item], openTool: s.openTool };
  }
  const items = s.items.slice();
  const old = items[idx];
  if (old.kind === 'tool') {
    items[idx] = {
      ...old,
      status: ev.isError === true ? 'error' : 'ok',
      resultPreview: (ev.preview ?? '').slice(0, 200),
    };
  }
  const openTool = new Map(s.openTool);
  openTool.delete(name);
  return { items, openTool };
}

/** final 到达:追加 turnSum + 从本轮 tool 流提取交付物卡。 */
export function onFinal(s: TurnItemsState, ev: FinalEv, toolArgs: Map<string, unknown>): TurnItemsState {
  const tokens = ev.usage && typeof ev.usage.totalTokens === 'number' ? ev.usage.totalTokens : null;
  const sum: TurnSumItem = {
    kind: 'turnSum',
    turns: typeof ev.turns === 'number' ? ev.turns : 0,
    toolUses: typeof ev.toolUses === 'number' ? ev.toolUses : 0,
    tokens,
  };
  const deliverables: DeliverableItem[] = [];
  const seen = new Set<string>();
  for (const it of s.items) {
    if (it.kind !== 'tool' || !isWriteTool(it.name)) continue;
    const p = deliverablePath(toolArgs.get(it.name));
    if (p !== null && !seen.has(p)) {
      seen.add(p);
      deliverables.push({ kind: 'deliverable', relPath: p, tool: it.name });
    }
  }
  return { items: [...s.items, ...deliverables, sum], openTool: new Map() };
}

/** 新回合(busy:true)清空上一轮条目,新 run 重新累积。 */
export function onRunStart(s: TurnItemsState): TurnItemsState {
  return initialTurnItems();
}

export function turnSumText(t: { turns: number; toolUses: number; tokens: number | null }): string {
  return `${t.turns} 回合 · ${t.toolUses} 次工具${t.tokens !== null && t.tokens > 0 ? ` · ${t.tokens} tokens` : ''}`;
}

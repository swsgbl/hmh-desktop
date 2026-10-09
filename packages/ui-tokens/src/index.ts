/**
 * 设计 token 的 TS 侧(与 tokens.css 同源)。间距单位 = 4px 网格。
 * 语义状态色对应八态:planning/running/waiting_approval/verifying/
 * recovering/completed/failed/cancelled。
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** 左侧导航 250–280px;Context Dock 320–420px(信息架构文档 03 §六)。 */
export const layout = {
  sidebarMinPx: 250,
  sidebarMaxPx: 280,
  dockMinPx: 320,
  dockMaxPx: 420,
  readingWidthPx: 760,
} as const;

export const runStatusColor: Record<string, string> = {
  planning: 'var(--hmh-status-planning)',
  running: 'var(--hmh-status-running)',
  waiting_approval: 'var(--hmh-status-waiting)',
  verifying: 'var(--hmh-status-verifying)',
  recovering: 'var(--hmh-status-recovering)',
  completed: 'var(--hmh-status-completed)',
  failed: 'var(--hmh-status-failed)',
  cancelled: 'var(--hmh-status-cancelled)',
};

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

/** HIG RFC 2026-10-27 字体层级(与 tokens.css 的 caption/subtle/body/heading/title 同源)。 */
export const typeScale = {
  caption: { fontSize: 12, lineHeight: 18 },
  subtle: { fontSize: 13, lineHeight: 20 },
  body: { fontSize: 15, lineHeight: 23 },
  heading: { fontSize: 20, lineHeight: 28 },
  title: { fontSize: 28, lineHeight: 34 },
} as const;

/** HIG RFC 2026-10-27 圆角语义:控件 6-8 / 浮层 10-12 / 面板 14-16。 */
export const radius = { control: 8, overlay: 12, panel: 16 } as const;

/** HIG RFC 2026-10-27 动效语义档(毫秒):hover 100-140 / 面板 160-220 / 完成 200-260。 */
export const motion = { hover: 120, panel: 180, complete: 230 } as const;

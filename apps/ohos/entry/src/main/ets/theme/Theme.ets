/**
 * v3 三栏工作台布局(1:1 复刻 apps/desktop app.css .app-shell)
 * 色板/尺寸逐值抄 tokens.css 与 app.css
 */

// ---------- 色板(暗色默认) ----------
export class Theme {
  static readonly bg: string = '#141416'
  static readonly raised: string = '#1B1D21'
  static readonly panel: string = '#1E2024'
  static readonly border: string = '#2B2E33'
  static readonly text: string = '#F5F5F6'
  static readonly dim: string = '#95979D'
  static readonly accent: string = '#2F81F7'
  static readonly accentHover: string = '#4A90F9'
  static readonly danger: string = '#F85149'
  static readonly warn: string = '#D29922'
  static readonly userTurn: string = '#1C2A3D'
  static readonly running: string = '#2F81F7'
  static readonly completed: string = '#3FB950'
  static readonly failed: string = '#F85149'
  static readonly planning: string = '#A371F7'
  static readonly waiting: string = '#D29922'
  static readonly cancelled: string = '#95979D'
}

// ---------- 尺寸(蓝本逐值) ----------
export class Metrics {
  static readonly titlebarH: number = 36
  static readonly sidebarW: number = 264
  static readonly sidebarMin: number = 250
  static readonly sidebarMax: number = 280
  static readonly dockW: number = 360
  static readonly dockMin: number = 320
  static readonly dockMax: number = 420
  static readonly sidebarHeadPad: number = 12
  static readonly sessionListPad: number = 8
  static readonly streamPad: number = 24
  static readonly streamGap: number = 12
  static readonly turnMaxW: number = 760
  static readonly turnPadH: number = 16
  static readonly turnPadV: number = 12
  static readonly composerPadH: number = 16
  static readonly composerPadV: number = 12
  static readonly topbarPadH: number = 16
  static readonly topbarPadV: number = 8
  static readonly dockBodyPad: number = 12
  static readonly dockTabsPad: number = 8
  static readonly radiusSm: number = 6
  static readonly radiusMd: number = 10
  static readonly radiusLg: number = 14
  static readonly iconBtnMin: number = 36
  static readonly sendH: number = 44
}

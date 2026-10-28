/**
 * v4 设计语言:DSH 官方风格(蓝本 docs/prompts/design-language-dsh.md
 * + evidence/dsh/src/alias-theme.css 实测静态值)
 * 浅色明亮分层默认;深色同 alias 换值;结构与尺寸沿 v3 不回退。
 */

// ---------- 双主题 token(逐值按蓝本 §1) ----------
export class ThemeVals {
  // 背景三级
  bg: string = '#f9fafb'          // bg-base(=dsw bluish-50 rgb249,250,251)
  l1: string = '#ffffff'          // bg-layer-1 卡片/输入底
  l2: string = '#f2f3f5'          // bg-layer-2 pill/次级面板
  // 文字四级
  text: string = '#0f1115'        // label-primary(=bluish-1000)
  text2: string = '#61666b'       // label-secondary(=bluish-700)
  text3: string = '#81858c'       // label-tertiary(=bluish-600)
  dim: string = '#adb0b6'         // label-dimmed(=bluish-400) 占位符
  // 品牌
  brand: string = '#3964fe'       // brand-primary(蓝本钦定)
  brandHover: string = '#2c50d8'  // primary-hover(深一档)
  onBrand: string = '#ffffff'     // 主按钮文字
  // 边框两级(黑 alpha:5%/10%)
  border: string = '#0D000000'    // border-l1 极细分隔
  border2: string = '#1A000000'   // border-l2 常规边框(输入/卡)
  // 交互底(4%/8%)
  hover: string = '#0A000000'     // interactive-bg-hover
  active: string = '#14000000'    // interactive-bg-active
  // 状态
  success: string = '#16a34a'
  warn: string = '#dd8629'        // amber-600
  danger: string = '#ec1313'      // red-600
  successBg: string = '#e8f8ee'   // 成功提示底
  dangerBg: string = '#fdecec'    // 错误提示底
  warnBg: string = '#fdf3e3'      // 警告提示底
  brandBg: string = '#e8edfe'     // 品牌浅底(选中气泡/hover 条)
  // 业务
  userTurn: string = '#eef2ff'    // 用户气泡底(品牌 4% 近似→浅靛)
  running: string = '#3964fe'
  completed: string = '#16a34a'
  failed: string = '#ec1313'
  planning: string = '#a371f7'
  waiting: string = '#dd8629'
  cancelled: string = '#81858c'
}

export function lightVals(): ThemeVals {
  return new ThemeVals()
}

export function darkVals(): ThemeVals {
  const v = new ThemeVals()
  v.bg = '#101216'; v.l1 = '#16181d'; v.l2 = '#1e2126'
  v.text = '#f5f6f7'; v.text2 = '#a6aab1'; v.text3 = '#81858c'; v.dim = '#5a5e66'
  v.brand = '#3964fe'; v.brandHover = '#5a7ffe'; v.onBrand = '#ffffff'
  v.border = '#0FFFFFFF'  // 白 6%
  v.border2 = '#1FFFFFFF' // 白 12%
  v.hover = '#0FFFFFFF'; v.active = '#1FFFFFFF'
  v.success = '#4ade80'; v.warn = '#f5a623'; v.danger = '#f87171'
  v.successBg = '#12291a'; v.dangerBg = '#2d1416'; v.warnBg = '#2b2114'; v.brandBg = '#1a2340'
  v.userTurn = '#1c2433'
  v.running = '#5a7ffe'; v.completed = '#4ade80'; v.failed = '#f87171'
  v.planning = '#c084fc'; v.waiting = '#f5a623'; v.cancelled = '#81858c'
  return v
}

// ---------- 全局主题单例:页面一律 Th.c.xxx 读当前值 ----------
export class Th {
  static c: ThemeVals = lightVals()
  static isDark: boolean = false

  static setDark(on: boolean): void {
    Th.isDark = on
    Th.c = on ? darkVals() : lightVals()
    const rev = (AppStorage.get<number>('themeRev') ?? 0) + 1
    AppStorage.setOrCreate('themeRev', rev)
  }

  // 'light' | 'dark' | 'system' → 应用(浅色默认:非法值也落浅色)
  static apply(pref: string): void {
    AppStorage.setOrCreate('themePref', pref)
    if (pref === 'dark') {
      Th.setDark(true)
    } else if (pref === 'system') {
      // 跟随系统:读 EntryAbility.onConfigurationUpdate 写入的 colorMode 快照
      // ('systemDark' 缺省 false=浅色;深色跟随由 EntryAbility 兑现,HIG 适配项 2)
      const sysDark = AppStorage.get<boolean>('systemDark') ?? false
      Th.setDark(sysDark)
    } else {
      Th.setDark(false)
    }
  }

  /** EntryAbility.onConfigurationUpdate 调用:系统深色态变化 → 若当前偏好为
   * system 则即时重应用(真跟随);由 Ability 层持有偏好值,Theme 不读 store */
  static onSystemColorMode(sysDark: boolean): void {
    AppStorage.setOrCreate('systemDark', sysDark)
    if (AppStorage.get<string>('themePref') === 'system') {
      Th.setDark(sysDark)
    }
  }
}

// ---------- 尺寸:v3 布局不回退 + DSH 组件规范(蓝本 §3) ----------
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
  // ---- DSH 组件规范 ----
  static readonly btnH: number = 32        // 按钮高 32
  static readonly btnRadius: number = 18   // 胶囊圆角
  static readonly btnPadH: number = 14     // 按钮水平 padding
  static readonly inputH: number = 32      // 输入框高
  static readonly inputRadius: number = 8  // 输入圆角
  static readonly pillH: number = 24       // pill 高
  static readonly pillRadius: number = 12  // pill 圆角(全圆)
  static readonly menuRadius: number = 12  // 菜单/浮层圆角
  static readonly cardRadius: number = 12  // 卡片圆角
  static readonly listItemH: number = 36   // 会话列表项高
  static readonly listItemRadius: number = 8
  static readonly spinnerSize: number = 20 // spinner 2px 环
}

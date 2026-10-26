/**
 * v6.1 首启智能检测:探测结果归约(纯逻辑,与 ArkUI 零依赖)
 *
 * 探测输入(Bootstrap 阶段按序探测,全部为布尔/字符串事实,无副作用):
 *   - localStateOk:  GET http://127.0.0.1:7788/api/state 是否 200
 *   - hmhInstalled:  设备上 hmh 已安装(本应用无法直接 exec 探测文件系统——
 *                    由调用方约定:以"上次成功连过本地"或"向导装过"作为
 *                    installed 标志的持久化近似;纯逻辑只做归约)
 *   - hasConfig:     preferences 里已有 baseUrl 配置
 *
 * 归约输出(向导/横幅/直连三态):
 *   'local-share'  → 本机 hmh 在线,默认连本地共享(免 token)
 *   'local-guide'  → hmh 已装未起,给启动指引
 *   'wizard'       → 都无,进安装向导
 *   'keep'         → 已有配置,走既有自动重连路径(不打扰)
 */
export type ProbeOutcome = 'local-share' | 'local-guide' | 'wizard' | 'keep'

export interface ProbeInput {
  localStateOk: boolean
  hmhInstalled: boolean
  hasConfig: boolean
}

export function reduceProbe(p: ProbeInput): ProbeOutcome {
  // 已有配置:不覆盖用户选择(即使本地服务也起来了——用户可能有意连远程)
  if (p.hasConfig) return 'keep'
  if (p.localStateOk) return 'local-share'
  if (p.hmhInstalled) return 'local-guide'
  return 'wizard'
}

/** 横幅文案键(本地共享模式显示;远程模式不显示) */
export function bannerKey(outcome: ProbeOutcome): string | null {
  return outcome === 'local-share' ? 'wizard.bannerLocal' : null
}

/** 向导三选项的推荐默认序(①本机安装(推荐) ②远程 ③演示) */
export const WIZARD_OPTIONS = ['local-install', 'remote', 'demo'] as const
export type WizardChoice = (typeof WIZARD_OPTIONS)[number]

/** 向导持久化键值:选择一次后不再弹(preferences 'wizardDone') */
export function shouldShowWizard(wizardDone: boolean, hasConfig: boolean, outcome: ProbeOutcome): boolean {
  if (wizardDone || hasConfig) return false
  return outcome === 'wizard' || outcome === 'local-guide'
}

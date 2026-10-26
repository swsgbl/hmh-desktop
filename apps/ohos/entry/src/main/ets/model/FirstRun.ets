/**
 * v6.1 首启智能检测(ArkTS 同构,见 tests/first-run.ts)
 * 纯归约,无副作用;探测动作在 Bootstrap.ets。
 */
export type ProbeOutcome = 'local-share' | 'local-guide' | 'wizard' | 'keep'

export interface ProbeInput {
  localStateOk: boolean
  hmhInstalled: boolean
  hasConfig: boolean
}

export function reduceProbe(p: ProbeInput): ProbeOutcome {
  if (p.hasConfig) return 'keep'
  if (p.localStateOk) return 'local-share'
  if (p.hmhInstalled) return 'local-guide'
  return 'wizard'
}

export function bannerKey(outcome: ProbeOutcome): string | null {
  return outcome === 'local-share' ? 'wizard.bannerLocal' : null
}

export const WIZARD_OPTIONS: string[] = ['local-install', 'remote', 'demo']

export function shouldShowWizard(wizardDone: boolean, hasConfig: boolean, outcome: ProbeOutcome): boolean {
  if (wizardDone || hasConfig) return false
  return outcome === 'wizard' || outcome === 'local-guide'
}

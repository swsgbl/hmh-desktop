import { UIAbility, AbilityConstant, Want, Configuration, ConfigurationConstant } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { AppStore } from '../model/AppStore'
import { bootstrapAfterPrefs } from '../model/Bootstrap'
import { Th } from '../theme/Theme'

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    console.info('HMH Desktop EntryAbility onCreate')
    const store = AppStore.get()
    store.initPrefs(this.context).then(() => {
      // E2E/debug 通道:aa start --ps hmhUrl <url> --ps hmhToken <token> 直达配置(仅 LAN 调试用)
      const p = want.parameters as Record<string, Object>
      const u = p !== undefined && typeof p['hmhUrl'] === 'string' ? p['hmhUrl'] as string : ''
      const t = p !== undefined && typeof p['hmhToken'] === 'string' ? p['hmhToken'] as string : ''
      if (u !== '' || t !== '') {
        const baseUrl = u !== '' ? u : store.baseUrl
        const token = t !== '' ? t : store.token
        store.saveConfig(baseUrl, token).then(() => {
          console.info('config applied from want parameters')
        })
      }
      console.info('AppStore prefs ready')
      // P0.2: launch auto-reconnect (health check + global SSE) when configured
      bootstrapAfterPrefs()
    }).catch((e: object) => {
      console.error('AppStore initPrefs error: ' + JSON.stringify(e))
    })
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    const p = want.parameters as Record<string, Object>
    const u = p !== undefined && typeof p['hmhUrl'] === 'string' ? p['hmhUrl'] as string : ''
    const t = p !== undefined && typeof p['hmhToken'] === 'string' ? p['hmhToken'] as string : ''
    if (u !== '' || t !== '') {
      const store = AppStore.get()
      const baseUrl = u !== '' ? u : store.baseUrl
      const token = t !== '' ? t : store.token
      store.saveConfig(baseUrl, token).then(() => {
        console.info('config re-applied from want parameters')
        bootstrapAfterPrefs()
      })
    }
  }

  onDestroy(): void {
    console.info('HMH Desktop EntryAbility onDestroy')
    AppStore.get().stopSse()
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    console.info('HMH Desktop EntryAbility onWindowStageCreate')
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`Failed to load UI content: ${err.message}`)
        return
      }
      console.info('UI content loaded successfully')
    })
  }

  /** HIG 适配项2:系统深色模式变化 → Th.onSystemColorMode(仅 system 偏好下生效)。
   * 历史差距(Theme.ets:79-86 借口注释)随本回调兑现修复。 */
  onConfigurationUpdate(newConfig: Configuration): void {
    const cm = newConfig.colorMode
    console.info('HMH EntryAbility onConfigurationUpdate colorMode=' + JSON.stringify(cm))
    Th.onSystemColorMode(cm === ConfigurationConstant.ColorMode.COLOR_MODE_DARK)
  }

  onWindowStageDestroy(): void {
    console.info('HMH Desktop EntryAbility onWindowStageDestroy')
  }

  onForeground(): void {
    console.info('HMH Desktop EntryAbility onForeground')
  }

  onBackground(): void {
    console.info('HMH Desktop EntryAbility onBackground')
  }
}

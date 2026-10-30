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
    // HIG 项2 冷启动兜底:系统已处深色而偏好为 system 时,初始化即跟随
    // (onConfigurationUpdate 只覆盖运行中的系统切换,不覆盖冷启动初始态)
    const cfg = this.context.config
    if (cfg !== undefined) {
      Th.onSystemColorMode(cfg.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK)
    }
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`Failed to load UI content: ${err.message}`)
        return
      }
      console.info('UI content loaded successfully')
      // 2026-10-30 交互事故修复:自由浮动窗模式下窗口装饰(开/关)由窗口管理器
      // 处理可用,但内容收不到真实鼠标事件(uitest 触摸注入正常=事件分发路径
      // 不同)。最大化走桌面标准输入处理路径(API23 Window 无 focus())。
      try {
        windowStage.getMainWindowSync().maximize().catch((e: object) => console.warn('maximize skipped: ' + JSON.stringify(e)))
      } catch (e) {
        console.warn('window input fix skipped: ' + JSON.stringify(e))
      }
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

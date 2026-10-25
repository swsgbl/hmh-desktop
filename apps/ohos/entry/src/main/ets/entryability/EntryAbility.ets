import { UIAbility, AbilityConstant, Want } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { AppStore } from '../model/AppStore'

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    console.info('HMH Desktop EntryAbility onCreate')
    AppStore.get().initPrefs(this.context).then(() => {
      console.info('AppStore prefs ready')
    }).catch((e: object) => {
      console.error('AppStore initPrefs error: ' + JSON.stringify(e))
    })
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

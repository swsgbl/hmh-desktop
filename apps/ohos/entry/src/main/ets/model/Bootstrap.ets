// P0.2 auto-reconnect on launch + v6.1 首启智能检测:
//   1) 已有配置 → 健康检查+指数退避自动重连(原 P0.2 路径,keep)
//   2) 无配置 → 探测本机 hmh web(127.0.0.1:7788):
//        通  → 默认连本地共享(免 token,LAN 模式 same-machine 免鉴权)+横幅
//        不通→ 向导(local-guide 给启动指引 / wizard 安装向导)
// 探测结果经 AppStorage('firstRunOutcome') 广播给 Index(Wizard/横幅)。
import { AppStore } from '../model/AppStore'
import { ApiClient } from '../net/ApiClient'
import { reduceProbe, ProbeOutcome } from '../model/FirstRun'

const BOOTSTRAP_MAX_TRIES = 10

/** 无 token 直探本机 web(LAN 模式 loopback 免鉴权;任何非 200 视为不在线) */
function probeLocalWeb(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const api = new ApiClient('http://127.0.0.1:7788', '')
    api.getJson<Object>('/api/state').then(() => resolve(true)).catch(() => resolve(false))
  })
}

export function bootstrapAfterPrefs(): void {
  const store = AppStore.get()
  if (store.baseUrl === '') {
    // v6.1: 首启智能检测(无配置才探测;有配置走 keep 路径不打扰)
    firstRunProbe()
    return
  }
  let tries = 0
  const attempt = (): void => {
    tries++
    store.api().getJson<Object>('/api/state').then((_st: Object) => {
      console.info(`bootstrap: runtime reachable (try ${tries}), starting global SSE`)
      store.startSse('')
    }).catch((e: object) => {
      if (tries >= BOOTSTRAP_MAX_TRIES) {
        console.info('bootstrap: giving up after ' + tries + ' tries: ' + JSON.stringify(e).slice(0, 100))
        return
      }
      const delayMs = Math.min(2000 * tries, 30000)
      console.info(`bootstrap: unreachable (try ${tries}), retry in ${delayMs}ms`)
      setTimeout(attempt, delayMs)
    })
  }
  attempt()
}

/** v6.1 首启探测:本机 web 在线→默认连本地;否则向导。 */
function firstRunProbe(): void {
  const store = AppStore.get()
  probeLocalWeb().then((okLocal: boolean) => {
    const outcome: ProbeOutcome = reduceProbe({
      localStateOk: okLocal,
      // 应用沙箱无法直接探测 /data/local/home/.local/hmharness 是否存在;
      // 以持久化近似:wizardDone 之前装过(用户选过向导)或曾连本地成功过。
      hmhInstalled: store.localKernelSeen,
      hasConfig: store.baseUrl !== ''
    })
    console.info('v6.1 first-run probe: outcome=' + outcome + ' local=' + okLocal)
    AppStorage.setOrCreate('firstRunOutcome', outcome)
    AppStorage.setOrCreate('firstRunRev', (AppStorage.get<number>('firstRunRev') ?? 0) + 1)
    if (outcome === 'local-share') {
      // 默认连本地共享(免 token;横幅由 Index 渲染)
      store.saveConfig('http://127.0.0.1:7788', '').then(() => {
        store.markLocalKernelSeen()
        store.startSse('')
      })
    }
    // 'local-guide' / 'wizard' → Index 监听 firstRunRev 弹向导
  })
}

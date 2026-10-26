// P0.2 auto-reconnect on launch: EntryAbility starts SSE + health check when config exists.
// This is the ArkTS-side companion of deploy.mjs. No token logging.
// v3 棒3:冷启动竞态根修——VM 网络就绪常晚于 app 启动,首次健康检查失败后
// 一次性放弃会导致 SSE 永不建立(DIAG sse=down / Overview 全"无数据"的根因
// 之一)。改为带上限的指数退避重试(2s/4s/8s...最长 30s,最多 10 次),
// 成功后立即 startSse('');重试期间不阻塞 UI。
import { AppStore } from '../model/AppStore'

const BOOTSTRAP_MAX_TRIES = 10

export function bootstrapAfterPrefs(): void {
  const store = AppStore.get()
  if (store.baseUrl === '') {
    console.info('bootstrap: no baseUrl configured, skip auto-connect')
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

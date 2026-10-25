// P0.2 auto-reconnect on launch: EntryAbility starts SSE + health check when config exists.
// This is the ArkTS-side companion of deploy.mjs. No token logging.
import { AppStore } from '../model/AppStore'

export function bootstrapAfterPrefs(): void {
  const store = AppStore.get()
  if (store.baseUrl === '') {
    console.info('bootstrap: no baseUrl configured, skip auto-connect')
    return
  }
  // health check then subscribe global SSE (sessionId='' passes all events; chat pages filter)
  store.api().getJson<Object>('/api/state').then((_st: Object) => {
    console.info('bootstrap: runtime reachable, starting global SSE')
    store.startSse('')
  }).catch((e: object) => {
    console.info('bootstrap: runtime unreachable, will not auto-connect: ' + JSON.stringify(e).slice(0, 100))
  })
}

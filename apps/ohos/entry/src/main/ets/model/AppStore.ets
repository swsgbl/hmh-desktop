/**
 * 全局单例中枢:配置(preferences 持久化)+ ApiClient/SseClient 生命周期 + 事件分发
 * 页面通过 AppUtil 订阅回调刷新(AppStorage 驱动 @State)
 */
import { preferences } from '@kit.ArkData'
import { Context } from '@kit.AbilityKit'
import { ApiClient } from '../net/ApiClient'
import { SseClient, SseFrame } from '../net/SseClient'
import { toRunEvent, reduce } from '../core/Reducer'
import { ChatState, newChatState, StateObj, RawEvent } from '../model/Types'
import { guardState } from '../model/Guards'
import { normalizeBaseUrl } from '../model/UrlNorm'

export interface StoreListener {
  onChatState: (st: ChatState) => void
  onServerState: (st: StateObj | null) => void
  onSseStatus: (connected: boolean, msg: string) => void
}

const PREF_FILE = 'hmh_store'
const KEY_BASE = 'baseUrl'
const KEY_TOKEN = 'token'
const KEY_LOCALE = 'locale'
const KEY_PINNED = 'pinned'
const KEY_COLLAPSED = 'collapsedGroups'

export class AppStore {
  private static instance: AppStore | null = null

  baseUrl: string = ''
  token: string = ''
  locale: string = 'zh'
  theme: string = 'system'
  pinned: Set<string> = new Set<string>()
  collapsedGroups: Set<string> = new Set<string>()
  chat: ChatState = newChatState('')
  serverState: StateObj | null = null
  sseConnected: boolean = false
  sseMessage: string = ''
  private prefs: preferences.Preferences | null = null
  private sse: SseClient | null = null
  private listener: StoreListener | null = null
  private seq: number = 0

  static get(): AppStore {
    if (AppStore.instance === null) {
      AppStore.instance = new AppStore()
    }
    return AppStore.instance
  }

  setListener(l: StoreListener | null): void {
    this.listener = l
  }

  async initPrefs(context: Context): Promise<void> {
    this.prefs = await preferences.getPreferences(context, PREF_FILE)
    this.baseUrl = await this.prefs.get(KEY_BASE, '') as string
    this.token = await this.prefs.get(KEY_TOKEN, '') as string
    this.locale = await this.prefs.get(KEY_LOCALE, 'zh') as string
    this.theme = await this.prefs.get('theme', 'system') as string
    this.pinned = this.parseSet(await this.prefs.get(KEY_PINNED, '[]') as string)
    this.collapsedGroups = this.parseSet(await this.prefs.get(KEY_COLLAPSED, '[]') as string)
  }

  private parseSet(raw: string): Set<string> {
    try {
      const arr = JSON.parse(raw) as string[]
      return new Set<string>(arr)
    } catch (e) {
      return new Set<string>()
    }
  }

  private async persistSet(key: string, s: Set<string>): Promise<void> {
    if (this.prefs !== null) {
      await this.prefs.put(key, JSON.stringify(Array.from(s)))
      await this.prefs.flush()
    }
  }

  async savePinned(s: Set<string>): Promise<void> {
    this.pinned = s
    await this.persistSet(KEY_PINNED, s)
  }

  async saveCollapsed(s: Set<string>): Promise<void> {
    this.collapsedGroups = s
    await this.persistSet(KEY_COLLAPSED, s)
  }

  async saveLocale(l: string): Promise<void> {
    this.locale = l
    if (this.prefs !== null) {
      await this.prefs.put(KEY_LOCALE, l)
      await this.prefs.flush()
    }
    AppStorage.setOrCreate('localeRev', (AppStorage.get<number>('localeRev') ?? 0) + 1)
  }

  async saveTheme(th: string): Promise<void> {
    this.theme = th
    if (this.prefs !== null) {
      await this.prefs.put('theme', th)
      await this.prefs.flush()
    }
    AppStorage.setOrCreate('themeRev', (AppStorage.get<number>('themeRev') ?? 0) + 1)
  }

  async saveConfig(baseUrl: string, token: string): Promise<void> {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.token = token.trim()
    if (this.prefs !== null) {
      await this.prefs.put(KEY_BASE, this.baseUrl)
      await this.prefs.put(KEY_TOKEN, this.token)
      await this.prefs.flush()
    }
  }

  api(): ApiClient {
    return new ApiClient(this.baseUrl, this.token)
  }

  /** SSE 订阅(幂等:先关旧再开新) */
  startSse(sessionId: string): void {
    this.stopSse()
    this.chat = newChatState(sessionId)
    if (this.baseUrl === '') {
      this.notifySse(false, '未配置服务器')
      return
    }
    const sse = new SseClient(this.baseUrl + '/api/events', this.token, {
      onFrame: (f: SseFrame) => {
        this.seq++
        let data: Record<string, Object> = {}
        try {
          data = JSON.parse(f.data) as Record<string, Object>
        } catch (e) {
          return
        }
        const raw: RawEvent = { id: f.id, event: f.event, data: data }
        const ev = toRunEvent(raw, sessionId, this.seq)
        if (ev !== null) {
          if (ev.kind === 'state') {
            this.serverState = guardState(data)
            if (this.serverState !== null) {
              AppStorage.setOrCreate('serverStateJson', JSON.stringify(this.serverState))
              this.notifyServer()
            }
          }
          this.chat = reduce(this.chat, ev)
          this.notifyChat()
        }
      },
      onError: (msg: string) => {
        this.notifySse(false, msg)
      },
      onOpen: () => {
        this.notifySse(true, '')
      }
    })
    this.sse = sse
    sse.start()
  }

  stopSse(): void {
    if (this.sse !== null) {
      this.sse.close()
      this.sse = null
    }
  }

  private notifyChat(): void {
    const rev = AppStorage.get<number>('chatRev') ?? 0
    AppStorage.setOrCreate('chatRev', rev + 1)
    if (this.listener !== null) {
      this.listener.onChatState(this.chat)
    }
  }

  private notifyServer(): void {
    if (this.listener !== null) {
      this.listener.onServerState(this.serverState)
    }
  }

  private notifySse(connected: boolean, msg: string): void {
    this.sseConnected = connected
    this.sseMessage = msg
    AppStorage.setOrCreate('sseConnected', connected)
    if (this.listener !== null) {
      this.listener.onSseStatus(connected, msg)
    }
  }
}

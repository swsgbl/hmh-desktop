/**
 * 鍏ㄥ眬鍗曚緥涓灑:閰嶇疆(preferences 鎸佷箙鍖?+ ApiClient/SseClient 鐢熷懡鍛ㄦ湡 + 浜嬩欢鍒嗗彂
 * 椤甸潰閫氳繃 AppUtil 璁㈤槄鍥炶皟鍒锋柊(AppStorage 椹卞姩 @State)
 * #19:approval.required 鈫?notificationManager 鏈湴閫氱煡(鐐瑰嚮鎷夎捣浼氳瘽椤?
 */
import { preferences } from '@kit.ArkData'
import { Th } from '../theme/Theme'
import { Context, Want, wantAgent } from '@kit.AbilityKit'
import { ApiClient } from '../net/ApiClient'
import { SseClient, SseFrame } from '../net/SseClient'
import { toRunEvent, reduce } from '../core/Reducer'
import { ChatState, newChatState, StateObj, RawEvent } from '../model/Types'
import { guardState } from '../model/Guards'
import { normalizeBaseUrl } from '../model/UrlNorm'
import { notifyIdFor, shouldNotify } from '../model/Notify'
import { notificationManager } from '@kit.NotificationKit'

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
  private listeners: StoreListener[] = []
  private seq: number = 0
  private lastNotify: Map<number, number> = new Map<number, number>()

  static get(): AppStore {
    if (AppStore.instance === null) {
      AppStore.instance = new AppStore()
    }
    return AppStore.instance
  }

  setListener(l: StoreListener): void {
    const i = this.listeners.indexOf(l)
    if (i < 0) {
      this.listeners.push(l)
    }
  }

  removeListener(l: StoreListener): void {
    const i = this.listeners.indexOf(l)
    if (i >= 0) {
      this.listeners.splice(i, 1)
    }
  }

  async initPrefs(context: Context): Promise<void> {
    this.prefs = await preferences.getPreferences(context, PREF_FILE)
    this.baseUrl = await this.prefs.get(KEY_BASE, '') as string
    this.token = await this.prefs.get(KEY_TOKEN, '') as string
    this.locale = await this.prefs.get(KEY_LOCALE, 'zh') as string
    this.theme = await this.prefs.get('theme', 'system') as string
    Th.apply(this.theme)
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
    Th.apply(th)
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

  /** SSE 璁㈤槄(骞傜瓑:鍏堝叧鏃у啀寮€鏂? */
  startSse(sessionId: string): void {
    this.stopSse()
    this.chat = newChatState(sessionId)
    if (this.baseUrl === '') {
      this.notifySse(false, '鏈厤缃湇鍔″櫒')
      return
    }
    const sse = new SseClient(this.baseUrl + '/api/events', this.token, {
      onFrame: (f: SseFrame) => {
        this.seq++
        let data: Record<string, Object> = {}
        try {
          data = JSON.parse(f.data) as Record<string, Object>
        } catch (e) {
          console.info('hmh diag: parse fail ev=' + f.event + ' len=' + f.data.length + ' :' + JSON.stringify(e).slice(0, 120))
          return
        }
        const raw: RawEvent = { id: f.id, event: f.event, data: data }
        const ev = toRunEvent(raw, sessionId, this.seq)
        if (ev !== null) {
          if (ev.kind === 'state') {
            this.serverState = guardState(data)
            console.info('hmh state frame: guarded=' + (this.serverState !== null ? 'ok ver=' + this.serverState.daemonVersion : 'NULL') + ' ev=' + f.event)
            if (this.serverState !== null) {
              this.notifyServer()
            }
          }
          this.chat = reduce(this.chat, ev)
          this.notifyChat()
          // #19 瀹℃壒閫氱煡(鍘婚噸绐楀彛鍐呭彧鍙戜竴娆?
          if (ev.kind === 'approval.required') {
            this.publishApprovalNotify(ev.name)
          }
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

  /** v3 棒3:页面拉到的 /api/state 也归仓+广播(与 SSE state 帧同一条路,
   * 让总览/会话列表/顶栏全部即时吃到同一份状态) */
  adoptServerState(s: StateObj): void {
    this.serverState = s
    this.notifyServer()
  }

  private notifyChat(): void {
    const rev = AppStorage.get<number>('chatRev') ?? 0
    AppStorage.setOrCreate('chatRev', rev + 1)
    for (const l of this.listeners) {
      l.onChatState(this.chat)
    }
  }

  private notifyServer(): void {
    const rev = AppStorage.get<number>('serverRev') ?? 0
    AppStorage.setOrCreate('serverRev', rev + 1)
    for (const l of this.listeners) {
      l.onServerState(this.serverState)
    }
  }

  private notifySse(connected: boolean, msg: string): void {
    this.sseConnected = connected
    this.sseMessage = msg
    AppStorage.setOrCreate('sseConnected', connected)
    for (const l of this.listeners) {
      l.onSseStatus(connected, msg)
    }
  }

  /** #19 鍙戝竷瀹℃壒閫氱煡(鐐瑰嚮鎷夎捣 EntryAbility 鈫?Index 璺敱鍒颁細璇?Tab) */
  private publishApprovalNotify(toolName: string): void {
    const id = notifyIdFor(toolName)
    const decision = shouldNotify(id, Date.now(), this.lastNotify)
    if (!decision.shouldPublish) {
      return
    }
    try {
      const want: Want = {
        bundleName: 'com.hmh.desktop.ohos',
        abilityName: 'EntryAbility'
      }
      const agent = wantAgent.getWantAgent({
        wants: [want],
        operationType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0
      } as wantAgent.WantAgentInfo)
      const req: notificationManager.NotificationRequest = {
        id: id,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: 'HMH 瀹℃壒璇锋眰',
            text: `宸ュ叿 ${toolName === '' ? '(unnamed)' : toolName} 绛夊緟鎵瑰噯`,
            additionalText: '点击打开会话页处理'
          } as notificationManager.NotificationBasicContent
        } as notificationManager.NotificationContent,
        notificationSlotType: notificationManager.SlotType.SOCIAL_COMMUNICATION,
        wantAgent: agent
      } as notificationManager.NotificationRequest
      notificationManager.publish(req).catch((_err: object) => {
        // 通知失败不影响业务流(未授权/无slot时静默)
      })
    } catch (e) {
      // 容错:notificationManager 不可用时不阻塞SSE流
    }
  }
}

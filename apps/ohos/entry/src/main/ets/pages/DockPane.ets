/**
 * v3 右栏 Dock(360px,1:1 复刻 .dock):六页签(总览/文件/变更/证据/日志/远程)
 * 页签内容复用 v2 页面(Overview/Files/Logs 迁移为 @Builder 组件渲染)
 */
import { hilog } from '@kit.PerformanceAnalysisKit'
import { AppStore, StoreListener } from '../model/AppStore'
import { t } from '../model/I18n'
import { Theme } from '../theme/Theme'
import { StateObj } from '../model/Types'
import { guardState } from '../model/Guards'

@Component
export struct DockPane {
  @State tab: number = 0
  @State locale: string = 'zh'
  @State st: StateObj | null = null
  @State logs: string[] = []
  @State sseOn: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('chatRev') chatRev: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  @StorageProp('serverRev') @Watch('onServerRev') serverRev: number = 0
  private store: AppStore = AppStore.get()
  private storeL: StoreListener | null = null

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.logs = AppStore.get().chat.logs
    this.st = AppStore.get().serverState
    this.sseOn = AppStore.get().sseConnected
    this.refreshState()
    setTimeout(() => { this.refreshState() }, 1500)
    this.storeL = {
      onChatState: (st2: import('../model/Types').ChatState) => {
        this.logs = st2.logs
      },
      onServerState: (s: StateObj | null) => {
        this.st = s
      },
      onSseStatus: (c: boolean, _m: string) => {
        this.sseOn = c
      }
      }
    if (this.storeL !== null) {
      AppStore.get().setListener(this.storeL)
    }
  }

  aboutToDisappear(): void {
    if (this.storeL !== null) {
      AppStore.get().removeListener(this.storeL)
    }
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  /** serverRev 变化(hello/state 帧/refreshState 归仓)时重读 store.serverState,
   * 兜住 listener 注册晚于 hello 单发帧的竞态(v3 棒2 st=NULL 的另一半根因) */
  onServerRev(): void {
    const s = AppStore.get().serverState
    if (s !== null) {
      this.st = s
    }
  }

  private async refreshState(): Promise<void> {
    try {
      const resp = await this.store.api().getJson<Object>('/api/state')
      // 与 SSE hello/state 帧同构:统一走 guardState(v3 棒2 "无数据"根修:
      // 旧手搓映射漏 busySessions/queue(string[]→count)/activeSessionId 等)
      const guarded = guardState(resp as Object)
      if (guarded !== null) {
        this.st = guarded
        this.store.adoptServerState(guarded)
      }
    } catch (e) {
      // Bootstrap token 就绪竞态: 3s 后重试一次
      hilog.info(0xD002200, 'hmh', 'refreshState failed: %{public}s', (e as Error).message)
      setTimeout(() => { this.refreshState() }, 3000)
    }
  }

  build() {
    Column({ space: 0 }) {
      // dock-tabs
      Scroll() {
        Row({ space: 4 }) {
          ForEach(this.tabNames(), (name: string, idx: number) => {
            Text(name)
              .fontSize(13)
              .fontColor(this.tab === idx ? Theme.text : Theme.dim)
              .backgroundColor(this.tab === idx ? Theme.panel : Theme.raised)
              .padding({ left: 10, right: 10, top: 6, bottom: 6 })
              .borderRadius(6)
              .onClick(() => {
                this.tab = idx
              })
          }, (name: string, idx: number) => name)
        }
        .padding(8)
      }
      .scrollable(ScrollDirection.Horizontal)
      .width('100%')
      .backgroundColor(Theme.raised)
      .border({ width: 1, color: Theme.border })

      // dock-body
      Scroll() {
        Column({ space: 8 }) {
          if (this.tab === 0) {
            this.overviewBody()
          } else if (this.tab === 1) {
            Text(this.L('dock.files'))
              .fontSize(13)
              .fontColor(Theme.dim)
            Text('(v3:文件页签对接中——见 RESUME)')
              .fontSize(11)
              .fontColor(Theme.dim)
          } else if (this.tab === 2) {
            Text(this.locale === 'en' ? 'git changes' : this.L('dock.gitChanges'))
              .fontSize(13)
              .fontColor(Theme.dim)
            Text(this.L('dock.notGit') + ' / ' + this.L('dock.noChanges'))
              .fontSize(11)
              .fontColor(Theme.dim)
          } else if (this.tab === 3) {
            Text(this.L('dock.evidence') === 'Evidence' ? 'Evidence' : '证据')
              .fontSize(13)
              .fontColor(Theme.dim)
            Text(this.L('dock.noData'))
              .fontSize(11)
              .fontColor(Theme.dim)
          } else if (this.tab === 4) {
            this.logsBody()
          } else {
            Text(this.L('dock.overview'))
              .fontSize(13)
              .fontColor(Theme.dim)
          }
        }
        .padding(12)
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width(360)
    .height('100%')
    .backgroundColor(Theme.raised)
    .alignItems(HorizontalAlign.Start)
  }

  private tabNames(): string[] {
    if (this.locale === 'en') {
      return ['Overview', 'Files', 'Diff', 'Evidence', 'Logs', 'Remote']
    }
    return ['总览', '文件', '变更', '证据', '日志', '远程']
  }

  @Builder
  overviewBody() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(this.L('dock.overview'))
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button(this.locale === 'en' ? 'Refresh' : '刷新')
          .fontSize(12)
          .height(28)
          .backgroundColor(Theme.panel)
          .fontColor(Theme.text)
          .onClick(() => this.refreshState())
      }
      .width('100%')
      // v3 棒3:直读 store(由 serverRev/sseConnected @StorageProp 驱动重渲染),
      // 不再走 this.st 陈旧快照——根治 v2 棒3 同款"组件构造时快照不更新"bug
      if (this.serverRev >= 0) {
        this.diagRows()
      }
      Text(this.L('dock.overviewNote'))
        .fontSize(11)
        .fontColor(Theme.dim)
        .margin({ top: 8 })
    }
    .width('100%')
  }

  @Builder
  diagRows() {
    Column({ space: 6 }) {
      this.kv('DIAG st', this.st !== null ? 'nonnull v' + this.st.daemonVersion : 'NULL')
      this.kv('DIAG sse', this.sseOn ? 'conn' : 'down')
      this.kv('DIAG rev', `srv=${this.serverRev} chat=${this.chatRev}`)
      this.kv(this.L('dock.rtVer'), this.st !== null && this.st.daemonVersion !== '' ? this.st.daemonVersion : this.L('dock.noData'))
      this.kv(this.L('dock.mode'), this.st !== null ? this.st.exposure : '')
      this.kv(this.L('top.model'), this.st !== null ? this.st.model : '')
      this.kv('provider', this.st !== null ? this.st.chatProvider : '')
      this.kv(this.L('dock.sessCount'), this.st !== null ? `${this.st.busySessions.length} 运行 / 阶列 ${this.st.queue}` : '')
      this.kv(this.L('dock.runState'), this.st !== null ? (this.st.busy ? this.L('status.running') : this.L('status.idle')) : '')
      this.kv(this.L('dock.ws'), this.st !== null && this.st.workspace !== null ? this.st.workspace.name : this.L('dock.none'))
    }
    .width('100%')
  }

  @Builder
  logsBody() {
    Column({ space: 2 }) {
      Text(this.L('dock.logsHead'))
        .fontSize(12)
        .fontColor(Theme.dim)
        .width('100%')
      if (this.logs.length === 0) {
        Text(this.L('dock.logsEmpty'))
          .fontSize(11)
          .fontColor(Theme.dim)
          .padding({ top: 12 })
      } else {
        ForEach(this.logs, (line: string, idx: number) => {
          Text(line)
            .fontSize(11)
            .fontColor(Theme.dim)
            .fontFamily('monospace')
            .width('100%')
            .padding({ left: 4, right: 4, top: 2, bottom: 2 })
        }, (line: string, idx: number) => `${idx}`)
      }
    }
    .width('100%')
  }

  @Builder
  kv(k: string, v: string) {
    Row({ space: 8 }) {
      Text(k)
        .fontSize(12)
        .fontColor(Theme.dim)
        .width(96)
      Text(v)
        .fontSize(12)
        .fontColor(Theme.text)
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .padding(6)
    .width('100%')
  }
}

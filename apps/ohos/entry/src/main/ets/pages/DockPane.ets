/**
 * v3 右栏 Dock(360px,1:1 复刻 .dock):六页签(总览/文件/变更/证据/日志/远程)
 * 页签内容复用 v2 页面(Overview/Files/Logs 迁移为 @Builder 组件渲染)
 */
import { AppStore } from '../model/AppStore'
import { t } from '../model/I18n'
import { Theme } from '../theme/Theme'
import { StateObj } from '../model/Types'

@Component
export struct DockPane {
  @State tab: number = 0
  @State locale: string = 'zh'
  @State st: StateObj | null = null
  @State logs: string[] = []
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('chatRev') chatRev: number = 0
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.logs = AppStore.get().chat.logs
    this.refreshState()
    AppStore.get().setListener({
      onChatState: (st2: import('../model/Types').ChatState) => {
        this.logs = st2.logs
      },
      onServerState: (s: StateObj | null) => {
        this.st = s
      },
      onSseStatus: (_c: boolean, _m: string) => {
      }
    })
  }

  aboutToDisappear(): void {
    AppStore.get().setListener(null)
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  private async refreshState(): Promise<void> {
    try {
      const resp = await this.store.api().getJson<Object>('/api/state')
      const o = resp as Record<string, Object>
      const model = typeof o['model'] === 'string' ? o['model'] as string : ''
      const chatProvider = typeof o['chatProvider'] === 'string' ? o['chatProvider'] as string : ''
      const home = typeof o['home'] === 'string' ? o['home'] as string : ''
      const busy = o['busy'] === true
      const exposure = typeof o['exposure'] === 'string' ? o['exposure'] as string : ''
      const daemonVersion = typeof o['daemonVersion'] === 'string' ? o['daemonVersion'] as string : ''
      const queueN = typeof o['queue'] === 'number' ? o['queue'] as number : 0
      const wsRaw: Object | undefined = o['workspace']
      let wsName = ''
      let wsPath = ''
      if (wsRaw !== undefined && typeof wsRaw === 'object') {
        const w = wsRaw as Record<string, Object>
        wsName = typeof w['name'] === 'string' ? w['name'] as string : ''
        wsPath = typeof w['path'] === 'string' ? w['path'] as string : ''
      }
      this.st = {
        model: model, chatProvider: chatProvider, home: home, locale: '', busy: busy,
        busySessions: [], approvalPending: false, queue: queueN, activeSessionId: '',
        activeThreadCwd: '', exposure: exposure, workspace: wsName !== '' ? { id: '', name: wsName, path: wsPath } as import('../model/Types').WorkspaceInfo : null,
        daemonVersion: daemonVersion
      } as StateObj
    } catch (e) {
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
      this.kv(this.L('dock.rtVer'), this.st !== null && this.st.daemonVersion !== '' ? this.st.daemonVersion : this.L('dock.noData'))
      this.kv(this.L('dock.mode'), this.st !== null ? this.st.exposure : '')
      this.kv(this.L('top.model'), this.st !== null ? this.st.model : '')
      this.kv('provider', this.st !== null ? this.st.chatProvider : '')
      this.kv(this.L('dock.sessCount'), this.st !== null ? `${this.st.busySessions.length} 运行 / 队列 ${this.st.queue}` : '')
      this.kv(this.L('dock.runState'), this.st !== null ? (this.st.busy ? this.L('status.running') : this.L('status.idle')) : '')
      this.kv(this.L('dock.ws'), this.st !== null && this.st.workspace !== null ? this.st.workspace.name : this.L('dock.none'))
      Text(this.L('dock.overviewNote'))
        .fontSize(11)
        .fontColor(Theme.dim)
        .margin({ top: 8 })
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

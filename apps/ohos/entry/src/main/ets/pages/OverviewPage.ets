/**
 * v2 总览页:runtime/host 状态卡(接 /api/state + SSE state 事件)
 * 蓝本:desktop dock 总览——daemon 版本/模式/会话数/运行状态/provider
 */
import { Th } from '../theme/Theme'
import { AppStore } from '../model/AppStore'
import { StateObj } from '../model/Types'
import { t } from '../model/I18n'
import { MotionSpinner } from '../components/MotionSpinner'

@Component
export struct OverviewPage {
  @State st: StateObj | null = null
  @State errMsg: string = ''
  @State locale: string = 'zh'
  @StorageProp('localeRev') localeRev: number = 0
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.refresh()
    AppStore.get().setListener({
      onChatState: (_st2: import('../model/Types').ChatState) => {
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

  build() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Text(this.L('dock.overview'))
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button(this.locale === 'en' ? 'Refresh' : '刷新')
          .fontSize(13)
          .height(32)
          .onClick(() => this.refresh())
      }
      .width('100%')

      if (this.errMsg !== '') {
        Text(this.errMsg).fontSize(12).fontColor(Th.c.danger)
      }
      if (this.st === null) {
        if (this.errMsg === '') {
          MotionSpinner({ side: 24 })
        }
      } else {
        Scroll() {
          Column({ space: 10 }) {
            this.kvRow(this.L('dock.rtVer'), this.st.daemonVersion !== '' ? this.st.daemonVersion : this.L('dock.noData'))
            this.kvRow(this.L('dock.mode'), this.st.exposure)
            this.kvRow(this.L('top.model'), this.st.model)
            this.kvRow('chat provider', this.st.chatProvider)
            this.kvRow(this.L('dock.sessCount'), `${this.st.busySessions.length} 运行 / 队列 ${this.st.queue}`)
            this.kvRow(this.L('dock.runState'), this.st.busy ? this.L('status.running') : this.L('status.idle'))
            this.kvRow(this.L('dock.hostState'), this.st.home !== '' ? this.st.home : this.L('dock.none'))
            if (this.st.workspace !== null) {
              this.kvRow(this.L('dock.ws'), this.st.workspace.name + ' · ' + this.st.workspace.path)
            }
            Text(this.L('dock.overviewNote'))
              .fontSize(10)
              .fontColor(Th.c.text3)
              .width('100%')
              .padding({ top: 6 })
          }
          .width('100%')
        }
        .layoutWeight(1)
        .width('100%')
      }
    }
    .padding(14)
    .width('100%')
    .height('100%')
  }

  @Builder
  kvRow(k: string, v: string) {
    Row({ space: 8 }) {
      Text(k)
        .fontSize(12)
        .fontColor(Th.c.text3)
        .width(110)
      Text(v)
        .fontSize(13)
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .padding(10)
    .backgroundColor(Th.c.l1)
    .borderRadius(8)
    .width('100%')
  }

  private async refresh(): Promise<void> {
    this.errMsg = ''
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
      const busyArr = typeof o['busySessions'] === 'object' && o['busySessions'] !== null ? (o['busySessions'] as Object as Array<Object>).length : 0
      const wsRaw: Object | undefined = o['workspace']
      let wsName = ''
      let wsPath = ''
      if (wsRaw !== undefined && typeof wsRaw === 'object') {
        const w = wsRaw as Record<string, Object>
        wsName = typeof w['name'] === 'string' ? w['name'] as string : ''
        wsPath = typeof w['path'] === 'string' ? w['path'] as string : ''
      }
      const st: StateObj = {
        model: model, chatProvider: chatProvider, home: home, locale: '', busy: busy,
        busySessions: [], approvalPending: false, queue: queueN, activeSessionId: '',
        activeThreadCwd: '', exposure: exposure, workspace: wsName !== '' ? { id: '', name: wsName, path: wsPath } as import('../model/Types').WorkspaceInfo : null,
        daemonVersion: daemonVersion
      } as StateObj
      this.st = st
    } catch (e) {
      const err = e as Record<string, Object>
      this.errMsg = typeof err['message'] === 'string' ? err['message'] as string : 'request failed'
    }
  }
}

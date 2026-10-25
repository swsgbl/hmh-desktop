/**
 * v2 日志页:runtime line 流累积(chat.logs,最近 200 条)
 */
import { AppStore } from '../model/AppStore'
import { ChatState, StateObj } from '../model/Types'
import { t } from '../model/I18n'

@Component
export struct LogsPage {
  @State logs: string[] = []
  @State locale: string = 'zh'
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('chatRev') chatRev: number = 0
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.logs = AppStore.get().chat.logs
    AppStore.get().setListener({
      onChatState: (st: ChatState) => {
        this.logs = st.logs
      },
      onServerState: (_st: StateObj | null) => {
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
    Column({ space: 8 }) {
      Text(this.L('dock.logsHead'))
        .fontSize(13)
        .fontColor('#666666')
        .width('100%')
      if (this.logs.length === 0) {
        Text(this.L('dock.logsEmpty'))
          .fontSize(12)
          .fontColor('#999999')
          .width('100%')
          .padding({ top: 20 })
      } else {
        Scroll() {
          Column({ space: 2 }) {
            ForEach(this.logs, (line: string, idx: number) => {
              Text(line)
                .fontSize(10)
                .fontColor('#444444')
                .width('100%')
                .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                .backgroundColor(idx % 2 === 0 ? '#FFFFFF' : '#F7F7F7')
            }, (line: string, idx: number) => `${idx}`)
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
}

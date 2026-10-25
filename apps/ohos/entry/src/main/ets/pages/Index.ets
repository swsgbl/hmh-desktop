/**
 * v2 主框架:底部 6 Tab(总览/会话/工作区/文件/日志/设置) + 顶部连接状态条
 */
import { AppStore } from '../model/AppStore'
import { SessionsPage } from './SessionsPage'
import { WorkspacesPage } from './WorkspacesPage'
import { FilesPage } from './FilesPage'
import { SettingsPage } from './SettingsPage'
import { OverviewPage } from './OverviewPage'
import { LogsPage } from './LogsPage'
import { t } from '../model/I18n'

@Entry
@Component
struct Index {
  @State currentTab: number = 1
  @State locale: string = 'zh'
  @StorageProp('sseConnected') sseConnected: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.locale = this.store.locale
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        Circle({ width: 8, height: 8 })
          .fill(this.store.baseUrl === '' ? '#C0392B' : (this.sseConnected ? '#0A7D32' : '#B26A00'))
        Text('HMH Desktop')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        if (this.store.baseUrl === '') {
          Text(this.L('status.idle'))
            .fontSize(11)
            .fontColor('#C0392B')
        }
      }
      .padding({ left: 16, right: 16, top: 10, bottom: 6 })
      .width('100%')

      Tabs({ barPosition: BarPosition.End, index: this.currentTab }) {
        TabContent() {
          OverviewPage()
        }
        .tabBar(this.L('dock.overview'))

        TabContent() {
          SessionsPage()
        }
        .tabBar(this.locale === 'en' ? 'Sessions' : '会话')

        TabContent() {
          WorkspacesPage()
        }
        .tabBar(this.L('dock.ws'))

        TabContent() {
          FilesPage()
        }
        .tabBar(this.L('dock.files'))

        TabContent() {
          LogsPage()
        }
        .tabBar(this.L('dock.logs'))

        TabContent() {
          SettingsPage()
        }
        .tabBar(this.L('set.title'))
      }
      .layoutWeight(1)
      .width('100%')
      .onChange((idx: number) => {
        this.currentTab = idx
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F1F3F5')
  }
}

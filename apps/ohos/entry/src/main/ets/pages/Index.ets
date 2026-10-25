/**
 * 主框架:底部 Tab(会话/工作区/文件/设置) + 顶部连接状态条
 */
import { AppStore } from '../model/AppStore'
import { SessionsPage } from './SessionsPage'
import { WorkspacesPage } from './WorkspacesPage'
import { FilesPage } from './FilesPage'
import { SettingsPage } from './SettingsPage'

@Entry
@Component
struct Index {
  @State currentTab: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  private store: AppStore = AppStore.get()

  build() {
    Column() {
      // 顶部状态条
      Row({ space: 8 }) {
        Circle({ width: 8, height: 8 })
          .fill(this.store.baseUrl === '' ? '#C0392B' : (this.sseConnected ? '#0A7D32' : '#B26A00'))
        Text('HMH Desktop')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        if (this.store.baseUrl === '') {
          Text('未配置')
            .fontSize(11)
            .fontColor('#C0392B')
        }
      }
      .padding({ left: 16, right: 16, top: 10, bottom: 6 })
      .width('100%')

      // 内容区
      Tabs({ barPosition: BarPosition.End, index: this.currentTab }) {
        TabContent() {
          SessionsPage()
        }
        .tabBar('会话')

        TabContent() {
          WorkspacesPage()
        }
        .tabBar('工作区')

        TabContent() {
          FilesPage()
        }
        .tabBar('文件')

        TabContent() {
          SettingsPage()
        }
        .tabBar('设置')
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

/**
 * v3 主框架:三栏工作台(1:1 复刻 .app-shell grid: 264px | 1fr | 360px)
 *   titlebar 36px(☰ | HMH Desktop)
 *   Row[ Sidebar | WorkspacePane | DockPane ]
 *   设置=弹层(蓝本 cmdk.settings 480px 居中)
 * VM 1280×800 横屏 → ≥1100 三栏成立
 */
import { AppStore } from '../model/AppStore'
import { Sidebar } from './Sidebar'
import { WorkspacePane } from './WorkspacePane'
import { DockPane } from './DockPane'
import { Th, Metrics } from '../theme/Theme'
import { t } from '../model/I18n'
import { SettingsPage } from './SettingsPage'

@Entry
@Component
struct Index {
  @State activeId: string = ''
  @State locale: string = 'zh'
  @State sidebarOpen: boolean = true
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  @StorageProp('settingsOpen') settingsOpen: boolean = false
  @StorageProp('openSessionRev') openSessionRev: number = 0
  @State winW: number = 1280
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.locale = this.store.locale
    // Sidebar 的 openSession 经 AppStorage 传递
    AppStorage.setOrCreate('settingsOpen', false)
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  build() {
    Column({ space: 0 }) {
      // ---- titlebar 36px ----
      Row({ space: 8 }) {
        Text('☰')
          .fontSize(17)
          .fontColor(Th.c.text3)
          .padding({ left: 10, right: 10 })
          .onClick(() => {
            this.sidebarOpen = !this.sidebarOpen
          })
        Text('HMH Desktop')
          .fontSize(13)
          .fontColor(Th.c.text3)
        Blank()
      }
      .height(36)
      .width('100%')
      .backgroundColor(Th.c.l2)
      .alignItems(VerticalAlign.Center)

      // ---- 三栏 grid 等价:Row[264|1fr|360] ----
      // VM 窗口为自由浮动窗(实测 857~1280 浮动),必须自适应:
      //   winW>=1240 完整三栏; 960<=winW<1240 侧栏 200+Dock 300; <960 侧栏藏(☰ 可开覆盖层)
      Row({ space: 0 }) {
        if (this.sidebarOpen && this.winW >= 1240) {
          Sidebar({ activeId: this.activeId })
        } else if (this.sidebarOpen && this.winW >= 960) {
          Sidebar({ activeId: this.activeId }).width(200)
        }
        WorkspacePane({ activeId: this.activeId })
        if (this.winW >= 1240) {
          DockPane().width(360)
        } else {
          DockPane().width(300)
        }
      }
      .layoutWeight(1)
      .width('100%')
      .alignItems(VerticalAlign.Top)
      .onAreaChange((_o: Area, n: Area) => {
        const w = n.width
        const v = typeof w === 'number' ? w : parseInt(w.toString(), 10)
        if (!Number.isNaN(v) && v > 0) {
          this.winW = v
        }
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Th.c.bg)

    // ---- 设置弹层(居中 480px) ----
    .overlay(this.settingsLayer(), { align: Alignment.Center })
  }

  @Builder
  settingsLayer() {
    if (this.settingsOpen) {
      Column() {
        // 弹层头(标题+关闭)
        Row({ space: 8 }) {
          Text(this.L('set.title'))
            .fontSize(14)
            .fontColor(Th.c.text)
            .layoutWeight(1)
          Text('×')
            .fontSize(18)
            .fontColor(Th.c.text3)
            .padding(6)
            .onClick(() => {
              this.settingsOpen = false
            })
        }
        .padding({ left: 14, right: 14, top: 10, bottom: 10 })
        .width('100%')

        // 复用 v2 SettingsPage(内容全量:连接/外观/语言/模型/审批/Provider)
        SettingsPage()
      }
      .width(480)
      .constraintSize({ maxHeight: '80%' })
      .backgroundColor(Th.c.l2)
      .border({ width: 1, color: Th.c.border2 })
      .borderRadius(14)
      .padding({ bottom: 12 })
    }
  }
}

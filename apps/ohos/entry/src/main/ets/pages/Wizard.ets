/**
 * v6.1 安装向导(三选一,成熟步骤感):
 *   ① 在本机安装 hmh 内核(推荐默认)——展示 PC 端一键命令+复制按钮+轮询 7788 自动连上
 *   ② 连接电脑(远程)——现有设置流程(baseUrl+token)
 *   ③ 演示模式——空壳浏览
 * 每步 上一步/跳过;选择持久(preferences);设置页「重新配置」可重入(resetWizard)。
 * 全局配置文案:本机模式 CLI/TUI/桌面应用/浏览器四端共享 /data/local/home/.hmharness。
 */
import { AppStore } from '../model/AppStore'
import { Th } from '../theme/Theme'
import { pasteboard } from '@kit.BasicServicesKit'
import { MotionSpinner } from '../components/MotionSpinner'

@Component
export struct Wizard {
  @State step: number = 0            // 0=选择页 1=①本机安装 2=②远程 3=③演示
  @State polling: boolean = false
  @State pollCount: number = 0
  @State copied: boolean = false
  @StorageProp('firstRunOutcome') outcome: string = 'wizard'
  private store: AppStore = AppStore.get()
  private pollTimer: number = -1
  // 2026-10-31 单机闭环:应用与内核全部在本机完成(浏览器下载整合包+终端一行),
  // 不再要求另一台电脑。命令自动探测下载目录的真实路径(文件管理器视图与
  // 终端路径不同:/storage/media/... 为终端可见形态)。
  private readonly PC_CMD = 'D=$(ls /storage/media/100/local/files/Docs/Download/hmh-offline-bundle.tar.gz 2>/dev/null || ls ~/Download/hmh-offline-bundle.tar.gz 2>/dev/null); cd /data/local/tmp && busybox tar xzf "$D" && sh hmh-bundle/install.sh'

  aboutToDisappear(): void {
    this.stopPoll()
  }

  private close(): void {
    AppStorage.setOrCreate('wizardOpen', false)
    this.store.markWizardDone()
  }

  private startPoll(): void {
    // 顺序修正(2026-10-31 用户实测暴露):先清旧定时器再置状态——旧序
    // polling=true 后紧跟 stopPoll() 把状态清回 false,按钮/转圈永远显示
    // "未在等待"(轮询其实在跑),自动等待看似失效。
    this.stopPoll()
    this.polling = true
    this.pollCount = 0
    this.pollTimer = setInterval(() => {
      this.pollCount++
      const api = this.store.api()
      api.getJson<Object>('/api/state').then(() => {
        // 本机 web 就绪 → 自动连上
        this.stopPoll()
        this.store.saveConfig('http://127.0.0.1:7788', '').then(() => {
          this.store.markLocalKernelSeen()
          this.store.markWizardDone()
          AppStorage.setOrCreate('wizardOpen', false)
          this.store.startSse('')
        })
      }).catch(() => {
        if (this.pollCount >= 60) {   // ~60×2s=2min 停
          this.stopPoll()
        }
      })
    }, 2000) as number
  }

  private stopPoll(): void {
    if (this.pollTimer >= 0) {
      clearInterval(this.pollTimer)
      this.pollTimer = -1
    }
    this.polling = false
  }

  private copyCmd(): void {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.PC_CMD)
      pasteboard.getSystemPasteboard().setData(data)
      this.copied = true
      setTimeout(() => { this.copied = false }, 1500)
    } catch (e) {
      // 剪贴板不可用时静默(用户可手抄命令)
    }
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 遮罩
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('rgba(0,0,0,0.45)')
        .onClick(() => this.close())

      // 向导主体
      Column({ space: 0 }) {
        this.header()
        if (this.step === 0) { this.stepChoose() }
        else if (this.step === 1) { this.stepLocalInstall() }
        else if (this.step === 2) { this.stepRemote() }
        else { this.stepDemo() }
      }
      .width(560)
      .constraintSize({ maxHeight: '86%' })
      .backgroundColor(Th.c.l1)
      .borderRadius(14)
      .border({ width: 1, color: Th.c.border2 })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  header() {
    Row({ space: 8 }) {
      Text('欢迎使用 HMH Desktop')
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor(Th.c.text)
        .layoutWeight(1)
      Text('×')
        .fontSize(18)
        .fontColor(Th.c.text3)
        .padding(6)
        .onClick(() => this.close())
    }
    .padding({ left: 18, right: 12, top: 14, bottom: 10 })
    .width('100%')
  }

  @Builder
  stepChoose() {
    Scroll() {
      Column({ space: 10 }) {
        if (this.outcome === 'local-guide') {
          Text('检测到本机已安装 hmh 内核,但服务未启动。')
            .fontSize(12)
            .fontColor(Th.c.warn)
        } else {
          Text('检测到本机未安装 hmh。选择安装方式(①会自动等待并连接,无需手动操作):')
            .fontSize(12)
            .fontColor(Th.c.text2)
        }

        // ① 本机安装(推荐)
        this.optionCard('local-install', '① 在本机安装 hmh 内核(推荐)',
          '设备上安装完整 hmh 内核并启动服务,本应用与 TUI/浏览器三端同核。默认全局配置 /data/local/home/.hmharness,CLI/TUI/桌面应用/浏览器四端共享全部配置、密钥与会话。',
          true)

        // ② 连接电脑
        this.optionCard('remote', '② 连接电脑(远程模式)',
          '连接到电脑上运行的 hmh。共享电脑的配置、密钥与会话。',
          false)

        // ③ 演示模式
        this.optionCard('demo', '③ 演示模式',
          '不连接任何服务,浏览应用界面。',
          false)

        Row({ space: 12 }) {
          Text('选择将被记住,可在 设置 → 重新配置 中更改。')
            .fontSize(11)
            .fontColor(Th.c.text3)
            .layoutWeight(1)
          Text('跳过')
            .fontSize(12)
            .fontColor(Th.c.text3)
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .onClick(() => this.close())
        }
        .width('100%')
        .padding({ top: 4 })
      }
      .padding({ left: 18, right: 18, bottom: 16 })
      .alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .width('100%')
  }

  @Builder
  optionCard(key: string, title: string, desc: string, recommended: boolean) {
    // 触屏适配(用户实测反馈 2026-10-31):整卡都是点击目标——不只"选择此项"几个字。
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text(title)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor(Th.c.text)
          .layoutWeight(1)
        if (recommended) {
          Text('推荐')
            .fontSize(10)
            .fontColor(Th.c.brand)
            .padding({ left: 8, right: 8, top: 2, bottom: 2 })
            .borderRadius(8)
            .backgroundColor(Th.c.brandBg)
        }
      }
      .width('100%')
      Text(desc)
        .fontSize(11)
        .fontColor(Th.c.text2)
        .lineHeight(16)
      Text('选择此项 →')
        .fontSize(11)
        .fontColor(Th.c.brand)
    }
    .padding(14)
    .borderRadius(10)
    .backgroundColor(Th.c.l2)
    .border({ width: 1, color: Th.c.border })
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      if (key === 'local-install') {
        // 自动安装语义(沙箱内应用不能代装,故:进入即自动等待,服务就绪即自动连)
        this.step = 1
        this.startPoll()
      } else if (key === 'remote') { this.step = 2 }
      else { this.step = 3 }
    })
  }

  @Builder
  stepLocalInstall() {
    Scroll() {
      Column({ space: 12 }) {
        Text('单机安装(本机浏览器先下载 hmh-offline-bundle.tar.gz,再在终端粘贴这一行):')
          .fontSize(12)
          .fontColor(Th.c.text)
        Row({ space: 8 }) {
          Text(this.PC_CMD)
            .fontSize(10)
            .fontColor(Th.c.brand)
            .layoutWeight(1)
            .maxLines(4)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Button(this.copied ? '已复制 ✓' : '复制')
            .fontSize(11)
            .height(30)
            .backgroundColor(Th.c.brand)
            .onClick(() => this.copyCmd())
        }
        .padding(10)
        .borderRadius(8)
        .backgroundColor(Th.c.l2)
        .width('100%')

        Text('命令会:安装 hmh 内核 → 修补启动器 → 启动服务(0.0.0.0:7788)。')
          .fontSize(11)
          .fontColor(Th.c.text2)

        Column({ space: 4 }) {
          Text('全局配置(四端共享)')
            .fontSize(11)
            .fontWeight(FontWeight.Medium)
            .fontColor(Th.c.text)
          Text('本机模式:CLI / TUI / 桌面应用 / 浏览器共享 /data/local/home/.hmharness 的全部配置、密钥与会话。')
            .fontSize(11)
            .fontColor(Th.c.text2)
            .lineHeight(16)
        }
        .padding(10)
        .borderRadius(8)
        .backgroundColor(Th.c.l2)
        .width('100%')
        .alignItems(HorizontalAlign.Start)

        if (this.polling) {
          Row({ space: 8 }) {
            MotionSpinner({ side: 16, color: Th.c.brand })
            Text(`已自动等待本机服务就绪… (${this.pollCount}/60,装好后自动连接)`)
              .fontSize(11)
              .fontColor(Th.c.text2)
          }
        }

        Row({ space: 12 }) {
          Button('上一步')
            .fontSize(12)
            .height(34)
            .backgroundColor(Th.c.l2)
            .fontColor(Th.c.text)
            .onClick(() => { this.step = 0; this.stopPoll() })
          Button(this.polling ? '停止等待' : '开始等待(自动连接)')
            .fontSize(12)
            .height(34)
            .backgroundColor(this.polling ? Th.c.l2 : Th.c.brand)
            .fontColor(this.polling ? Th.c.text : Color.White)
            .onClick(() => {
              if (this.polling) { this.stopPoll() } else { this.startPoll() }
            })
          Blank()
          Text('跳过')
            .fontSize(12)
            .fontColor(Th.c.text3)
            .padding({ left: 8, right: 8 })
            .onClick(() => { this.stopPoll(); this.close() })
        }
        .width('100%')
      }
      .padding({ left: 18, right: 18, bottom: 16 })
      .alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .width('100%')
  }

  @Builder
  stepRemote() {
    Column({ space: 12 }) {
      Text('在设置中填写电脑的地址与 token:')
        .fontSize(12)
        .fontColor(Th.c.text)
      Text('服务器地址格式: http://<电脑IP>:7788\n在电脑上运行 hmh web --exposure=lan 并从其 config 读取 token。')
        .fontSize(11)
        .fontColor(Th.c.text2)
        .lineHeight(16)
      Column({ space: 4 }) {
        Text('全局配置')
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .fontColor(Th.c.text)
        Text('远程模式:共享电脑上 HMH_HOME 的全部配置、密钥与会话。')
          .fontSize(11)
          .fontColor(Th.c.text2)
      }
      .padding(10)
      .borderRadius(8)
      .backgroundColor(Th.c.l2)
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Row({ space: 12 }) {
        Button('上一步')
          .fontSize(12)
          .height(34)
          .backgroundColor(Th.c.l2)
          .fontColor(Th.c.text)
          .onClick(() => { this.step = 0 })
        Button('打开设置')
          .fontSize(12)
          .height(34)
          .backgroundColor(Th.c.brand)
          .onClick(() => {
            this.close()
            AppStorage.setOrCreate('settingsOpen', true)
          })
        Blank()
        Text('跳过')
          .fontSize(12)
          .fontColor(Th.c.text3)
          .onClick(() => this.close())
      }
      .width('100%')
      .padding({ bottom: 16 })
    }
    .padding({ left: 18, right: 18 })
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  stepDemo() {
    Column({ space: 12 }) {
      Text('演示模式:不连接服务,可浏览界面。')
        .fontSize(12)
        .fontColor(Th.c.text)
      Text('随时可在 设置 → 重新配置 里重新开始。')
        .fontSize(11)
        .fontColor(Th.c.text2)
      Row({ space: 12 }) {
        Button('上一步')
          .fontSize(12)
          .height(34)
          .backgroundColor(Th.c.l2)
          .fontColor(Th.c.text)
          .onClick(() => { this.step = 0 })
        Button('进入演示')
          .fontSize(12)
          .height(34)
          .backgroundColor(Th.c.brand)
          .onClick(() => this.close())
        Blank()
      }
      .width('100%')
      .padding({ bottom: 16 })
    }
    .padding({ left: 18, right: 18 })
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * M-O1 设置页:服务器地址 + 访问令牌配置、连接测试、持久化
 * 安全:token 只存 preferences,UI 掩码显示,绝不打日志
 */
import { AppStore } from '../model/AppStore'
import { ApiError, toApiError } from '../net/ApiClient'
import { guardState } from '../model/Guards'

@Component
export struct SettingsPage {
  @State baseUrl: string = ''
  @State token: string = ''
  @State tokenMasked: boolean = true
  @State testing: boolean = false
  @State testResult: string = ''
  @State testOk: boolean = false
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.baseUrl = this.store.baseUrl
    this.token = this.store.token
  }

  build() {
    Scroll() {
      Column({ space: 16 }) {
        Text('连接设置')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .alignSelf(ItemAlign.Start)

        Column({ space: 8 }) {
          Text('服务器地址 (LAN)')
            .fontSize(14)
            .fontColor('#666666')
            .alignSelf(ItemAlign.Start)
          TextInput({ text: this.baseUrl, placeholder: 'http://192.168.161.1:7788' })
            .onChange((v: string) => {
              this.baseUrl = v.trim()
            })
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start)

        Column({ space: 8 }) {
          Text('访问令牌 (x-hmh-key)')
            .fontSize(14)
            .fontColor('#666666')
            .alignSelf(ItemAlign.Start)
          Row({ space: 8 }) {
            TextInput({ text: this.token, placeholder: 'web.token (config.json)' })
              .type(this.tokenMasked ? InputType.Password : InputType.Normal)
              .onChange((v: string) => {
                this.token = v.trim()
              })
              .layoutWeight(1)
            Button(this.tokenMasked ? '显示' : '隐藏')
              .fontSize(13)
              .height(40)
              .onClick(() => {
                this.tokenMasked = !this.tokenMasked
              })
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)

        Row({ space: 12 }) {
          Button('保存')
            .onClick(() => this.doSave())
          Button('测试连接')
            .enabled(!this.testing)
            .onClick(() => this.doTest())
        }

        if (this.testResult !== '') {
          Text(this.testResult)
            .fontSize(14)
            .fontColor(this.testOk ? '#0A7D32' : '#C0392B')
            .padding(10)
            .backgroundColor(this.testOk ? '#E8F5E9' : '#FDECEA')
            .borderRadius(8)
            .width('100%')
        }

        Divider()

        Column({ space: 4 }) {
          Text('说明').fontSize(14).fontWeight(FontWeight.Bold).alignSelf(ItemAlign.Start)
          Text('1. PC 端运行 hmh web --exposure=lan 启动 7788 服务')
            .fontSize(13).fontColor('#888888').alignSelf(ItemAlign.Start)
          Text('2. 令牌在 PC 端 ~/.hmharness/config.json 的 web.token 字段')
            .fontSize(13).fontColor('#888888').alignSelf(ItemAlign.Start)
          Text('3. 本应用只经 LAN 访问,令牌仅存本机,不会出现在任何日志')
            .fontSize(13).fontColor('#888888').alignSelf(ItemAlign.Start)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
      }
      .padding(20)
      .width('100%')
    }
    .height('100%')
    .width('100%')
  }

  private async doSave(): Promise<void> {
    await this.store.saveConfig(this.baseUrl, this.token)
    this.testResult = '已保存(令牌已持久化到本机)'
    this.testOk = true
  }

  private async doTest(): Promise<void> {
    if (this.baseUrl === '') {
      this.testResult = '请先填写服务器地址'
      this.testOk = false
      return
    }
    await this.store.saveConfig(this.baseUrl, this.token)
    this.testing = true
    this.testResult = '连接中...'
    this.testOk = false
    try {
      const st = await this.store.api().getJson<Object>('/api/state')
      const g = guardState(st)
      if (g === null) {
        this.testResult = '响应格式异常'
        this.testOk = false
      } else {
        this.testResult = `连接成功 · daemon ${g.daemonVersion} · 模型 ${g.model} · exposure=${g.exposure}`
        this.testOk = true
        this.store.serverState = g
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : toApiError(e as object)
      if (err.code === 'auth-required') {
        this.testResult = '令牌无效 (403 auth-required),请核对 web.token'
      } else if (err.status === 0) {
        this.testResult = `网络不可达: ${err.message}`
      } else {
        this.testResult = `失败 HTTP ${err.status}: ${err.message}`
      }
      this.testOk = false
    }
    this.testing = false
  }
}

/**
 * v2 设置页:连接 + 外观/语言 + #12 模型选择 + #13 审批模式 + #14 Provider 管理
 * 安全:token 只存 preferences,UI 掩码,绝不打日志
 */
import { Th } from '../theme/Theme'
import { AppStore } from '../model/AppStore'
import { ApiError, toApiError } from '../net/ApiClient'
import { guardState } from '../model/Guards'
import { t } from '../model/I18n'
import { StateObj, ModelReq, ApprovalReq, ProviderUpsertReq, ProviderRow } from '../model/Types'
import { modelChipLabel, isCurrentProvider, validApproval, validateProviderForm, parseProviderRows } from '../model/SettingsBiz'

@Component
export struct SettingsPage {
  @State baseUrl: string = ''
  @State token: string = ''
  @State tokenMasked: boolean = true
  @State testing: boolean = false
  @State testResult: string = ''
  @State testOk: boolean = false
  @State locale: string = 'zh'
  @State theme: string = 'system'
  @State reduceMotion: boolean = false
  @State model: string = ''
  @State chatProvider: string = ''
  @State providers: ProviderRow[] = []
  @State approvalMode: string = 'ask'
  @State approvalMsg: string = ''
  @State modelMsg: string = ''
  // Provider 表单
  @State pvOpen: boolean = false
  @State pvName: string = ''
  @State pvUrl: string = ''
  @State pvModel: string = ''
  @State pvKey: string = ''
  @State pvKeyMasked: boolean = true
  @State pvMsg: string = ''
  @State pvMsgOk: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('themeRev') themeRev: number = 0
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.baseUrl = this.store.baseUrl
    this.token = this.store.token
    this.locale = this.store.locale
    this.theme = this.store.theme
    this.reduceMotion = this.store.reduceMotion
    this.loadState()
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  private async loadState(): Promise<void> {
    try {
      const st = await this.store.api().getJson<Object>('/api/state')
      const g = guardState(st)
      if (g !== null) {
        this.model = g.model
        const rawProv = st as Record<string, Object>
        const cp = rawProv['chatProvider']
        this.chatProvider = typeof cp === 'string' ? cp as string : ''
        const ap = rawProv['approval']
        if (typeof ap === 'string') {
          this.approvalMode = ap as string
        }
        const pv = rawProv['providers']
        this.providers = parseProviderRows(pv instanceof Array ? pv as object[] : null)
      }
    } catch (e) {
      // 未配置时静默
    }
  }

  build() {
    Scroll() {
      Column({ space: 16 }) {
        Text('连接设置')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .alignSelf(ItemAlign.Start)

        // v6.1: 重新配置(向导可重入)+模式说明
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Text('本机模式: CLI/TUI/桌面应用/浏览器共享 /data/local/home/.hmharness')
              .fontSize(10)
              .fontColor(Th.c.text3)
            Text('远程模式: 共享电脑上 HMH_HOME 的配置、密钥与会话')
              .fontSize(10)
              .fontColor(Th.c.text3)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          Button('重新配置')
            .fontSize(11)
            .height(28)
            .backgroundColor(Th.c.l2)
            .fontColor(Th.c.text)
            .onClick(() => {
              this.store.resetWizard().then(() => {
                AppStorage.setOrCreate('settingsOpen', false)
                AppStorage.setOrCreate('wizardOpen', true)
              })
            })
        }
        .width('100%')

        Column({ space: 8 }) {
          Text('服务器地址 (LAN)')
            .fontSize(14)
            .fontColor(Th.c.text2)
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
            .fontColor(Th.c.text2)
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
            .fontColor(this.testOk ? Th.c.success : Th.c.danger)
            .padding(10)
            .backgroundColor(this.testOk ? Th.c.successBg : Th.c.dangerBg)
            .borderRadius(8)
            .width('100%')
        }

        Divider()

        // 外观
        Column({ space: 8 }) {
          Text(this.L('set.theme'))
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          Row({ space: 6 }) {
            ForEach(['system', 'light', 'dark'], (th: string) => {
              Text(this.themeLabel(th))
                .fontSize(12)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor(this.theme === th ? Th.c.brand : Th.c.l2)
                .fontColor(this.theme === th ? Th.c.l1 : Th.c.text)
                .borderRadius(14)
                .onClick(() => this.setTheme(th))
            }, (th: string) => th)
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        // HIG B-4: 减弱动效(鸿蒙无系统级等价物,应用内开关)
        Column({ space: 8 }) {
          Text(this.locale === 'en' ? 'Reduce Motion' : '减弱动效')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          Row({ space: 6 }) {
            ForEach([false, true], (on: boolean) => {
              Text(on ? (this.locale === 'en' ? 'On' : '开') : (this.locale === 'en' ? 'Off' : '关'))
                .fontSize(12)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor(this.reduceMotion === on ? Th.c.brand : Th.c.l2)
                .fontColor(this.reduceMotion === on ? Th.c.l1 : Th.c.text)
                .borderRadius(14)
                .onClick(() => this.setReduceMotion(on))
            }, (on: boolean) => `${on}`)
          }
          .width('100%')
          Text(this.locale === 'en' ? 'Disables spinner/pulse animations' : '关闭旋转/脉冲类动效')
            .fontSize(10)
            .fontColor(Th.c.text3)
            .alignSelf(ItemAlign.Start)
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        // 语言
        Column({ space: 8 }) {
          Text(this.L('set.lang'))
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          Row({ space: 6 }) {
            ForEach(['zh', 'en'], (l: string) => {
              Text(l === 'zh' ? '中文' : 'English')
                .fontSize(12)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor(this.locale === l ? Th.c.brand : Th.c.l2)
                .fontColor(this.locale === l ? Th.c.l1 : Th.c.text)
                .borderRadius(14)
                .onClick(() => this.setLocale(l))
            }, (l: string) => l)
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        Divider()

        // #12 模型选择(name:model chip)
        Column({ space: 8 }) {
          Text(this.L('top.model'))
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          Text(this.locale === 'en' ? `current: ${this.model}` : `当前: ${this.model}`)
            .fontSize(12)
            .fontColor(Th.c.text2)
            .alignSelf(ItemAlign.Start)
          Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.Start }) {
            ForEach(this.providers, (p: ProviderRow) => {
              Text(modelChipLabel(p.name, p.model))
                .fontSize(11)
                .padding({ left: 10, right: 10, top: 5, bottom: 5 })
                .backgroundColor(isCurrentProvider(p.name, p.model, this.model, this.chatProvider) ? Th.c.success : Th.c.l2)
                .fontColor(isCurrentProvider(p.name, p.model, this.model, this.chatProvider) ? Th.c.l1 : Th.c.text)
                .borderRadius(12)
                .margin({ right: 6, bottom: 6 })
                .onClick(() => this.doModel(p.name))
            }, (p: ProviderRow) => p.name)
          }
          .width('100%')
          if (this.modelMsg !== '') {
            Text(this.modelMsg).fontSize(11).fontColor(Th.c.brand).alignSelf(ItemAlign.Start)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        // #13 审批模式
        Column({ space: 8 }) {
          Text(this.locale === 'en' ? 'Approval' : '审批模式')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          Row({ space: 6 }) {
            ForEach(['ask', 'auto'], (m: string) => {
              Text(this.approvalLabel(m))
                .fontSize(12)
                .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                .backgroundColor(this.approvalMode === m ? Th.c.warn : Th.c.l2)
                .fontColor(this.approvalMode === m ? Th.c.l1 : Th.c.text)
                .borderRadius(14)
                .onClick(() => this.doApproval(m))
            }, (m: string) => m)
          }
          .width('100%')
          if (this.approvalMsg !== '') {
            Text(this.approvalMsg).fontSize(11).fontColor(Th.c.warn).alignSelf(ItemAlign.Start)
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        // #14 Provider 管理
        Column({ space: 8 }) {
          Text(this.locale === 'en' ? 'Providers' : '模型服务 Provider')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .alignSelf(ItemAlign.Start)
          ForEach(this.providers, (p: ProviderRow) => {
            Row({ space: 8 }) {
              Text(p.name)
                .fontSize(13)
                .fontWeight(FontWeight.Medium)
              Text(p.model)
                .fontSize(11)
                .fontColor(Th.c.text2)
                .layoutWeight(1)
                .maxLines(1)
              if (p.purposes.length > 0) {
                Text(p.purposes.join(','))
                  .fontSize(9)
                  .fontColor(Th.c.text3)
              }
            }
            .padding(8)
            .backgroundColor(Th.c.l2)
            .borderRadius(8)
            .width('100%')
          }, (p: ProviderRow) => p.name)

          Button(this.pvOpen ? (this.locale === 'en' ? 'Close form' : '收起') : (this.locale === 'en' ? '+ Add provider' : '+ 新增 Provider'))
            .fontSize(12)
            .height(32)
            .backgroundColor(Th.c.text2)
            .onClick(() => {
              this.pvOpen = !this.pvOpen
            })

          if (this.pvOpen) {
            Column({ space: 6 }) {
              TextInput({ placeholder: 'name (e.g. my-openai)' })
                .onChange((v: string) => {
                  this.pvName = v.trim()
                })
                .width('100%')
              TextInput({ placeholder: 'baseUrl (e.g. https://api.example.com/v1)' })
                .onChange((v: string) => {
                  this.pvUrl = v.trim()
                })
                .width('100%')
              TextInput({ placeholder: 'model (e.g. gpt-4o-mini)' })
                .onChange((v: string) => {
                  this.pvModel = v.trim()
                })
                .width('100%')
              Row({ space: 8 }) {
                TextInput({ placeholder: 'apiKey (sk-...)' })
                  .type(this.pvKeyMasked ? InputType.Password : InputType.Normal)
                  .onChange((v: string) => {
                    this.pvKey = v.trim()
                  })
                  .layoutWeight(1)
                Button(this.pvKeyMasked ? '显示' : '隐藏')
                  .fontSize(11)
                  .height(34)
                  .onClick(() => {
                    this.pvKeyMasked = !this.pvKeyMasked
                  })
              }
              .width('100%')
              if (this.pvMsg !== '') {
                Text(this.pvMsg).fontSize(11).fontColor(this.pvMsgOk ? Th.c.success : Th.c.danger)
              }
              Row({ space: 10 }) {
                Button(this.locale === 'en' ? 'Validate' : '校验')
                  .fontSize(12)
                  .height(34)
                  .backgroundColor(Th.c.text3)
                  .onClick(() => this.doValidateForm())
                Text(this.locale === 'en' ? '(validation only — no server write)' : '(仅校验,不写入服务端)')
                  .fontSize(10)
                  .fontColor(Th.c.text3)
              }
            }
            .padding(10)
            .backgroundColor(Th.c.l2)
            .borderRadius(8)
            .width('100%')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')

        Divider()

        Column({ space: 4 }) {
          Text('说明').fontSize(14).fontWeight(FontWeight.Bold).alignSelf(ItemAlign.Start)
          Text('1. PC 端运行 hmh web --exposure=lan 启动 7788 服务')
            .fontSize(13).fontColor(Th.c.text3).alignSelf(ItemAlign.Start)
          Text('2. 令牌在 PC 端 ~/.hmharness/config.json 的 web.token 字段')
            .fontSize(13).fontColor(Th.c.text3).alignSelf(ItemAlign.Start)
          Text('3. 本应用只经 LAN 访问,令牌仅存本机,不会出现在任何日志')
            .fontSize(13).fontColor(Th.c.text3).alignSelf(ItemAlign.Start)
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

  private themeLabel(th: string): string {
    if (th === 'light') {
      return this.L('set.themeLight')
    }
    if (th === 'dark') {
      return this.L('set.themeDark')
    }
    return this.L('set.themeSystem')
  }

  private approvalLabel(m: string): string {
    if (m === 'ask') {
      return this.locale === 'en' ? 'Ask (default)' : '每次询问 (默认)'
    }
    return this.locale === 'en' ? 'Auto-run' : '自动执行'
  }

  private setTheme(th: string): void {
    this.theme = th
    this.store.saveTheme(th)
  }

  private setReduceMotion(on: boolean): void {
    this.reduceMotion = on
    this.store.saveReduceMotion(on)
  }

  private setLocale(l: string): void {
    this.locale = l
    this.store.saveLocale(l)
  }

  // #12:点击 chip → POST /api/model {name} → 回读 state 确认
  private async doModel(name: string): Promise<void> {
    this.modelMsg = ''
    try {
      const body: ModelReq = { name: name }
      const resp = await this.store.api().postJson<Object>('/api/model', body)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        const m = o['model']
        if (typeof m === 'string') {
          this.model = m as string
        }
        this.chatProvider = name
        this.modelMsg = this.locale === 'en' ? `switched → ${name}` : `已切换 → ${name}`
      }
    } catch (e) {
      const err = e instanceof ApiError ? e as ApiError : toApiError(e as object)
      this.modelMsg = `HTTP ${err.status}: ${err.message}`
    }
  }

  // #13:POST /api/config {approval}
  private async doApproval(m: string): Promise<void> {
    if (!validApproval(m)) {
      return
    }
    this.approvalMsg = ''
    try {
      const body: ApprovalReq = { approval: m }
      const resp = await this.store.api().postJson<Object>('/api/config', body)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        this.approvalMode = m
        this.approvalMsg = this.locale === 'en' ? `approval = ${m}` : `审批模式 = ${m}`
      }
    } catch (e) {
      const err = e instanceof ApiError ? e as ApiError : toApiError(e as object)
      this.approvalMsg = `HTTP ${err.status}: ${err.message}`
    }
  }

  // #14:仅表单校验(不写入服务端,防污染真实 config —— Zode 授权的降级验收)
  private doValidateForm(): void {
    const err = validateProviderForm(this.pvName, this.pvUrl, this.pvModel)
    if (err !== '') {
      this.pvMsg = err
      this.pvMsgOk = false
      return
    }
    this.pvMsg = this.locale === 'en'
      ? 'form OK — would POST /api/providers (not sent: keeps live config clean)'
      : '表单校验通过 —— 将 POST /api/providers(未发送:避免污染真实配置)'
    this.pvMsgOk = true
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
        this.loadState()
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

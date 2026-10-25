/**
 * v3 中栏 Workspace(topbar + stream + composer,1:1 复刻 .workspace)
 * 蓝本: topbar(host-dot●已连接 runtime|工作区 pill|模型▾|审批|⚙|中EN)
 *       stream(turn 卡: user 右对齐蓝底/assistant 卡/工具折叠卡/审批卡/交付物卡/turn-sum)
 *       composer(附件条/@/textarea/发送)
 * 逻辑全部复用 v2 SessionsPage chatBody(搬运)
 */
import { AppStore } from '../model/AppStore'
import { ChatState, ChatMessage, TaskReq, SimpleSidReq, ApproveReq, StateObj, ProviderRow, ModelReq } from '../model/Types'
import { ApiError, toApiError } from '../net/ApiClient'
import { ApprovalCardView } from '../components/ApprovalCard'
import { ToolItem, TurnSumItem, DeliverableItem, turnSumText } from '../model/TurnItems'
import { t } from '../model/I18n'
import { Theme } from '../theme/Theme'
import { relChipText, addAttachment, modelChipLabel, isCurrentProvider } from '../model/SettingsBiz'

@Component
export struct WorkspacePane {
  @Prop activeId: string
  @State chat: ChatState = AppStore.get().chat
  @State input: string = ''
  @State sending: boolean = false
  @State locale: string = 'zh'
  @State expandedTool: string = ''
  @State model: string = ''
  @State chatProvider: string = ''
  @State providers: ProviderRow[] = []
  @State modelMenuOpen: boolean = false
  @State approvalMode: string = 'ask'
  // @ 引用
  @State atOpen: boolean = false
  @State atQuery: string = ''
  @State atHits: string[] = []
  @State atSearching: boolean = false
  @State atErr: string = ''
  @State attachments: string[] = []
  @StorageProp('chatRev') chatRev: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  @StorageProp('settingsOpen') settingsOpen: boolean = false
  private store: AppStore = AppStore.get()
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.loadState()
    AppStore.get().setListener({
      onChatState: (st: ChatState) => {
        this.chat = st
      },
      onServerState: (st: StateObj | null) => {
        if (st !== null) {
          this.model = st.model
        }
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

  private async loadState(): Promise<void> {
    try {
      const st = await this.store.api().getJson<Object>('/api/state')
      const o = st as Record<string, Object>
      const m = o['model']
      if (typeof m === 'string') {
        this.model = m as string
      }
      const cp = o['chatProvider']
      if (typeof cp === 'string') {
        this.chatProvider = cp as string
      }
      const ap = o['approval']
      if (typeof ap === 'string') {
        this.approvalMode = ap as string
      }
      const pv = o['providers']
      if (pv instanceof Array) {
        const arr = pv as Object[]
        const rows: ProviderRow[] = []
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i] as Record<string, Object>
          const n = p['name']
          if (typeof n === 'string' && n !== '') {
            const mo = p['model']
            rows.push({ name: n as string, model: typeof mo === 'string' ? mo as string : '', purposes: [] } as ProviderRow)
          }
        }
        this.providers = rows
      }
    } catch (e) {
    }
  }

  build() {
    Column({ space: 0 }) {
      this.topbar()
      this.stream()
      this.composer()
    }
    .layoutWeight(1)
    .height('100%')
    .backgroundColor(Theme.bg)
  }

  // ---------- topbar ----------
  @Builder
  topbar() {
    Row({ space: 8 }) {
      Circle({ width: 8, height: 8 })
        .fill(this.sseConnected ? Theme.completed : Theme.failed)
      Text(this.sseConnected ? `${this.L('status.connected')} · ${this.store.serverState?.daemonVersion ?? ''}` : this.L('status.failed'))
        .fontSize(12)
        .fontColor(Theme.dim)
      if (this.store.serverState?.workspace !== null && this.store.serverState?.workspace !== undefined) {
        Text(this.store.serverState.workspace.name)
          .fontSize(12)
          .fontColor(Theme.dim)
          .border({ width: 1, color: Theme.border })
          .borderRadius(999)
          .padding({ left: 10, right: 10, top: 2, bottom: 2 })
      }
      Blank()
      // 模型 pill(点击开菜单)
      Column({ space: 0 }) {
        Text(this.model !== '' ? this.model : this.L('top.model'))
          .fontSize(12)
          .fontColor(Theme.dim)
          .border({ width: 1, color: Theme.border })
          .borderRadius(999)
          .padding({ left: 10, right: 10, top: 2, bottom: 2 })
          .onClick(() => {
            this.modelMenuOpen = !this.modelMenuOpen
          })
        if (this.modelMenuOpen) {
          Column({ space: 2 }) {
            Scroll() {
              Column({ space: 2 }) {
                ForEach(this.providers, (p: ProviderRow) => {
                  Row({ space: 6 }) {
                    Text(isCurrentProvider(p.name, p.model, this.model, this.chatProvider) ? '✓' : ' ')
                      .fontSize(11)
                      .fontColor(Theme.completed)
                    Text(modelChipLabel(p.name, p.model))
                      .fontSize(12)
                      .fontColor(Theme.text)
                      .layoutWeight(1)
                      .maxLines(1)
                  }
                  .width('100%')
                  .padding({ left: 10, right: 10, top: 7, bottom: 7 })
                  .borderRadius(6)
                  .onClick(() => this.doModel(p.name))
                }, (p: ProviderRow) => p.name)
              }
              .width('100%')
            }
            .constraintSize({ maxHeight: 260 })
          }
          .width(260)
          .padding(4)
          .backgroundColor(Theme.raised)
          .border({ width: 1, color: Theme.border })
          .borderRadius(10)
        }
      }
      .width(140)

      Text(`审批:${this.approvalMode}`)
        .fontSize(12)
        .fontColor(Theme.waiting)
      Text('⚙')
        .fontSize(15)
        .fontColor(Theme.dim)
        .padding({ left: 6, right: 6 })
        .onClick(() => {
          this.settingsOpen = true
        })
      Text(this.locale === 'zh' ? '中' : 'EN')
        .fontSize(12)
        .fontColor(Theme.dim)
        .border({ width: 1, color: Theme.border })
        .borderRadius(999)
        .padding({ left: 8, right: 8, top: 2, bottom: 2 })
        .onClick(() => {
          const nl = this.locale === 'zh' ? 'en' : 'zh'
          this.locale = nl
          this.store.saveLocale(nl)
        })
      if (this.chat.running) {
        Button(this.locale === 'en' ? 'Stop' : '停止')
          .fontSize(12)
          .height(28)
          .backgroundColor(Theme.danger)
          .onClick(() => this.doInterrupt())
      }
    }
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    .width('100%')
    .backgroundColor(Theme.raised)
  }

  // ---------- stream ----------
  @Builder
  stream() {
    Scroll(this.scroller) {
      Column({ space: 12 }) {
        if (this.chat.messages.length === 0 && !this.chat.streaming) {
          Text(this.L('stream.emptyNo'))
            .fontSize(15)
            .fontColor(Theme.dim)
            .margin({ top: 80 })
        }
        ForEach(this.chat.messages, (m: ChatMessage, idx: number) => {
          Column({ space: 4 }) {
            Text(m.text)
              .fontSize(14)
              .fontColor(Theme.text)
              .padding({ left: 16, right: 16, top: 12, bottom: 12 })
              .backgroundColor(m.role === 'user' ? Theme.userTurn : Theme.raised)
              .border({ width: 1, color: m.role === 'user' ? Theme.userTurn : Theme.border })
              .borderRadius(10)
              .alignSelf(m.role === 'user' ? ItemAlign.End : ItemAlign.Start)
              .constraintSize({ maxWidth: 760 })
          }
          .width('100%')
        }, (m: ChatMessage, idx: number) => `${idx}`)

        // 工具卡/交付物卡/回合汇总
        ForEach(this.chat.turnItems.items, (it: ToolItem | TurnSumItem | DeliverableItem, idx: number) => {
          Column() {
            if (it instanceof ToolItem) {
              this.toolCard(it as ToolItem)
            } else if (it instanceof DeliverableItem) {
              this.artifactCard(it as DeliverableItem)
            } else if (it instanceof TurnSumItem) {
              Text(turnSumText((it as TurnSumItem).turns, (it as TurnSumItem).toolUses, (it as TurnSumItem).tokens))
                .fontSize(11)
                .fontColor(Theme.dim)
                .alignSelf(ItemAlign.End)
                .padding(2)
            }
          }
          .width('100%')
        }, (it: ToolItem | TurnSumItem | DeliverableItem, idx: number) => `${idx}`)

        // 审批卡
        if (this.chat.approval !== null) {
          ApprovalCardView({
            card: this.chat.approval,
            sessionId: this.activeId,
            onDecision: (granted: boolean) => this.doApprove(granted)
          })
        }

        // 流式缓冲
        if (this.chat.streaming && this.chat.streamBuf !== '') {
          Text(this.chat.streamBuf + '▍')
            .fontSize(14)
            .fontColor(Theme.text)
            .padding({ left: 16, right: 16, top: 12, bottom: 12 })
            .backgroundColor(Theme.raised)
            .border({ width: 1, color: Theme.accent })
            .borderRadius(10)
            .alignSelf(ItemAlign.Start)
            .constraintSize({ maxWidth: 760 })
        }
        if (this.chat.lastError !== '') {
          Text(`⚠ ${this.chat.lastError}`)
            .fontSize(12)
            .fontColor(Theme.danger)
            .width('100%')
        }
      }
      .padding(24)
      .width('100%')
    }
    .layoutWeight(1)
    .width('100%')
    .scrollable(ScrollDirection.Vertical)
    .scrollBar(BarState.On)
  }

  // 工具折叠卡(蓝本 tool-card: mono 字体名+badge+默认折叠)
  @Builder
  toolCard(it: ToolItem) {
    Column({ space: 0 }) {
      Row({ space: 8 }) {
        Text(it.status === 'running' ? '⟳' : (it.status === 'error' ? '✗' : '✓'))
          .fontSize(12)
          .fontColor(it.status === 'running' ? Theme.running : (it.status === 'error' ? Theme.danger : Theme.completed))
        Text(it.name)
          .fontSize(13)
          .fontColor(Theme.text)
          .layoutWeight(1)
          .maxLines(1)
        if (it.status === 'running') {
          Text(this.L('stream.toolRunning'))
            .fontSize(11)
            .fontColor(Theme.dim)
        }
      }
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .width('100%')
      .onClick(() => {
        this.expandedTool = this.expandedTool === it.name ? '' : it.name
      })
      if (this.expandedTool === it.name) {
        Column({ space: 4 }) {
          if (it.argsPreview !== '') {
            Text(it.argsPreview)
              .fontSize(12)
              .fontColor(Theme.dim)
              .fontFamily('monospace')
              .width('100%')
              .maxLines(4)
          }
          if (it.resultPreview !== '') {
            Text(it.resultPreview)
              .fontSize(12)
              .fontColor(Theme.dim)
              .fontFamily('monospace')
              .width('100%')
              .maxLines(10)
          }
        }
        .padding({ left: 12, right: 12, top: 8, bottom: 8 })
        .border({ width: 1, color: Theme.border })
        .width('100%')
      }
    }
    .backgroundColor(Theme.panel)
    .border({ width: 1, color: Theme.border })
    .borderRadius(6)
    .alignSelf(ItemAlign.Start)
    .constraintSize({ maxWidth: 760 })
  }

  // 交付物卡(蓝本 artifact-card: 绿框)
  @Builder
  artifactCard(d: DeliverableItem) {
    Row({ space: 8 }) {
      Text('📦')
        .fontSize(13)
      Text(d.relPath)
        .fontSize(13)
        .fontColor(Theme.text)
        .fontFamily('monospace')
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(this.L('stream.artifactHint').slice(0, 10))
        .fontSize(12)
        .fontColor(Theme.dim)
    }
    .padding({ left: 14, right: 14, top: 8, bottom: 8 })
    .backgroundColor('#15301F')
    .border({ width: 1, color: Theme.completed })
    .borderRadius(6)
    .alignSelf(ItemAlign.Start)
    .constraintSize({ maxWidth: 760 })
  }

  // ---------- composer ----------
  @Builder
  composer() {
    Column({ space: 8 }) {
      // 附件 chips
      if (this.attachments.length > 0) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.attachments, (rel: string) => {
            Row({ space: 6 }) {
              Text('@' + relChipText(rel))
                .fontSize(12)
                .fontColor(Theme.dim)
                .fontFamily('monospace')
                .maxLines(1)
              Text('×')
                .fontSize(11)
                .fontColor(Theme.dim)
                .onClick(() => {
                  const kept: string[] = []
                  for (let i = 0; i < this.attachments.length; i++) {
                    if (this.attachments[i] !== rel) {
                      kept.push(this.attachments[i])
                    }
                  }
                  this.attachments = kept
                })
            }
            .padding({ left: 10, right: 10, top: 3, bottom: 3 })
            .backgroundColor(Theme.panel)
            .border({ width: 1, color: Theme.border })
            .borderRadius(999)
            .margin({ right: 6, bottom: 6 })
          }, (rel: string) => rel)
        }
        .width('100%')
      }

      // @ 搜索弹层
      if (this.atOpen) {
        Column({ space: 6 }) {
          Text(this.locale === 'en' ? 'Reference a workspace file' : '引用工作区文件')
            .fontSize(13)
            .fontColor(Theme.text)
            .width('100%')
          Row({ space: 8 }) {
            TextInput({ placeholder: this.locale === 'en' ? 'search…' : '搜索文件名…' })
              .fontSize(12)
              .fontColor(Theme.text)
              .backgroundColor(Theme.panel)
              .borderRadius(6)
              .height(32)
              .onChange((v: string) => {
                this.atQuery = v
              })
              .layoutWeight(1)
            Button(this.locale === 'en' ? 'Search' : '搜索')
              .fontSize(11)
              .height(32)
              .backgroundColor(Theme.panel)
              .fontColor(Theme.text)
              .enabled(!this.atSearching)
              .onClick(() => this.doAtSearch())
            Button('×')
              .fontSize(11)
              .height(32)
              .width(32)
              .backgroundColor(Theme.panel)
              .fontColor(Theme.dim)
              .onClick(() => {
                this.atOpen = false
                this.atHits = []
              })
          }
          .width('100%')
          if (this.atErr !== '') {
            Text(this.atErr).fontSize(11).fontColor(Theme.danger).width('100%')
          }
          if (this.atHits.length > 0) {
            Scroll() {
              Column({ space: 4 }) {
                ForEach(this.atHits, (rel: string) => {
                  Text(rel)
                    .fontSize(12)
                    .fontColor(Theme.text)
                    .fontFamily('monospace')
                    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                    .backgroundColor(this.attachments.indexOf(rel) >= 0 ? Theme.userTurn : Theme.panel)
                    .borderRadius(6)
                    .width('100%')
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .onClick(() => {
                      this.attachments = addAttachment(this.attachments, rel)
                    })
                }, (rel: string) => rel)
              }
              .width('100%')
            }
            .height(160)
            .width('100%')
          }
        }
        .padding(10)
        .backgroundColor(Theme.raised)
        .border({ width: 1, color: Theme.border })
        .borderRadius(10)
        .width('100%')
      }

      // 输入行(composer-row: @ | textarea | 发送)
      Row({ space: 8 }) {
        Button('@')
          .fontSize(14)
          .fontColor(Theme.dim)
          .backgroundColor(Theme.panel)
          .borderRadius(6)
          .height(44)
          .width(36)
          .onClick(() => {
            this.atOpen = !this.atOpen
          })
        TextArea({ text: this.input, placeholder: this.chat.running ? this.L('comp.phBusy') : this.L('comp.phEnter') })
          .fontSize(14)
          .fontColor(Theme.text)
          .placeholderColor(Theme.dim)
          .backgroundColor(Theme.panel)
          .border({ width: 1, color: Theme.border })
          .borderRadius(10)
          .constraintSize({ minHeight: 44, maxHeight: 120 })
          .onChange((v: string) => {
            this.input = v
          })
          .layoutWeight(1)
        Button(this.chat.running ? this.L('comp.inject') : this.L('comp.send'))
          .fontSize(14)
          .fontColor('#FFFFFF')
          .backgroundColor(Theme.accent)
          .borderRadius(6)
          .height(44)
          .enabled(this.input !== '' && !this.sending)
          .onClick(() => this.doSend())
      }
      .width('100%')
      .alignItems(VerticalAlign.Bottom)
    }
    .padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .width('100%')
    .backgroundColor(Theme.raised)
  }

  // ---------- 动作 ----------
  private async doModel(name: string): Promise<void> {
    try {
      const reqBody: ModelReq = { name: name }
      const resp = await this.store.api().postJson<Object>('/api/model', reqBody)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        const m = o['model']
        if (typeof m === 'string') {
          this.model = m as string
        }
        this.chatProvider = name
      }
      this.modelMenuOpen = false
    } catch (e) {
      this.modelMenuOpen = false
    }
  }

  private async doAtSearch(): Promise<void> {
    const q = this.atQuery.trim()
    if (q === '') {
      this.atErr = this.locale === 'en' ? 'type a keyword' : '输入关键词'
      return
    }
    this.atSearching = true
    this.atErr = ''
    this.atHits = []
    try {
      const resp = await this.store.api().getJson<Object>(`/api/fs/search?q=${encodeURIComponent(q)}`)
      const o = resp as Record<string, Object>
      const res = o['results']
      if (res instanceof Array) {
        const hits: string[] = []
        const arr = res as Object[]
        for (let i = 0; i < arr.length; i++) {
          const h = arr[i] as Record<string, Object>
          const rel = h['rel']
          if (typeof rel === 'string' && rel !== '') {
            hits.push(rel as string)
          }
        }
        this.atHits = hits
        if (hits.length === 0) {
          this.atErr = this.locale === 'en' ? 'no matches' : '无匹配'
        }
      }
    } catch (e) {
      this.atErr = this.errText(e)
    }
    this.atSearching = false
  }

  private async doSend(): Promise<void> {
    const text = this.input
    if (text === '') {
      return
    }
    this.sending = true
    const body: TaskReq = { text: text, mode: this.approvalMode === 'auto' ? 'auto' : 'ask' }
    if (this.activeId !== '') {
      body.sessionId = this.activeId
    }
    if (this.attachments.length > 0) {
      body.attachments = this.attachments.slice()
    }
    try {
      const resp = await this.store.api().postJson<Object>('/api/task', body)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        this.input = ''
        this.attachments = []
        this.atOpen = false
      }
    } catch (e) {
      this.chat.lastError = this.errText(e)
    }
    this.sending = false
  }

  private async doInterrupt(): Promise<void> {
    try {
      const req: SimpleSidReq = { sessionId: this.activeId }
      await this.store.api().postJson<Object>('/api/interrupt', req)
    } catch (e) {
    }
  }

  private async doApprove(granted: boolean): Promise<void> {
    try {
      const req: ApproveReq = { granted: granted, sessionId: this.chat.approval?.sessionId ?? '' }
      await this.store.api().postJson<Object>('/api/approve', req)
    } catch (e) {
    }
  }

  private errText(e: object): string {
    const err = e instanceof ApiError ? e as ApiError : toApiError(e)
    if (err.code === 'auth-required') {
      return '令牌无效 (403)'
    }
    if (err.status === 0) {
      return '网络不可达'
    }
    return `HTTP ${err.status}: ${err.message}`
  }
}

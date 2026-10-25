/**
 * v2 会话页:分组列表(pin/过滤/折叠/加载更多/管理) + 聊天流(turn-items 卡片)
 */
import { AppStore } from '../model/AppStore'
import { guardSessionsResp } from '../model/Guards'
import { SessionInfo, ChatState, ChatMessage, TaskReq, SimpleSidReq, ApproveReq, StateObj } from '../model/Types'
import { ApiError, toApiError } from '../net/ApiClient'
import { ApprovalCardView } from '../components/ApprovalCard'
import { SessionRow, SessionGroup, applyFilter, groupByWorkspace, toggleGroup, wsGroupLabel } from '../model/SessionList'
import { ToolItem, TurnSumItem, DeliverableItem, turnSumText } from '../model/TurnItems'
import { t, Locale } from '../model/I18n'
import { relChipText, addAttachment } from '../model/SettingsBiz'
import { FsSearchResp } from '../model/Types'
import { photoAccessHelper } from '@kit.MediaLibraryKit'
import { fileIo } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'

@Component
export struct SessionsPage {
  @State sessions: SessionInfo[] = []
  @State loading: boolean = false
  @State errMsg: string = ''
  @State activeId: string = ''
  @State inChat: boolean = false
  @State chat: ChatState = AppStore.get().chat
  @State input: string = ''
  @State sending: boolean = false
  @State filter: string = 'all'
  @State pinned: Set<string> = new Set<string>()
  @State collapsed: Set<string> = new Set<string>()
  @State nextCursor: string = ''
  @State locale: string = 'zh'
  @State expandedTool: string = ''
  // #11 @文件引用
  @State atOpen: boolean = false
  @State atQuery: string = ''
  @State atHits: string[] = []       // rel 列表(渲染用)
  @State atSearching: boolean = false
  @State atErr: string = ''
  @State attachments: string[] = []  // 已选 rel(随任务 POST)
  // #10 相册附件
  @State images: string[] = []       // base64(≤3 张,≤6MB/张)
  @State imgMsg: string = ''
  @StorageProp('chatRev') chatRev: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  private store: AppStore = AppStore.get()
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.pinned = new Set<string>(this.store.pinned)
    this.collapsed = new Set<string>(this.store.collapsedGroups)
    this.refresh()
    AppStore.get().setListener({
      onChatState: (st: ChatState) => {
        this.chat = st
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

  private buildRows(): SessionRow[] {
    const rows: SessionRow[] = []
    const busy = this.store.serverState?.busySessions ?? []
    for (let i = 0; i < this.sessions.length; i++) {
      const s = this.sessions[i]
      const r = new SessionRow()
      r.id = s.id
      r.title = s.title !== '' ? s.title : (s.task !== '' ? s.task.slice(0, 40) : s.id.slice(0, 12))
      r.task = s.task
      r.outcome = s.outcome
      r.workspace = s.cwd
      r.running = busy.indexOf(s.id) >= 0
      r.turns = s.turns
      r.toolUses = s.toolUses
      r.pinned = this.pinned.has(s.id)
      r.updatedAt = s.updatedAt
      rows.push(r)
    }
    return rows
  }

  build() {
    if (!this.inChat) {
      this.listBody()
    } else {
      this.chatBody()
    }
  }

  // ---------- 会话列表 ----------
  @Builder
  listBody() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Text(this.L('dock.ws') === 'Workspace' ? 'Sessions' : '会话')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button(this.L('side.new'))
          .fontSize(13)
          .height(34)
          .onClick(() => this.openSession(''))
      }
      .width('100%')

      // 过滤条
      Row({ space: 6 }) {
        ForEach(['all', 'running', 'done', 'failed'], (f: string) => {
          Text(this.filterLabel(f))
            .fontSize(12)
            .padding({ left: 10, right: 10, top: 5, bottom: 5 })
            .backgroundColor(this.filter === f ? '#1565C0' : '#E8EAED')
            .fontColor(this.filter === f ? '#FFFFFF' : '#444444')
            .borderRadius(14)
            .onClick(() => {
              this.filter = f
            })
        }, (f: string) => f)
      }
      .width('100%')

      if (this.loading) {
        LoadingProgress().width(24).height(24)
      }
      if (this.errMsg !== '') {
        Text(this.errMsg).fontSize(12).fontColor('#C0392B')
      }

      Scroll(this.scroller) {
        Column({ space: 8 }) {
          ForEach(this.groups(), (g: SessionGroup) => {
            Column({ space: 6 }) {
              // 组头
              Row({ space: 6 }) {
                Text(g.collapsed ? '▸' : '▾')
                  .fontSize(14)
                  .fontColor('#666666')
                Text(wsGroupLabel(g.workspace, g.rows.length))
                  .fontSize(13)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#555555')
                  .layoutWeight(1)
              }
              .width('100%')
              .onClick(() => {
                this.collapsed = toggleGroup(this.collapsed, g.workspace)
                this.store.collapsedGroups = this.collapsed
              })
              if (!g.collapsed) {
                ForEach(g.rows, (s: SessionRow) => {
                  this.sessionCard(s)
                }, (s: SessionRow) => s.id)
              }
            }
            .width('100%')
          }, (g: SessionGroup) => g.workspace + g.rows.length)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')

      if (this.nextCursor !== '') {
        Button(this.L('side.loadMore'))
          .fontSize(13)
          .height(36)
          .width('100%')
          .onClick(() => this.loadMore())
      }
    }
    .padding(14)
    .width('100%')
    .height('100%')
  }

  @Builder
  sessionCard(s: SessionRow) {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        Text(s.pinned ? '★' : '☆')
          .fontSize(16)
          .fontColor(s.pinned ? '#F5A623' : '#BBBBBB')
          .onClick(() => this.togglePin(s.id))
        Column({ space: 2 }) {
          Text(s.title)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Row({ space: 6 }) {
            Text(`${s.turns} 轮 · ${s.toolUses} 工具`)
              .fontSize(10)
              .fontColor('#999999')
            if (s.running) {
              Text(this.L('status.running'))
                .fontSize(10)
                .fontColor('#1565C0')
            } else if (s.outcome === 'error') {
              Text(this.L('status.failed'))
                .fontSize(10)
                .fontColor('#C0392B')
            } else if (s.outcome === 'ok') {
              Text('✓')
                .fontSize(10)
                .fontColor('#0A7D32')
            }
          }
          .width('100%')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      Row({ space: 10 }) {
        Text(s.updatedAt !== '' ? s.updatedAt.slice(0, 16).replace('T', ' ') : '')
          .fontSize(10)
          .fontColor('#999999')
          .layoutWeight(1)
        Text(this.L('side.archive'))
          .fontSize(10)
          .fontColor('#1565C0')
          .onClick(() => this.doOp(s.id, 'archive'))
        Text(this.L('side.delete'))
          .fontSize(10)
          .fontColor('#C0392B')
          .onClick(() => this.doOp(s.id, 'delete'))
      }
      .width('100%')
    }
    .padding(10)
    .backgroundColor('#FFFFFF')
    .borderRadius(10)
    .width('100%')
    .onClick(() => this.openSession(s.id))
  }

  // ---------- 聊天 ----------
  @Builder
  chatBody() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('←')
          .fontSize(15)
          .height(34)
          .width(40)
          .onClick(() => this.closeSession())
        Column({ space: 2 }) {
          Text(this.activeId === '' ? this.L('side.new') : this.activeId.slice(0, 14))
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
          Row({ space: 6 }) {
            Circle({ width: 7, height: 7 })
              .fill(this.sseConnected ? '#0A7D32' : '#C0392B')
            Text(this.sseConnected ? (this.chat.running ? this.L('status.running') : this.L('status.connected')) : '...')
              .fontSize(10)
              .fontColor('#888888')
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.chat.running) {
          Button(this.L('stream.taskFailed') === 'Task failed' ? 'Interrupt' : '打断')
            .fontSize(12)
            .height(32)
            .backgroundColor('#C0392B')
            .onClick(() => this.doInterrupt())
        }
      }
      .width('100%')

      List({ space: 8, scroller: this.scroller }) {
        ListItem() {
          Column({ space: 6 }) {
            ForEach(this.chat.messages, (m: ChatMessage, idx: number) => {
              Column({ space: 3 }) {
                Text(m.role === 'user' ? '我' : 'AI')
                  .fontSize(10)
                  .fontColor(m.role === 'user' ? '#1565C0' : '#0A7D32')
                  .alignSelf(m.role === 'user' ? ItemAlign.End : ItemAlign.Start)
                Text(m.text)
                  .fontSize(13)
                  .padding(8)
                  .backgroundColor(m.role === 'user' ? '#E3F2FD' : '#F1F8E9')
                  .borderRadius(8)
                  .alignSelf(m.role === 'user' ? ItemAlign.End : ItemAlign.Start)
                  .constraintSize({ maxWidth: '85%' })
              }
              .width('100%')
            }, (m: ChatMessage, idx: number) => `${idx}`)

            // 工具卡/交付物卡/回合汇总(turn-items)
            ForEach(this.chat.turnItems.items, (it: ToolItem | TurnSumItem | DeliverableItem, idx: number) => {
              Column() {
                if (it instanceof ToolItem) {
                  this.toolCard(it)
                } else if (it instanceof DeliverableItem) {
                  this.deliverableCard(it)
                } else if (it instanceof TurnSumItem) {
                  Text(turnSumText((it as TurnSumItem).turns, (it as TurnSumItem).toolUses, (it as TurnSumItem).tokens))
                    .fontSize(11)
                    .fontColor('#888888')
                    .padding({ top: 4, bottom: 4 })
                }
              }
              .width('100%')
            }, (it: ToolItem | TurnSumItem | DeliverableItem, idx: number) => `${idx}`)

            if (this.chat.streaming && this.chat.streamBuf !== '') {
              Text(this.chat.streamBuf)
                .fontSize(13)
                .padding(8)
                .backgroundColor('#F1F8E9')
                .borderRadius(8)
                .alignSelf(ItemAlign.Start)
                .constraintSize({ maxWidth: '85%' })
            }
            if (this.chat.lastError !== '') {
              Text(`⚠ ${this.chat.lastError}`)
                .fontSize(12)
                .fontColor('#C0392B')
                .width('100%')
            }
          }
          .width('100%')
        }
      }
      .layoutWeight(1)
      .width('100%')

      if (this.chat.approval !== null) {
        ApprovalCardView({
          card: this.chat.approval,
          sessionId: this.activeId,
          onDecision: (granted: boolean) => this.doApprove(granted)
        })
      }

      // #11 已选附件 chips
      if (this.attachments.length > 0) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.attachments, (rel: string) => {
            Row({ space: 4 }) {
              Text('@' + relChipText(rel))
                .fontSize(11)
                .fontColor('#1565C0')
                .maxLines(1)
              Text('×')
                .fontSize(11)
                .fontColor('#999999')
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
            .padding({ left: 8, right: 8, top: 4, bottom: 4 })
            .backgroundColor('#E3F2FD')
            .borderRadius(10)
            .margin({ right: 6, bottom: 6 })
          }, (rel: string) => rel)
        }
        .width('100%')
      }

      // #11 @引用搜索弹层
      if (this.atOpen) {
        Column({ space: 8 }) {
          Text(this.locale === 'en' ? 'Reference a workspace file' : '引用工作区文件')
            .fontSize(14)
            .fontWeight(FontWeight.Bold)
            .width('100%')
          Row({ space: 8 }) {
            TextInput({ placeholder: this.locale === 'en' ? 'search files…' : '搜索文件名…' })
              .onChange((v: string) => {
                this.atQuery = v
              })
              .layoutWeight(1)
            Button(this.locale === 'en' ? 'Search' : '搜索')
              .fontSize(12)
              .height(36)
              .enabled(!this.atSearching)
              .onClick(() => this.doAtSearch())
            Button('×')
              .fontSize(12)
              .height(36)
              .width(36)
              .backgroundColor('#888888')
              .onClick(() => {
                this.atOpen = false
                this.atHits = []
                this.atErr = ''
              })
          }
          .width('100%')
          if (this.atErr !== '') {
            Text(this.atErr).fontSize(11).fontColor('#C0392B').width('100%')
          }
          if (this.atSearching) {
            LoadingProgress().width(20).height(20)
          }
          if (this.atHits.length > 0) {
            Scroll() {
              Column({ space: 4 }) {
                ForEach(this.atHits, (rel: string) => {
                  Text(rel)
                    .fontSize(12)
                    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
                    .backgroundColor(this.attachments.indexOf(rel) >= 0 ? '#BBDEFB' : '#F5F5F5')
                    .borderRadius(8)
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
            .height(180)
            .width('100%')
          }
        }
        .padding(10)
        .backgroundColor('#FFFFFF')
        .borderRadius(10)
        .border({ width: 1, color: '#D0D0D0' })
        .width('100%')
      }

      Row({ space: 8 }) {
        Button('@')
          .fontSize(14)
          .height(38)
          .width(38)
          .backgroundColor('#455A64')
          .onClick(() => {
            this.atOpen = !this.atOpen
          })
        Button('📷' + (this.images.length > 0 ? `${this.images.length}` : ''))
          .fontSize(13)
          .height(38)
          .width(44)
          .backgroundColor('#6A4C93')
          .onClick(() => this.pickImages())
        TextInput({ text: this.input, placeholder: this.L('comp.phEnter') })
          .onChange((v: string) => {
            this.input = v
          })
          .layoutWeight(1)
          .enabled(!this.sending)
        Button(this.chat.running ? this.L('comp.inject') : this.L('comp.send'))
          .height(38)
          .enabled(this.input !== '' && !this.sending)
          .onClick(() => this.doSend())
      }
      .width('100%')
    }
    .padding(12)
    .width('100%')
    .height('100%')
  }

  @Builder
  toolCard(it: ToolItem) {
    Column({ space: 3 }) {
      Row({ space: 6 }) {
        Text(it.status === 'running' ? '⟳' : (it.status === 'error' ? '✗' : '✓'))
          .fontSize(12)
          .fontColor(it.status === 'running' ? '#1565C0' : (it.status === 'error' ? '#C0392B' : '#0A7D32'))
        Text(it.name)
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .maxLines(1)
        if (it.status === 'running') {
          Text(this.L('stream.toolRunning'))
            .fontSize(10)
            .fontColor('#1565C0')
        }
      }
      .width('100%')
      .onClick(() => {
        this.expandedTool = this.expandedTool === it.name ? '' : it.name
      })
      if (this.expandedTool === it.name) {
        if (it.argsPreview !== '') {
          Text(it.argsPreview)
            .fontSize(10)
            .fontColor('#666666')
            .width('100%')
            .maxLines(3)
        }
        if (it.resultPreview !== '') {
          Text(it.resultPreview)
            .fontSize(10)
            .fontColor('#444444')
            .width('100%')
            .maxLines(6)
        }
      }
    }
    .padding(8)
    .backgroundColor('#F5F5F5')
    .borderRadius(8)
    .width('100%')
    .alignSelf(ItemAlign.Start)
    .constraintSize({ maxWidth: '85%' })
  }

  @Builder
  deliverableCard(d: DeliverableItem) {
    Row({ space: 6 }) {
      Text('📦')
        .fontSize(12)
      Text(d.relPath)
        .fontSize(11)
        .fontColor('#0A7D32')
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(d.tool)
        .fontSize(9)
        .fontColor('#999999')
    }
    .padding(8)
    .backgroundColor('#E8F5E9')
    .borderRadius(8)
    .width('100%')
    .alignSelf(ItemAlign.Start)
    .constraintSize({ maxWidth: '85%' })
  }

  // ---------- 动作 ----------
  private filterLabel(f: string): string {
    if (f === 'running') {
      return this.L('side.filterRunning')
    }
    if (f === 'done') {
      return this.L('side.filterDone')
    }
    if (f === 'failed') {
      return this.L('side.filterFailed')
    }
    return this.L('side.filterAll')
  }

  private groups(): SessionGroup[] {
    const rows = applyFilter(this.buildRows(), this.filter === 'running' ? 'running' : (this.filter === 'done' ? 'done' : (this.filter === 'failed' ? 'failed' : 'all')))
    return groupByWorkspace(rows, this.collapsed)
  }

  private togglePin(id: string): void {
    const n = new Set<string>(this.pinned)
    if (n.has(id)) {
      n.delete(id)
    } else {
      n.add(id)
    }
    this.pinned = n
    this.store.pinned = n
  }

  private async refresh(): Promise<void> {
    this.loading = true
    this.errMsg = ''
    try {
      const resp = await this.store.api().getJson<Object>('/api/sessions?limit=50')
      const g = guardSessionsResp(resp)
      this.sessions = g.sessions
      this.nextCursor = g.nextCursor
      if (g.sessions.length === 0) {
        this.errMsg = this.L('side.empty')
      }
    } catch (e) {
      this.errMsg = this.errText(e)
    }
    this.loading = false
  }

  private async loadMore(): Promise<void> {
    if (this.nextCursor === '') {
      return
    }
    try {
      const resp = await this.store.api().getJson<Object>(`/api/sessions?limit=50&cursor=${encodeURIComponent(this.nextCursor)}`)
      const g = guardSessionsResp(resp)
      const merged = this.sessions.slice()
      for (let i = 0; i < g.sessions.length; i++) {
        merged.push(g.sessions[i])
      }
      this.sessions = merged
      this.nextCursor = g.nextCursor
    } catch (e) {
      this.errMsg = this.errText(e)
    }
  }

  private async doOp(id: string, op: string): Promise<void> {
    try {
      await this.store.api().postJson<Object>(`/api/sessions/${encodeURIComponent(id)}/${op}`, null)
      const kept: SessionInfo[] = []
      for (let i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].id !== id) {
          kept.push(this.sessions[i])
        }
      }
      this.sessions = kept
    } catch (e) {
      this.errMsg = this.errText(e)
    }
  }

  private openSession(id: string): void {
    this.activeId = id
    this.inChat = true
    this.store.startSse(id)
  }

  private closeSession(): void {
    this.store.stopSse()
    this.activeId = ''
    this.inChat = false
  }

  // #11:GET /api/fs/search?q= → rel 列表
  private async doAtSearch(): Promise<void> {
    const q = this.atQuery.trim()
    if (q === '') {
      this.atErr = this.locale === 'en' ? 'type a keyword first' : '请先输入关键词'
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
          this.atErr = this.locale === 'en' ? 'no matches' : '无匹配文件'
        }
      }
    } catch (e) {
      this.atErr = this.errText(e)
    }
    this.atSearching = false
  }

  // #10:PhotoViewPicker ≤3 张 → base64(≤6MB/张)
  private async pickImages(): Promise<void> {
    this.imgMsg = ''
    try {
      const picker = new photoAccessHelper.PhotoViewPicker()
      const res = await picker.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 3
      } as photoAccessHelper.PhotoSelectOptions)
      if (res.photoUris.length === 0) {
        return
      }
      const b64: string[] = []
      for (let i = 0; i < res.photoUris.length; i++) {
        const uri = res.photoUris[i]
        const src = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY)
        try {
          const stat = fileIo.statSync(src.fd)
          if (stat.size > 6 * 1024 * 1024) {
            this.imgMsg = `第${i + 1}张超过 6MB,已跳过`
            continue
          }
          const buf = new ArrayBuffer(stat.size)
          fileIo.readSync(src.fd, buf)
          const helper = new util.Base64Helper()
          b64.push(helper.encodeToStringSync(new Uint8Array(buf)))
        } finally {
          fileIo.closeSync(src)
        }
      }
      this.images = b64
    } catch (e) {
      this.imgMsg = '选择图片失败(模拟器可能无相册)'
    }
  }

  private async doSend(): Promise<void> {
    const text = this.input
    if (text === '') {
      return
    }
    this.sending = true
    const body: TaskReq = { text: text, mode: 'ask' }
    if (this.activeId !== '') {
      body.sessionId = this.activeId
    }
    if (this.attachments.length > 0) {
      body.attachments = this.attachments.slice()
    }
    if (this.images.length > 0) {
      body.images = this.images.slice()
    }
    try {
      const resp = await this.store.api().postJson<Object>('/api/task', body)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        this.input = ''
        this.attachments = []
        this.images = []
        this.atOpen = false
        const sid = typeof o['sessionId'] === 'string' ? o['sessionId'] as string : ''
        if (sid !== '' && this.activeId === '') {
          this.activeId = sid
        }
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
      this.chat.lastError = this.errText(e)
    }
  }

  private async doApprove(granted: boolean): Promise<void> {
    try {
      const req: ApproveReq = { granted: granted, sessionId: this.chat.approval?.sessionId ?? '' }
      await this.store.api().postJson<Object>('/api/approve', req)
    } catch (e) {
      this.chat.lastError = this.errText(e)
    }
  }

  private errText(e: object): string {
    const err = e instanceof ApiError ? e as ApiError : toApiError(e)
    if (err.code === 'auth-required') {
      return '令牌无效 (403),请到设置页核对'
    }
    if (err.status === 0) {
      return '网络不可达,检查服务器地址与 hmh web 是否在线'
    }
    return `HTTP ${err.status}: ${err.message}`
  }
}

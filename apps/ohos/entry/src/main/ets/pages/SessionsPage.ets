/**
 * M-O2 会话纵切片:会话列表(历史) + 进入会话(SSE 订阅 + 发送 + 流式渲染 + 审批卡 + 打断)
 */
import { AppStore } from '../model/AppStore'
import { guardSessionsResp } from '../model/Guards'
import { SessionInfo, ChatState, ChatMessage, TaskReq, SimpleSidReq, ApproveReq } from '../model/Types'
import { ApiError, toApiError } from '../net/ApiClient'
import { ApprovalCardView } from '../components/ApprovalCard'

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
  @StorageProp('chatRev') chatRev: number = 0
  @StorageProp('sseConnected') sseConnected: boolean = false
  private store: AppStore = AppStore.get()
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    this.refresh()
    // 订阅 store 的 chat 状态变化(reduce 后的权威快照)
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
    Column({ space: 12 }) {
      Row({ space: 12 }) {
        Text('会话')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button('刷新')
          .fontSize(13)
          .height(36)
          .onClick(() => this.refresh())
      }
      .width('100%')

      if (this.loading) {
        LoadingProgress().width(28).height(28)
        Text('加载中...').fontSize(13).fontColor('#888888')
      }
      if (this.errMsg !== '') {
        Text(this.errMsg).fontSize(13).fontColor('#C0392B')
      }

      Scroll(this.scroller) {
        Column({ space: 10 }) {
          ForEach(this.sessions, (s: SessionInfo) => {
            Column({ space: 4 }) {
              Row({ space: 8 }) {
                Text(s.title)
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(`${s.turns} 轮 · ${s.toolUses} 工具`)
                  .fontSize(11)
                  .fontColor('#999999')
              }
              .width('100%')
              Row({ space: 8 }) {
                Text(s.updatedAt !== '' ? s.updatedAt.slice(0, 19) : s.id.slice(0, 12))
                  .fontSize(11)
                  .fontColor('#999999')
                if (s.outcome !== '') {
                  Text(s.outcome === 'ok' ? '✓ ok' : s.outcome)
                    .fontSize(11)
                    .fontColor(s.outcome === 'ok' ? '#0A7D32' : '#B26A00')
                }
              }
              .width('100%')
            }
            .padding(12)
            .backgroundColor('#FFFFFF')
            .borderRadius(12)
            .width('100%')
            .onClick(() => this.openSession(s.id))
          }, (s: SessionInfo) => s.id)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')

      Button('新建会话')
        .width('100%')
        .height(44)
        .onClick(() => this.openSession(''))
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  // ---------- 会话聊天 ----------
  @Builder
  chatBody() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('←')
          .fontSize(16)
          .height(36)
          .width(44)
          .onClick(() => this.closeSession())
        Column({ space: 2 }) {
          Text(this.activeId === '' ? '新会话' : this.activeId.slice(0, 14))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
          Row({ space: 6 }) {
            Circle({ width: 8, height: 8 })
              .fill(this.sseConnected ? '#0A7D32' : '#C0392B')
            Text(this.sseConnected ? (this.chat.running ? '运行中' : '已连接') : '连接中...')
              .fontSize(11)
              .fontColor('#888888')
            if (this.chat.queuePosition > 0) {
              Text(`排队 #${this.chat.queuePosition}`).fontSize(11).fontColor('#B26A00')
            }
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        if (this.chat.running) {
          Button('打断')
            .fontSize(13)
            .height(36)
            .backgroundColor('#C0392B')
            .onClick(() => this.doInterrupt())
        }
      }
      .width('100%')

      // 消息流
      List({ space: 10, scroller: this.scroller }) {
        ListItem() {
          Column({ space: 4 }) {
            ForEach(this.chat.messages, (m: ChatMessage, idx: number) => {
              Column({ space: 4 }) {
                Text(m.role === 'user' ? '我' : 'AI')
                  .fontSize(11)
                  .fontColor(m.role === 'user' ? '#1565C0' : '#0A7D32')
                  .alignSelf(m.role === 'user' ? ItemAlign.End : ItemAlign.Start)
                Text(m.text)
                  .fontSize(14)
                  .padding(10)
                  .backgroundColor(m.role === 'user' ? '#E3F2FD' : '#F1F8E9')
                  .borderRadius(10)
                  .alignSelf(m.role === 'user' ? ItemAlign.End : ItemAlign.Start)
                  .constraintSize({ maxWidth: '85%' })
              }
              .width('100%')
            }, (m: ChatMessage, idx: number) => `${idx}`)
            // 流式缓冲
            if (this.chat.streaming && this.chat.streamBuf !== '') {
              Text(this.chat.streamBuf)
                .fontSize(14)
                .padding(10)
                .backgroundColor('#F1F8E9')
                .borderRadius(10)
                .alignSelf(ItemAlign.Start)
                .constraintSize({ maxWidth: '85%' })
            }
            if (this.chat.lastError !== '') {
              Text(`⚠ ${this.chat.lastError}`)
                .fontSize(13)
                .fontColor('#C0392B')
                .width('100%')
            }
          }
          .width('100%')
        }
      }
      .layoutWeight(1)
      .width('100%')

      // 审批卡
      if (this.chat.approval !== null) {
        ApprovalCardView({
          card: this.chat.approval,
          sessionId: this.activeId,
          onDecision: (granted: boolean) => this.doApprove(granted)
        })
      }

      // 输入区
      Row({ space: 8 }) {
        TextInput({ text: this.input, placeholder: '输入任务...' })
          .onChange((v: string) => {
            this.input = v
          })
          .layoutWeight(1)
          .enabled(!this.sending)
        Button(this.chat.running ? '注入' : '发送')
          .height(40)
          .enabled(this.input !== '' && !this.sending)
          .onClick(() => this.doSend())
      }
      .width('100%')
    }
    .padding(12)
    .width('100%')
    .height('100%')
  }

  // ---------- 动作 ----------
  private async refresh(): Promise<void> {
    this.loading = true
    this.errMsg = ''
    try {
      const resp = await this.store.api().getJson<Object>('/api/sessions?limit=100')
      const g = guardSessionsResp(resp)
      this.sessions = g.sessions
      if (g.sessions.length === 0) {
        this.errMsg = '(暂无历史会话,点「新建会话」开始)'
      }
    } catch (e) {
      this.errMsg = this.errText(e)
    }
    this.loading = false
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
    try {
      const resp = await this.store.api().postJson<Object>('/api/task', body)
      const o = resp as Record<string, Object>
      if (o['ok'] === true) {
        this.input = ''
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

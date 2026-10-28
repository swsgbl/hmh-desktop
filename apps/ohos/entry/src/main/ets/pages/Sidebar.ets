/**
 * v3 左栏 Sidebar(264px,1:1 复刻 .sidebar):
 *   sidebar-head(新建会话▾ / 搜索 / 状态过滤)
 *   workspace-bar(工作区切换条)
 *   session-list(工作区分组 ▸ 组头+会话行+★收藏+运行点)
 * 数据与逻辑全部复用 v2 SessionsPage 的 listBody(搬运,不删逻辑)
 */
import { AppStore } from '../model/AppStore'
import { guardSessionsResp } from '../model/Guards'
import { SessionInfo, WorkspacesResp, WorkspaceInfo, WsUseReq } from '../model/Types'
import { SessionRow, SessionGroup, applyFilter, groupByWorkspace, toggleGroup, wsGroupLabel } from '../model/SessionList'
import { t } from '../model/I18n'
import { Th, Metrics } from '../theme/Theme'
import { ApiError, toApiError } from '../net/ApiClient'

@Component
export struct Sidebar {
  @Link activeId: string
  @State sessions: SessionInfo[] = []
  @State loading: boolean = false
  @State errMsg: string = ''
  @State filter: string = 'all'
  @State pinned: Set<string> = new Set<string>()
  @State collapsed: Set<string> = new Set<string>()
  @State nextCursor: string = ''
  @State locale: string = 'zh'
  @State search: string = ''
  @State wsData: WorkspacesResp = { current: '', items: [] } as WorkspacesResp
  @State wsMenuOpen: boolean = false
  @StorageProp('localeRev') localeRev: number = 0
  private store: AppStore = AppStore.get()
  private scroller: Scroller = new Scroller()

  aboutToAppear(): void {
    this.locale = this.store.locale
    this.pinned = new Set<string>(this.store.pinned)
    this.collapsed = new Set<string>(this.store.collapsedGroups)
    this.refresh()
    this.refreshWs()
  }

  private L(key: string): string {
    return t(key, this.locale === 'en' ? 'en' : 'zh')
  }

  build() {
    Column({ space: 0 }) {
      // ---- sidebar-head: 新建会话▾ / 搜索 / 状态过滤 ----
      Column({ space: 8 }) {
        Row({ space: 4 }) {
          Button(this.L('side.new'))
            .fontSize(13)
            .fontColor(Th.c.text)
            .backgroundColor(Th.c.l1)
            .borderRadius(6)
            .height(32)
            .layoutWeight(1)
            .onClick(() => this.openSession(''))
          Text('▾')
            .fontSize(12)
            .fontColor(Th.c.text3)
            .padding(4)
            .onClick(() => {
              this.openSession('', true)
            })
        }
        .width('100%')

        TextInput({ placeholder: this.L('side.search') })
          .fontSize(13)
          .fontColor(Th.c.text)
          .placeholderColor(Th.c.text3)
          .backgroundColor(Th.c.l1)
          .border({ width: 1, color: Th.c.border2 })
          .borderRadius(6)
          .padding({ left: 10, right: 10 })
          .height(32)
          .onChange((v: string) => {
            this.search = v
          })
          .width('100%')

        // 状态过滤(蓝本 status-filter: select 样式)
        Row({ space: 6 }) {
          ForEach(['all', 'running', 'done', 'failed'], (f: string) => {
            Text(this.filterLabel(f))
              .fontSize(12)
              .padding({ left: 8, right: 8, top: 4, bottom: 4 })
              .backgroundColor(this.filter === f ? Th.c.brand : Th.c.l1)
              .fontColor(this.filter === f ? '#FFFFFF' : Th.c.text3)
              .borderRadius(6)
              .onClick(() => {
                this.filter = f
              })
          }, (f: string) => f)
        }
        .width('100%')
      }
      .padding(12)
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      // ---- workspace-bar ----
      Row({ space: 8 }) {
        Text('工作区')
          .fontSize(11)
          .fontColor(Th.c.text3)
        Text(this.currentWsName())
          .fontSize(13)
          .fontColor(Th.c.text)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('▾')
          .fontSize(12)
          .fontColor(Th.c.text3)
      }
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .width('100%')
      .backgroundColor(Th.c.l2)
      .border({ width: 1, color: Th.c.border2 })
      .onClick(() => {
        this.wsMenuOpen = !this.wsMenuOpen
      })

      // ---- ws-menu(工作区下拉) ----
      if (this.wsMenuOpen) {
        Column({ space: 2 }) {
          ForEach(this.wsData.items, (w: WorkspaceInfo) => {
            Row({ space: 6 }) {
              Text(w.id === this.wsData.current ? '✓' : ' ')
                .fontSize(11)
                .fontColor(Th.c.completed)
              Column({ space: 2 }) {
                Text(w.name)
                  .fontSize(13)
                  .fontColor(w.id === this.wsData.current ? Th.c.text : Th.c.text3)
                Text(w.path)
                  .fontSize(11)
                  .fontColor(Th.c.text3)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
            }
            .padding({ left: 10, right: 10, top: 8, bottom: 8 })
            .borderRadius(6)
            .width('100%')
            .onClick(() => this.doUseWs(w.id))
          }, (w: WorkspaceInfo) => w.id)
        }
        .padding(4)
        .backgroundColor(Th.c.l2)
        .border({ width: 1, color: Th.c.border2 })
        .borderRadius(10)
        .width('94%')
      }

      // ---- session-list(分组) ----
      Scroll(this.scroller) {
        Column({ space: 6 }) {
          if (this.loading) {
            LoadingProgress().width(22).height(22).margin(10)
          }
          if (this.errMsg !== '') {
            Text(this.errMsg).fontSize(11).fontColor(Th.c.danger).padding(8)
          }
          ForEach(this.groups(), (g: SessionGroup) => {
            Column({ space: 4 }) {
              Row({ space: 6 }) {
                Text(g.collapsed ? '▸' : '▾')
                  .fontSize(12)
                  .fontColor(Th.c.text3)
                Text(wsGroupLabel(g.workspace, g.rows.length))
                  .fontSize(12)
                  .fontColor(Th.c.text3)
                  .layoutWeight(1)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
              .width('100%')
              .padding({ left: 8, right: 8, top: 6, bottom: 6 })
              .borderRadius(6)
              .onClick(() => {
                this.collapsed = toggleGroup(this.collapsed, g.workspace)
                this.store.collapsedGroups = this.collapsed
              })
              if (!g.collapsed) {
                ForEach(g.rows, (s: SessionRow) => {
                  this.sessionItem(s)
                }, (s: SessionRow) => s.id)
              }
            }
            .width('100%')
          }, (g: SessionGroup) => g.workspace + g.rows.length)
          if (this.nextCursor !== '') {
            Text(this.L('side.loadMore'))
              .fontSize(12)
              .fontColor(Th.c.text3)
              .margin({ top: 6, bottom: 6 })
              .onClick(() => this.loadMore())
          }
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .padding(8)
    }
    .width(264)
    .height('100%')
    .backgroundColor(Th.c.l2)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sessionItem(s: SessionRow) {
    Column({ space: 2 }) {
      Row({ space: 5 }) {
        if (s.running) {
          Circle({ width: 7, height: 7 })
            .fill(Th.c.running)
            .margin({ right: 2 })
        }
        Text(s.title)
          .fontSize(13)
          .fontColor(s.id === this.activeId ? Th.c.text : Th.c.text3)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(s.pinned ? '★' : '')
          .fontSize(12)
          .fontColor(Th.c.warn)
      }
      .width('100%')
      Row({ space: 6 }) {
        Text(s.updatedAt !== '' ? s.updatedAt.slice(5, 16).replace('T', ' ') : '')
          .fontSize(11)
          .fontColor(Th.c.text3)
          .layoutWeight(1)
        if (s.outcome === 'error') {
          Text(this.L('status.failed')).fontSize(10).fontColor(Th.c.danger)
        } else if (s.outcome === 'ok') {
          Text('✓').fontSize(10).fontColor(Th.c.completed)
        }
        Text('⋯')
          .fontSize(14)
          .fontColor(Th.c.text3)
          .onClick(() => this.itemMenu(s.id))
      }
      .width('100%')
    }
    .padding({ left: 10, right: 10, top: 9, bottom: 9 })
    .constraintSize({ minHeight: Metrics.listItemH })
    .borderRadius(6)
    .backgroundColor(s.id === this.activeId ? Th.c.l1 : Th.c.l2)
    .width('100%')
    .onClick(() => this.openSession(s.id))
  }

  // ---------- 动作 ----------
  private itemMenu(id: string): void {
    // 蓝本:每行 ⋯ 菜单(导出/归档/删除)——v3 弹层从简:先直接归档+删除双按钮由长按/此处触发
    // 此处先做成:点击 ⋯ → 归档(可恢复);删除/导出走 dock 会话页(蓝本同款三键在 hover 展示)
    this.store.api().postJson<Object>(`/api/sessions/${encodeURIComponent(id)}/archive`, null).then((_r: Object) => {
      this.refresh()
    }).catch((_e: object) => {
    })
  }

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

  private currentWsName(): string {
    for (let i = 0; i < this.wsData.items.length; i++) {
      if (this.wsData.items[i].id === this.wsData.current) {
        return this.wsData.items[i].name
      }
    }
    return this.L('side.noWs')
  }

  private groups(): SessionGroup[] {
    let rows = this.buildRows()
    if (this.search !== '') {
      const q = this.search.toLowerCase()
      const kept: SessionRow[] = []
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].title.toLowerCase().indexOf(q) >= 0) {
          kept.push(rows[i])
        }
      }
      rows = kept
    }
    return groupByWorkspace(applyFilter(rows, this.filter === 'running' ? 'running' : (this.filter === 'done' ? 'done' : (this.filter === 'failed' ? 'failed' : 'all'))), this.collapsed)
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

  private openSession(id: string, fresh: boolean = false): void {
    this.activeId = id
    AppStorage.setOrCreate('openSessionReq', id)
    AppStorage.setOrCreate('openSessionRev', (AppStorage.get<number>('openSessionRev') ?? 0) + 1)
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

  private async refreshWs(): Promise<void> {
    try {
      const resp = await this.store.api().getJson<Object>('/api/workspaces')
      const o = resp as Record<string, Object>
      const cur = typeof o['current'] === 'string' ? o['current'] as string : ''
      const rawItems = o['items'] as Object[]
      const items: WorkspaceInfo[] = []
      if (rawItems instanceof Array) {
        for (let i = 0; i < rawItems.length; i++) {
          const w = rawItems[i] as Record<string, Object>
          items.push({ id: w['id'] as string, name: w['name'] as string, path: w['path'] as string } as WorkspaceInfo)
        }
      }
      this.wsData = { current: cur, items: items } as WorkspacesResp
    } catch (e) {
      // 静默
    }
  }

  private async doUseWs(id: string): Promise<void> {
    try {
      const req: WsUseReq = { id: id }
      await this.store.api().postJson<Object>('/api/workspaces/use', req)
      this.wsMenuOpen = false
      this.refreshWs()
      this.refresh()
    } catch (e) {
      this.errMsg = this.errText(e)
    }
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

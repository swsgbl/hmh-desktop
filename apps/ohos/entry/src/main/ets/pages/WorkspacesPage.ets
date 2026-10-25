/**
 * M-O4 工作区:列表 + 当前标记 + 切换(POST /api/workspaces/use;busy 409 提示)
 */
import { AppStore } from '../model/AppStore'
import { guardWorkspacesResp } from '../model/Guards'
import { WorkspacesResp, WorkspaceInfo, WsUseReq } from '../model/Types'
import { ApiError, toApiError } from '../net/ApiClient'

@Component
export struct WorkspacesPage {
  @State data: WorkspacesResp = { current: '', items: [] } as WorkspacesResp
  @State loading: boolean = false
  @State errMsg: string = ''
  @State notice: string = ''
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    this.refresh()
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 12 }) {
        Text('工作区')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button('刷新')
          .fontSize(13)
          .height(36)
          .onClick(() => this.refresh())
      }
      .width('100%')

      if (this.data.current !== '') {
        Text(`当前: ${this.data.current}`)
          .fontSize(14)
          .fontColor('#0A7D32')
          .width('100%')
      }
      if (this.notice !== '') {
        Text(this.notice).fontSize(13).fontColor('#1565C0').width('100%')
      }
      if (this.errMsg !== '') {
        Text(this.errMsg).fontSize(13).fontColor('#C0392B').width('100%')
      }
      if (this.loading) {
        LoadingProgress().width(28).height(28)
      }

      Scroll() {
        Column({ space: 10 }) {
          ForEach(this.data.items, (w: WorkspaceInfo) => {
            Column({ space: 4 }) {
              Row({ space: 8 }) {
                Text(w.name)
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .layoutWeight(1)
                if (w.id === this.data.current) {
                  Text('● 当前')
                    .fontSize(12)
                    .fontColor('#0A7D32')
                } else {
                  Button('切换')
                    .fontSize(12)
                    .height(32)
                    .onClick(() => this.doUse(w.id))
                }
              }
              .width('100%')
              Text(w.path)
                .fontSize(11)
                .fontColor('#999999')
                .width('100%')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            .padding(12)
            .backgroundColor('#FFFFFF')
            .borderRadius(12)
            .width('100%')
          }, (w: WorkspaceInfo) => w.id)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  private async refresh(): Promise<void> {
    this.loading = true
    this.errMsg = ''
    this.notice = ''
    try {
      const resp = await this.store.api().getJson<Object>('/api/workspaces')
      this.data = guardWorkspacesResp(resp)
    } catch (e) {
      this.errMsg = this.errText(e)
    }
    this.loading = false
  }

  private async doUse(id: string): Promise<void> {
    this.notice = ''
    this.errMsg = ''
    try {
      const req: WsUseReq = { id: id }
      const resp = await this.store.api().postJson<Object>('/api/workspaces/use', req)
      this.data = guardWorkspacesResp(resp)
      this.notice = `已切换到 ${id}`
    } catch (e) {
      const err = e instanceof ApiError ? e as ApiError : toApiError(e)
      if (err.status === 409) {
        this.errMsg = '有任务运行中,不能切换工作区(409)'
      } else {
        this.errMsg = this.errText(e)
      }
    }
  }

  private errText(e: object): string {
    const err = e instanceof ApiError ? e as ApiError : toApiError(e)
    if (err.code === 'auth-required') {
      return '令牌无效 (403),请到设置页核对'
    }
    if (err.status === 0) {
      return '网络不可达,检查服务器地址'
    }
    return `HTTP ${err.status}: ${err.message}`
  }
}

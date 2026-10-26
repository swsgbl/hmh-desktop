/**
 * M-O5 文件:目录浏览(/api/fs) + 文件预览(/api/fs/read,64KB 截断提示)
 */
import { Th } from '../theme/Theme'
import { AppStore } from '../model/AppStore'
import { guardFsDir, guardFsRead } from '../model/Guards'
import { FsDirResp, FsReadResp, FsSegment, FsEntry } from '../model/Types'
import { ApiError, toApiError } from '../net/ApiClient'

@Component
export struct FilesPage {
  @State dir: FsDirResp | null = null
  @State preview: FsReadResp | null = null
  @State loading: boolean = false
  @State errMsg: string = ''
  @State pathInput: string = ''
  private store: AppStore = AppStore.get()

  aboutToAppear(): void {
    if (this.dir === null) {
      this.open('')
    }
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Text('文件')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .layoutWeight(1)
        Button('上级')
          .fontSize(13)
          .height(36)
          .onClick(() => this.goParent())
      }
      .width('100%')

      if (this.dir !== null) {
        Scroll() {
          Row({ space: 4 }) {
            ForEach(this.dir.segments as FsSegment[], (seg: FsSegment) => {
              Text(seg.name + ' /')
                .fontSize(12)
                .fontColor(Th.c.brand)
                .onClick(() => this.open(seg.path))
            }, (seg: FsSegment) => seg.path)
          }
          .width('100%')
        }
        .scrollable(ScrollDirection.Horizontal)
        .height(28)
        .width('100%')

        Scroll() {
          Column({ space: 8 }) {
            if (this.preview !== null) {
              this.previewBox()
            }
            ForEach(this.dir.dirs, (d: FsEntry) => {
              Row({ space: 8 }) {
                Text('📁 ' + d.name)
                  .fontSize(14)
                  .layoutWeight(1)
                Text('打开')
                  .fontSize(12)
                  .fontColor(Th.c.brand)
              }
              .padding(10)
              .backgroundColor(Th.c.l1)
              .borderRadius(10)
              .width('100%')
              .onClick(() => this.open(d.path))
            }, (d: FsEntry) => d.path)
            if (this.dir.files !== undefined) {
              ForEach(this.dir.files as FsEntry[], (f: FsEntry) => {
                Row({ space: 8 }) {
                  Text('📄 ' + f.name)
                    .fontSize(14)
                    .layoutWeight(1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text('预览')
                    .fontSize(12)
                    .fontColor(Th.c.brand)
                }
                .padding(10)
                .backgroundColor(Th.c.l1)
                .borderRadius(10)
                .width('100%')
                .onClick(() => this.read(f.path, f.name))
              }, (f: FsEntry) => f.path)
            }
          }
          .width('100%')
        }
        .layoutWeight(1)
        .width('100%')
      } else {
        Column({ space: 8 }) {
          if (this.loading) {
            LoadingProgress().width(28).height(28)
          }
          Text('输入绝对路径浏览(留空列盘符)').fontSize(12).fontColor(Th.c.text3)
          Row({ space: 8 }) {
            TextInput({ text: this.pathInput, placeholder: '例如 G:\\hmh-desktop' })
              .onChange((v: string) => {
                this.pathInput = v
              })
              .layoutWeight(1)
            Button('前往')
              .height(40)
              .onClick(() => this.open(this.pathInput.trim()))
          }
          .width('100%')
        }
        .width('100%')
      }

      if (this.errMsg !== '') {
        Text(this.errMsg).fontSize(13).fontColor(Th.c.danger).width('100%')
      }
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  @Builder
  previewBox() {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Text('📄 ' + (this.preview as FsReadResp).rel)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${(this.preview as FsReadResp).size} B`)
          .fontSize(11)
          .fontColor(Th.c.text3)
        Text('关闭')
          .fontSize(12)
          .fontColor(Th.c.danger)
          .onClick(() => {
            this.preview = null
          })
      }
      .width('100%')
      if ((this.preview as FsReadResp).binary) {
        Text('(二进制文件,不预览)')
          .fontSize(13)
          .fontColor(Th.c.text3)
          .width('100%')
      } else {
        Scroll() {
          Text((this.preview as FsReadResp).text !== undefined ? (this.preview as FsReadResp).text as string : '(空文件)')
            .fontSize(12)
            .fontFamily('monospace')
            .width('100%')
            .alignSelf(ItemAlign.Start)
        }
        .constraintSize({ maxHeight: 260 })
        .width('100%')
        .backgroundColor(Th.c.l2)
        .borderRadius(8)
      }
      if ((this.preview as FsReadResp).truncated === true) {
        Text('⚠ 超过 64KB 已截断,完整内容请在 PC 端查看')
          .fontSize(11)
          .fontColor(Th.c.warn)
          .width('100%')
      }
    }
    .padding(10)
    .backgroundColor(Th.c.l2)
    .borderRadius(10)
    .width('100%')
  }

  private async open(path: string): Promise<void> {
    this.loading = true
    this.errMsg = ''
    this.preview = null
    try {
      const q = path === '' ? '/api/fs' : `/api/fs?path=${encodeURIComponent(path)}&files=1`
      const resp = await this.store.api().getJson<Object>(q)
      this.dir = guardFsDir(resp)
      if (this.dir === null) {
        this.errMsg = '目录响应格式异常'
      }
    } catch (e) {
      this.errMsg = this.errText(e)
    }
    this.loading = false
  }

  private async read(path: string, name: string): Promise<void> {
    this.errMsg = ''
    try {
      const resp = await this.store.api().getJson<Object>(`/api/fs/read?path=${encodeURIComponent(path)}`)
      const g = guardFsRead(resp)
      if (g === null) {
        this.errMsg = '文件响应格式异常'
        return
      }
      this.preview = g
    } catch (e) {
      this.errMsg = this.errText(e)
    }
  }

  private goParent(): void {
    if (this.dir !== null && this.dir.parent !== '') {
      this.open(this.dir.parent)
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

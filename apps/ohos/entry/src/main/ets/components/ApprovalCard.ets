/**
 * M-O3 审批卡:approvalReq 到达 → 展示工具名+参数 → 批准/拒绝 → POST /api/approve
 * 审批权威在 runtime:本组件只发请求,状态由 approvalDone 事件回收
 */
import { Th } from '../theme/Theme'
import { ApprovalCard } from '../model/Types'

@Component
export struct ApprovalCardView {
  card: ApprovalCard | null = null
  sessionId: string = ''
  onDecision: (granted: boolean) => void = (granted: boolean) => {}
  @State sending: boolean = false

  build() {
    if (this.card !== null) {
      Column({ space: 10 }) {
        Row({ space: 8 }) {
          Text('⏸ 审批请求')
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor(Th.c.warn)
            .layoutWeight(1)
          Text('等待决定')
            .fontSize(12)
            .fontColor(Th.c.warn)
            .padding({ left: 8, right: 8, top: 2, bottom: 2 })
            .backgroundColor(Th.c.warnBg)
            .borderRadius(10)
        }
        .width('100%')

        Text(`工具: ${this.card.name}`)
          .fontSize(14)
          .width('100%')

        if (this.argsText() !== '') {
          Text(this.argsText())
            .fontSize(12)
            .fontColor(Th.c.text2)
            .backgroundColor(Th.c.l2)
            .borderRadius(8)
            .padding(8)
            .width('100%')
            .maxLines(8)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }

        Row({ space: 12 }) {
          Button('拒绝')
            .backgroundColor(Th.c.danger)
            .enabled(!this.sending)
            .onClick(() => this.onDecision(false))
          Button('批准')
            .backgroundColor(Th.c.success)
            .enabled(!this.sending)
            .onClick(() => this.onDecision(true))
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
      }
      .padding(14)
      .backgroundColor(Th.c.warnBg)
      .borderRadius(12)
      .border({ width: 1, color: Th.c.warn })
      .width('100%')
    }
  }

  private argsText(): string {
    if (this.card === null || this.card.args === null) {
      return ''
    }
    try {
      return JSON.stringify(this.card.args)
    } catch (e) {
      return ''
    }
  }
}

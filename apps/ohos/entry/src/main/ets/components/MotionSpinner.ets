/**
 * HIG B-4: 动效降级包装 spinner —— Th.reduceMotion(应用内"减弱动效"开关,
 * 鸿蒙无系统级等价物)开启时渲染静态占位,替代 LoadingProgress 旋转动画。
 * motionRev 经 AppStorage 驱动 @StorageProp 即时刷新。
 */
import { Th } from '../theme/Theme'

@Component
export struct MotionSpinner {
  @StorageProp('motionRev') motionRev: number = 0
  side: number = 20
  color: ResourceColor = '#3964fe'

  build() {
    if (Th.reduceMotion) {
      // 静态:空心圆点(无动画)
      Circle({ width: this.side * 0.6, height: this.side * 0.6 })
        .fill(Color.Transparent)
        .stroke(this.color)
        .strokeWidth(1.5)
    } else {
      LoadingProgress().width(this.side).height(this.side).color(this.color)
    }
  }
}

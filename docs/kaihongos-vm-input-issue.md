# KaihongOS 6.1.2.08 虚拟机"应用窗口收不到鼠标/触摸输入"取证（2026-10-30）

## 结论

**KaihongOS 6.1.2.08 x86_64（VMware 镜像，`const.build.characteristics=pc`）存在系统级缺陷：
该镜像内所有普通应用窗口都收不到指针输入** —— 包括系统预装应用（文件管理器、终端、浏览器），
与 HMH Desktop 无关。系统窗口（桌面 Launcher、任务栏、锁屏、输入法悬浮条、窗口装饰按钮）一切正常。
重启虚拟机无效。手机/正常设备上 HMH Desktop 触摸交互正常（安装向导实测）。

## 证据链（全部 hdc 实测）

1. **事件已送达应用进程，但 UI 无响应**：`hilog` 中 `input_transfer_station HandleInputEvent wid:<app窗口>`、
   `WindowImpl lastTouchX_/Y_` 坐标精确命中目标组件，随后 `ITK TTHNI: ContainerModal` + `TTHRTI:`(空) +
   `Consumed` —— 该签名在**健康预装应用（终端）上完全相同**，是本系统 ArkUI 的正常日志形态，不构成"死亡特征"。
2. **预装应用同样死**：文件管理器（com.kaihong.filemanager）前台 + 布局树精确组件中心注入点击
   `uitest uiInput click`，截图字节零变化。终端同签名。
3. **真实鼠标路径复现**：宿主 PowerShell `SendInput` 对 VMware 控制台窗口发真鼠标事件
   （hilog 确认 `type=1/2, button=1, inject=0` 真鼠标源），应用进程收到、UI 零反应 —— 与用户实测一致。
4. **系统窗口全部正常**：锁屏"登录"按钮一点即解、输入法悬浮条 ⚙ 可点开其设置、任务栏/桌面图标可点。
5. **重启无效**：重启后锁屏可点（系统窗口），应用窗口依旧死。
6. **排除应用侧**：同工具链极简探针（单按钮页）同样死；用 OpenHarmony 6.1 公开 SDK（API 23，
   与设备 `const.ohos.apiversion=23` 完全一致）原生重建 v0.2.11 亦死 —— 渲染/布局/无障碍全部正常，
   唯独指针交互无响应，与 SDK 版本无关。

## 测量方法论沉淀（避免再踩）

- `uitest dumpLayout` 的应用组件 bounds 是**窗口内坐标**（最大化时恰等于屏幕坐标）；
  WMS `hidumper WindowManagerService -a "-a"` 的窗口矩形是**空格分隔** `[x y w h]`（不是逗号）。
- 截图字节对比做反应判据时，必须排除浏览器首页轮播等**自走像素噪声**（曾造成"浏览器有反应"的假信号）。
- 对照实验必须确认目标窗口在前台且无重叠（焦点窗口 id + 窗口 Z 序核对）。
- 该镜像上 `aa force-stop` 一个注册了 `entity.system.home` 的应用后系统会立即把它拉起（HOME 应用保活）；
  v0.2.11 起我们已移除 home 注册。

## 给使用者的建议

- 在该 VMware 镜像内验收 HMH Desktop 的键鼠交互**目前不可行**（系统缺陷）；
  请在真机/手机或输入正常的 OpenHarmony 设备上验收交互。
- 可到深开鸿开发者平台（developer.kaihong.com）反馈该问题（本文件可直接作为附件证据）。

## 相关

- v0.2.11：HMH Desktop 深开鸿版改用 OpenHarmony 6.1.0 公开 SDK（API 23）原生构建，
  不再使用"SDK26 产物 + pack.info 版本号改写"的降版补丁；同时移除 `entity.system.home` 注册。

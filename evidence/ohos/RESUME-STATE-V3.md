# RESUME-STATE-V3 · 三栏 1:1 复刻 · 棒 V3-1 收棒

> 任务书:docs/prompts/hmh-ohos-dev-prompt-v3.md。蓝本=apps/desktop App.tsx JSX + app.css 逐值 + tokens.css。

## 本棒完成 ✅(BUILD OK + 装机成功 + dump 实证三栏同屏)

**代码(4 新文件,编译零错)**
1. `theme/Theme.ets`:色板 17 值+尺寸 24 值逐项抄 tokens.css/app.css(bg#141416/raised#1B1D21/panel#1E2024/border#2B2E33/text/dim/accent#2F81F7/danger/warn/userTurn#1C2A3D/8 状态色;titlebar36/sidebar264/dock360/streamPad24/turnMaxW760/radius 6/10/14…)
2. `pages/Sidebar.ets`(264px):sidebar-head(新建会话▾/搜索/状态过滤四chips)+workspace-bar(工作区名+▾下拉切换)+session-list(分组▸组头/★/运行点/⋯归档/加载更多);openSession 经 AppStorage(openSessionReq/openSessionRev)传中栏
3. `pages/WorkspacePane.ets`(1fr):topbar(●已连接·daemonVer/工作区pill/模型pill+下拉15provider/审批:ask/⚙开设置弹层/中EN切换/Stop)+stream(user 右对齐#1C2A3D/assistant 卡/工具折叠卡mono名/交付物绿框卡/turnsum/审批卡/流式▍光标/760 maxW)+composer(附件chips/@弹层搜索/TextArea/发送)
4. `pages/DockPane.ets`(360px):六页签横滚(总览/文件/变更/证据/日志/远程)+总览 kv 卡(runtime/模式/模型/provider/会话数/运行状态/工作区)+日志页(200 行 mono)
5. `pages/Index.ets` 重写:titlebar 36(☰折叠侧栏)+Row[Sidebar|WorkspacePane|DockPane]+设置弹层(overlay 居中 480,复用 v2 SettingsPage 全量内容)

**真机实证(VM 1280×800)**
- shot-v3-threecol.jpeg(107KB)+v3d1.txt dump:**三栏同屏 x 带分离**(左 229-460 新建/过滤chips/工作区条/`G:\hmh-desktop·17 个会话`分组+17 会话行/中 460-760 topbar已连接·glm-5.3·审批:ask·⚙·中/空态提示/composer @+发送/右 761-1016 六页签+runtime kv 卡)
- 视觉模型 3 次超时未出结论(dump 证据已足;下棒可补看图)

## ArkTS 坑(本棒新增)
- `Alignment.BottomRight` 不存在→用 Column 布局替代 Stack 对齐
- `{name:x} as Record` 仍算 untyped literal→必须 `const b: ModelReq={...}` 接口实义
- overlay 弹层语法:`.overlay(this.builder(), {align: Alignment.Center})` 挂 build 链尾

## 未完成(下棒)⬜
1. **V3-2 逐区一致**:Dock 文件页签(现占位"对接中"——需接 v2 FilesPage 逻辑)/变更页签(接 /api/diff)/证据/远程页签内容
2. **V3-3 交互 1:1**:侧栏会话点击→中栏切换(Sidebar→AppStorage→WorkspacePane 监听 openSessionRev 换 activeId+startSse **未接线**——现在点会话中栏不变,这是最大缺口)/模型下拉切换/设置弹层内交互复测
3. **V3-4 响应式**:<1100 dock 落底、<820 隐侧栏(蓝本断点)
4. **V3-5 单测回归**:61/61(布局代码不影响纯逻辑,跑一遍确认)
5. **V3-6 用户实测**
6. **空壳会话排查**(Zode 附任务):web-mvoerwi5 同款;本棒未动——下棒从 VM 侧 hilog 抓 POST /api/task 请求体(是否 sessionId 空/mode 异常)对照 runtime 日志
7. titlebar 拖拽区/最小化最大化(蓝本 titlebar 有 window 控制,VM 全屏态可从简)

## 环境快照
同 V2-6(deploy.mjs 全链/hmm-dump.cjs 窗口过滤 dump/aa start 拉前台/uinput -T -m 滚动)

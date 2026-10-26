# HMH Desktop：Apple-inspired GUI 开发与验收计划

## 目标
将 DSH 风格界面渐进升级为受 Apple HIG 启发的跨平台桌面设计系统，先解决系统主题、键盘与减少动态效果，再整理层级、长任务状态和 Inspector。保留 HMH 现有功能与 Electron 安全边界。

## 已进入 Draft PR #1 的基础变更
- 首次主题偏好使用 system，并跟随 prefers-color-scheme: dark；显式 light/dark 仍是持久化覆盖。
- 增加全局 focus-visible 视觉焦点。
- 通过 prefers-reduced-motion 减少持续动画，同时保留静态状态信号。
- 将普通控件从全胶囊样式收敛为更克制的圆角矩形；引入 sidebar / toolbar / selection / focus / radius 语义 token。
- 强化 forced-colors、高对比度、禁用 hover 的动作可见性，并增加 UI accessibility contract tests。
- 真实界面验收仍需在 CI 绿后完成；这组基础修改不意味着完整视觉重构已经结束。

## M0 — 冻结视觉基线
对空白/运行/待审批/成功/失败状态记录 before 截图：Light/Dark/System × 1024×700、1280×800、1440×900、1920×1080，另测 125%/150% 缩放。建立 screenshot diff；大面积视觉差异须有说明。

## M1 — 桌面基础交互
完善系统主题、窗口最小尺寸、Sidebar/Inspector 显示隐藏、平台快捷键、命令面板、会话搜索、弹层焦点管理与恢复。确保长标题、长路径和狭窄窗口下不溢出。

## M2 — Conversation 与 Composer
每轮明确 Request / Plan Summary / Actions / Verification / Result。工具细节默认折叠，错误和审批更醒目。最终答案与产物是视觉重点；Composer 不被长日志推离视口。发送、取消、恢复、审批状态都由 runtime 事件驱动。

## M3 — Inspector 与 Evidence
统一 Overview、Files、Diff、Evidence、Logs、Remote 的密度/空状态/复制行为。Evidence 需要真实来源、模型/provider、prompt/skill、环境、lineage 和时间；缺数据标 NEEDS-DATA。不得用假指标卡或空壳数据填充。

## M4 — 安全、可靠性与恢复
- 审计 Electron sandbox、contextIsolation、nodeIntegration=false、CSP、IPC schema/sender、未知导航和外部窗口。
- 验证 token/API key 不进入 renderer、localStorage、日志、截图或 report artifacts。
- 测试取消/重试、请求 abort、SSE 重连、重复事件、会话隔离、审批 stale-state、窗口关闭与 runtime 退出。
- 禁止关闭 Desktop 时误杀用户已有的 hmharness 服务；runtime/host 生命周期要有权威 owner。

## M5 — 真实验收门禁
Windows clean runner：
1. npm install --no-audit --no-fund
2. npm run typecheck
3. npm test
4. node scripts/ui-accessibility-contract.test.mjs（以 package script 实际入口为准；通常由 npm test 纳入）
5. npm run build
6. node scripts/ui-verify.mjs --dev --fake --wizard
7. node scripts/ui-verify.mjs --dev --real --real-task（需要可用 provider/runtime）
8. node scripts/install-verify.mjs
9. npm run security-test 或 node scripts/security-test.mjs（以 package.json 当前命令为准）
10. OpenHarmony 有目标设备时运行 assembleHap、设备截图与功能验收。

模型/设备无法运行时标记 NOT RUN / NEEDS-DATA，不可用 fake test 冒充 real model/UI/device 测试。

## DoD
- 精确 PR HEAD 上 typecheck、test、build 和 accessibility guard 通过。
- OS 改变主题后 system 模式同步变化；显式 light/dark 不被系统覆盖。
- 减少动态效果时无持续闪烁，状态仍清晰。
- 键盘可以操作 Sidebar、搜索/命令面板、发送/停止、审批、Inspector 与设置，焦点不会丢失。
- Composer 和审批在所有验收窗口尺寸/缩放下保持可达。
- 没有 token/secret 泄露，Electron 安全不变量无回归。
- 每次视觉变更有 before/after 截图、自动检查与人工验收记录。

## 回滚
若主题、焦点、审批发现性、停止/恢复、安全或长任务状态发生回归，只回滚对应小提交；不要与运行时 API 改动、学习算法或大量组件重构混在一个 PR。

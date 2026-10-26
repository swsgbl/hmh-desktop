# HMH Desktop：Apple-inspired GUI 开发计划与验收

## 本次基础层已实现（分支 ui/apple-inspired-2026-10-27）

- 首次主题设为 system；通过 prefers-color-scheme: dark 跟随操作系统，用户明确选择 light/dark 后保持覆盖。
- 增加全局 :focus-visible 焦点环。
- 增加 prefers-reduced-motion；光标与向导进度在减少动态效果模式下有静态替代。
- 普通按钮由通用胶囊改为圆角矩形；Inspector 页签收敛。
- Sidebar 增加浅/深色独立表面 token；会话选中态使用低饱和 accent tint。
- 增加 UI foundation guard 和 CI 调用，保护系统主题、焦点、减少动态效果和外部文本安全不变量。

这些是设计系统基础层，不代表整套 GUI 重构已完成；后续仍需截图与真实交互验收。

## M0 — 视觉基线
记录 1440×900、1280×800、1024×700，以及浅/深/系统主题、空白/运行/待审批/失败状态截图。建立可解释的截图差异门禁。逐步将 App.tsx 和 app.css 拆分为 Sidebar、Conversation、Composer、Inspector、Settings、SetupWizard，先保持行为等价。

## M1 — 桌面基础交互
系统主题、标题栏和窗口最小尺寸；Sidebar/Inspector 显示隐藏与平台快捷键；命令面板、会话搜索焦点管理；focus-visible、减少动态效果、125/150% 缩放、长标题和长路径布局。

## M2 — 对话与任务状态
每轮按 request/plan/actions/verification/result 组织；工具动作默认折叠，错误和审批提高可见性；停止、失败、恢复、审批均以真实 runtime 事件为依据；Composer 不得被长输出推离视口。

## M3 — Inspector 与证据
统一 Overview、Files、Diff、Evidence、Logs、Remote 空状态和信息层级。证据展示来源、版本、lineage 与时间；缺失项标 NEEDS-DATA。Diff 和日志支持长路径、复制和过滤。

## M4 — 安全和恢复
保留 Electron sandbox、contextIsolation、nodeIntegration=false、CSP、IPC 白名单、sender 验证、阻止未知导航。token/密钥不得进入 renderer/localStorage/log。测试挂死恢复、断线重放、多会话隔离、审批 stale state、退出应用不会误杀已有服务。

## M5 — 验收门禁
Windows clean runner：
1. npm install --no-audit --no-fund
2. npm run typecheck
3. npm test
4. node scripts/ui-foundation-guard.mjs
5. npm run build
6. node scripts/ui-verify.mjs --dev --fake --wizard
7. node scripts/ui-verify.mjs --dev --real --real-task（需可用模型与 runtime）
8. node scripts/install-verify.mjs
9. OpenHarmony 有目标设备时运行 assembleHap、设备截图与功能验收。

环境未执行或模型/设备不可用必须标 NOT RUN/NEEDS-DATA，不能用单测通过冒充真实 GUI 验收。

## DoD
CI 全绿，UI foundation guard 通过；主题随 OS 变化且用户覆盖有效；减少动态效果后无持续闪烁，状态仍可识别；键盘可操作导航、发送/停止、审批、命令面板、设置与 Inspector；在指定视口和缩放下 Composer/审批始终可见；无密钥/令牌泄漏；每次视觉变更都有 before/after 截图和结果记录。

## 回滚
出现安全、审批、主题、焦点或长任务状态回归时，回滚独立变更，不撤销已验证的 hmharness 运行时修复。避免把 UI 重构、安全修复和大规模组件拆分混在同一提交。

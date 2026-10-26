# HMH Desktop：Apple-inspired 原生感设计系统

版本 1.0 · 2026-10-27

## 目标与原则

让 HMH Desktop 感觉像成熟的桌面生产力应用：内容优先、导航清楚、控件克制、状态可预期、系统主题和键盘操作自然。借鉴 macOS Human Interface Guidelines 的原则，但不复制 Apple 专有图标/素材，不把所有东西都做成玻璃/胶囊，也不牺牲 Windows 与 OpenHarmony 的平台习惯。

核心：**Quiet chrome, clear content, reversible actions, visible evidence.**
- 窗口框架安静，主内容醒目。
- 靠留白、对齐、字重与位置建立层级；减少重边框和装饰性卡片。
- 状态不依赖颜色单独表达；运行/审批/成功/失败都有文本或图标。
- 动效只解释转场/反馈，不能成为理解状态的唯一渠道。
- 用户能随时理解当前工作区、会话、运行阶段、待审批动作和验证结果。

## 信息架构

1. Sidebar：工作区、收藏/最近会话、运行中/待审批/失败过滤；可显示/隐藏，层级不超过两级，长列表可折叠。
2. Toolbar：当前工作区/任务、模型状态、停止、Inspector 开关与设置；视觉分组最多 2–3 组。
3. Conversation / Main：每轮按 Request → Plan Summary → Actions (collapsed) → Verification → Result 组织；最终结果与产物优先。
4. Composer：固定在窗口底部；发送/停止始终可见；审批模式明确。
5. Inspector：Overview / Files / Diff / Evidence / Logs / Remote 按需显示，默认不与主内容抢注意力，空状态真实且有用。

## 布局与密度

- 基准截图：1440×900、1280×800；低宽窗口 1024×700；另测 125%/150% 缩放。
- 左侧栏目标宽 240–272px；主内容理想阅读宽度 680–900px；Inspector 320–360px，可收起。
- 正文以 68–82 字符的阅读宽度为目标；代码、Diff 与表格支持横向滚动。
- 长列表使用内部滚动，不应把 Composer 或审批推离视口。
- 交互目标在可行情况下尽量提供 40–44px 点击区域；紧凑桌面工具栏可以更小，但键盘与辅助功能必须可用。

## 设计令牌

- 间距：4 / 8 / 12 / 16 / 24 / 32px。
- 控件：普通按钮/输入圆角 7–9px；卡片/弹层 10–12px；胶囊只用于 filter chips。
- 字体：正文 14px 起、行高 21–23px；辅助 12px；代码用等宽字体。使用系统 UI 字体栈，不在 Windows 强行模拟 SF。
- 颜色：语义 token 分离 base/sidebar/raised/primary/secondary/accent/success/warning/error；深浅主题分别验收。
- 选中态：低饱和 accent tint + 标签/图标；避免只通过背景色表示 active。
- 边框/阴影：正常内容优先靠留白和背景层次；阴影仅用于菜单、popover、modal。

## 交互与可访问性

- 主题首启为 system；监听操作系统主题变化；用户显式选择 light/dark 后作为持久化覆盖。
- 支持键盘：发送/换行、取消当前运行、命令面板、搜索会话、显示/隐藏 Sidebar/Inspector、批准/拒绝、Esc 关闭弹层。
- 按系统映射快捷键（macOS Cmd、Windows/Linux Ctrl）；不把错误修饰键硬编码到跨平台 UI。
- focus-visible 清晰；模态出现时焦点进入，关闭时焦点还原；图标按钮有可访问名称。
- 尊重 prefers-reduced-motion；禁用动画后仍有静态运行/待处理状态。
- 提供 forced-colors / high-contrast 路径；颜色不是唯一状态编码。
- 读屏状态变更使用可访问语义和 live region。
- 长任务只显示 goal、阶段、验证、恢复、审批与证据；不把内部 chain-of-thought 放在界面里。
- 审批卡展示实际工具、关键参数、影响范围和风险；停止成功必须由 runtime 终态确认，而不是按钮点击反馈。

## 架构与安全边界

- hmharness 是唯一 Agent/Cognitive Runtime；Desktop 不复制 planner、tool gate、world model、learning loop 或权威审批状态。
- Renderer 不拥有 Node/shell；保持 sandbox、contextIsolation、nodeIntegration=false、严格 CSP。
- IPC 白名单、schema 和 sender 验证；拒绝未知导航/外部窗口。
- loopback 使用 ephemeral port 和高熵 token；token/API key 不落 renderer、localStorage、公开日志或证据工件。
- OpenHarmony 共享设计语义和信息层级，但必须尊重 ArkUI/设备实际平台习惯，不直接复刻 macOS 外壳。

## 官方一手参考

- Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines
- Designing for macOS: https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/
- Sidebars: https://developer.apple.com/design/human-interface-guidelines/sidebars
- Layout: https://developer.apple.com/design/human-interface-guidelines/layout
- Motion: https://developer.apple.com/design/human-interface-guidelines/motion

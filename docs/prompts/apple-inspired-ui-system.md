# HMH Desktop：Apple-inspired 原生感设计系统

版本 1.0 · 2026-10-27

## 目标与原则

让 HMH Desktop 感觉像成熟的桌面生产力应用：内容优先、导航清楚、控件克制、状态可预期、系统主题和键盘操作自然。借鉴 macOS 人机交互原则，不复制 Apple 专有图标/素材，不把所有东西都做成玻璃/胶囊，也不牺牲 Windows 与 OpenHarmony 的平台习惯。

核心：**Quiet chrome, clear content, reversible actions, visible evidence.** 窗口框架安静，主内容醒目；靠留白/字体/对齐建立层级，少用重边框/大色块；状态不靠颜色单独表达；动效只解释转场，不能成为状态信息的唯一渠道。

## 信息架构

1. Sidebar：工作区、收藏/最近会话、运行中/待审批/失败过滤；可显示/隐藏，层级不超过两级，长列表可折叠。
2. Content：对话为主视图；每轮按“请求 → 计划摘要 → 工具动作（默认折叠）→ 验证 → 最终结果”呈现。答案与产物优先，工具参数次之。
3. Inspector：Overview / Files / Diff / Evidence / Logs / Remote 按需显示，不与主内容抢注意力；开关要可发现。
4. Composer：固定在窗口底部；发送/停止始终可见；审批模式明确。批准/拒绝在可见审批卡片内完成，不要把风险操作藏进设置。

## 布局与视觉令牌

- 桌面基准 1440×900、1280×800；最小支持 1024×700；另测 125%/150% 缩放。
- 左栏 240–272px；主内容理想阅读宽度 680–900px；Inspector 320–360px，可收起。
- 聊天正文约 68–82 字符阅读宽度；代码与 Diff 支持横向滚动。长列表内部滚动，不得把 Composer 挤出视口。
- 间距 4/8/12/16/24/32px；普通输入/按钮圆角 7–9px，卡片/弹层 10–12px；胶囊只用于筛选 chip，不用于所有普通按钮。
- 字体使用系统 UI 栈，正文 14px 起、行高 21–23px；辅助 12px；代码等宽。不在 Windows 强行模拟 SF 字体。
- 色彩全部使用语义 token；浅/深主题同时验收。选中态使用低饱和 accent tint + 文本/图标；颜色不是唯一编码。
- 阴影只用于浮层/菜单；正常内容优先靠分层背景和间距。

## 交互与可访问性

- Sidebar 可显示/隐藏；平台快捷键要分开映射（macOS Cmd、Windows/Linux Ctrl）。搜索、命令面板、切换 Inspector、发送/换行、取消任务、审批、Esc 均可键盘操作。
- focus-visible 清楚；模态弹出时焦点进入，关闭时还原；图标按钮提供可访问名称。
- 运行状态展示阶段、验证计数、恢复次数和是否待审批，不展示 chain-of-thought。
- 审批卡显示工具、关键参数、影响范围、风险；停止操作必须以 runtime 状态为准，不能把 HTTP 请求成功当任务已停止。
- Evidence 显示来源/模型/提示/技能/环境版本/lineage；未测写 NEEDS-DATA。
- 必须尊重 prefers-reduced-motion；禁用闪烁时仍显示静态状态。高缩放和长本地路径不得破坏布局。
- UI 不能把 renderer 变成 shell/Node 环境；API key 和 host token 不进入 renderer/localStorage/日志；外部数据按文本渲染。

## 官方一手参考

- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines
- Sidebars: https://developer.apple.com/design/human-interface-guidelines/sidebars
- Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility

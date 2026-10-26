# HMH Desktop 鸿蒙版 · 开发提示词 v3（GUI 布局 1:1 复刻——三栏工作台）

> 签发：Zode（监督者）· 承接：hmharness 智能体 · 2026-10-26
> 前置：v2 已交付功能语义 1:1（20 项矩阵+P0 三重根因闭合），但 **GUI 布局不是 1:1**——
> 当前是底部 Tab 单栏切换（Zode 实机截图实锤：一次只看一块），Windows 版是**三栏同屏工作台**。
> 用户明确要求：**GUI 布局一模一样**。本提示词推翻 Tab 导航，以 Windows 版为唯一蓝本重构布局。

---

## 〇、蓝本（唯一布局真相，照抄结构不许再"适配"成 Tab）

蓝本文件（逐条对照实现）：
- 结构：`G:\hmh-desktop\apps\desktop\renderer\src\App.tsx`（return 的 JSX 树）
- 样式：`G:\hmh-desktop\apps\desktop\renderer\src\app.css`（尺寸/间距/配色全部以它为准）
- 参考截图：`G:\hmh-desktop\ui-shot-groups.png`、`ui-shot-lang.png`（Windows 版实际渲染）

## 一、目标布局（.app-shell 三栏 grid；VM 全屏 1280×800 横屏正好放下）

```
┌─ titlebar 36px: ☰ | HMH Desktop | (窗口钮系统提供) ─────────────────────┐
├──────────┬──────────────────────────────────────────────┬───────────────┤
│ sidebar  │ workspace                                     │ dock 360px    │
│ 264px    │  ┌ topbar: ⇤ ●已连接 runtime x.x · 工作区     │ 页签:         │
│          │  │  +模型▾ +审批:ask +⚙ +中|EN +收起上下文   │ 总览|文件|变更│
│ 新建会话▾│  ├ stream(滚动):                              │ |证据|日志|远程│
│ 搜索…    │  │  用户消息(右对齐蓝底) / 助手卡 / 工具折叠卡 │───────────────│
│ 状态过滤 │  │  / 审批卡(🛡黄框 批准|拒绝) / 交付物卡(📦)  │ dock-body     │
│ ──────── │  │  / 回合汇总 / 流式光标▍                     │ (随页签)      │
│ 工作区▾  │  ├ composer: [@] [📎] textarea(状态占位) [发送]│               │
│ ▸组 n会话│  └────────────────────────────────────────────┘               │
│  会话行… │                                                                │
└──────────┴────────────────────────────────────────────────┴───────────────┘
设置=居中弹层(运行时/应用偏好[外观|语言|Enter]/审批模式/Provider 四区,与 Windows 完全同构)
```

- 尺寸/配色/圆角/间距**逐值照抄 app.css**（sidebar 264px、dock 360px、topbar/ composer padding、turn 卡样式、host-dot、tool-card、approval-card 黄框、artifact 绿框、turn-sum、lang-seg、status-filter、ws-group 等——类名都可以同名，方便对照）；
- **响应式照抄蓝本断点**：≥1100 三栏；820–1100 dock 变底部条；<820 隐侧栏（Tab 导航仅允许作为 <820 竖屏手机的兜底，VM 横屏 1280 永远走三栏）；
- 交互细节也 1:1：▾ 工作区菜单（列表+✓当前+添加→目录选择）、模型▾菜单（name:model+✓当前）、设置四区、语言/外观即时切换、审批卡按钮、@ 附件弹层、上传选择器、运行中"停止"按钮、注入运行中任务。

## 二、实施要求

1. 新建 `pages/WorkspacePage.ets`（或改造 Index）为三栏容器；现有 6 个 Tab 页的内容**降级为 dock-body/弹层的组件**复用，不删逻辑只挪位置；
2. ArkTS 布局用 Row/Column/Flex + breakpoint（VM 横屏走 ≥1100 三栏分支）；
3. 深浅主题、i18n、preferences 全部沿用（不回退）；
4. 每完成一个区域：VM 截图 + 布局 dump 与 Windows 版**同区对比**存 `evidence/ohos/v3/`；
5. hvigorw 真构建 + deploy.mjs 装机验证；
6. 断点纪律/token 纪律/诚实条款不变；上下文将尽先更新 RESUME-STATE-V2.md（或开 RESUME-STATE-V3.md）。

## 三、v3 验收门（Zode 终验标准）

| # | 门 | 标准 |
|---|---|---|
| V3-1 | 三栏同屏 | ≥1100 宽下左中右三栏同时可见（布局 dump 断言三块几何），截图与 Windows 版并排对比 |
| V3-2 | 逐区一致 | 左栏(会话管理全件)/中栏(topbar+stream+composer)/右栏(6 页签)/设置弹层 四区逐项对照蓝本截图，Zode 逐区核对 |
| V3-3 | 交互 1:1 | 工作区菜单/模型菜单/设置弹层/审批卡/@ 弹层/上传 全部按蓝本行为走通 |
| V3-4 | 响应式 | 1280×800 横屏三栏成立；（可选）窄窗 dock 落底 |
| V3-5 | 不回退 | 单测 61/61 保持；v2 已过项（模型 E2E/连接/通知装配）不丢 |
| V3-6 | 用户实测 | 用户在 VM 亲手对比 Windows 版说"布局一样、能用" |

**如实条款**：ArkTS 无 CSS grid 的部分用 Row/Column 组合等价实现；实现不了"逐像素"的地方，在 ACCEPTANCE 里逐条列差异+原因，由 Zode 裁决是否可接受。**禁止用"平台差异"当借口回到 Tab 布局。**

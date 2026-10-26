# HMH Desktop 鸿蒙版 · 开发提示词 v4（DSH 设计风格全面重设计）

> 签发：Zode · 承接：hmharness 智能体 · 2026-10-26
> 用户反馈：**当前 GUI 太丑、不干净整洁**。要求参考 DSH Desktop 官方设计风格全面重新设计。

## 〇、设计蓝本（唯一视觉真相）

**必读 `G:\hmh-desktop\docs\prompts\design-language-dsh.md`**——Zode 从 DSH 官方 npm 包提取的代码级设计规范（色板/字体/组件尺寸/圆角/动效全部带精确值），证据文件在 `evidence/dsh/src/`（alias-theme.css 153 规则块可直接查组件写法）。参考截图 `evidence/dsh/dsh-hero.png`。

一句话气质转变：**深色重块 → 浅色明亮分层**（底 #f9fafb、白卡片分层、品牌蓝紫 #3964fe、胶囊按钮 18px 圆角、输入 8px、菜单 12px、细 10% 黑边框、四级文字色、紧凑控件+均匀留白）。深色主题保留（同 alias 换深值）。

## 一、任务（保留 v3 三栏结构与全部功能,只换设计语言）

1. **Theme.ets 重写**：按蓝本 §1-§4 建立 alias 语义 token（bg-base/layer-1/2/label 四级/brand/border 两级/interactive hover-active/shadow 三级/字号三级/圆角 8-12-18/动效三档）,深浅双主题;
2. 全部组件换肤:按钮四型/输入框/pill/菜单浮层/卡片/会话列表项/滚动条/spinner——逐值按蓝本 §3;
3. 默认主题切**浅色**（跟随系统;深色可选）;
4. 布局不变：三栏 264/1fr/360、titlebar 36、composer、六页签——**结构与交互不回退,只换视觉**;
5. 每个 token 落地后在 VM 截图与蓝本对照,evidence/ohos/v4/ 留证。

## 二、验收门（Zode 终验）

| # | 门 |
|---|---|
| D1 | 浅色主题全局生效：底色 #f9fafb 系、白卡片分层、无残留深色块（截图对照 hero） |
| D2 | 组件合规：按钮胶囊 18 圆角/输入 8px+focus 变 #3964fe/菜单 12px+阴影/pill 24px——逐项 dump 或截图 |
| D3 | 深色主题可用（同 alias 换深值,切换即时） |
| D4 | 不回退：三栏结构/61+ 单测/v2 v3 全部功能不丢 |
| D5 | token 纪律/诚实条款;Zode 对照 alias-theme.css 逐 token 抽查 |
| D6 | 用户实测认可（最终标准） |

纪律：棒次接力/RESUME 断点/token 安全/如实申报,全部不变。开工先回一句话计划。

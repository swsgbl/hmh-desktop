# HMH Desktop Windows 版 · 开发提示词 v4（DSH 设计风格全面重设计）

> 签发：Zode · 承接：Claude Code · 2026-10-26
> 用户反馈：**当前 GUI 太丑、不干净整洁**。要求参考 DSH Desktop 官方设计风格全面重新设计。
> 注意：鸿蒙版由另一位执行者（hmharness 智能体）并行做同款重设计——**两边共用同一份设计蓝本**,不要动 apps/ohos/ 目录。

## 〇、设计蓝本（唯一视觉真相）

**必读 `G:\hmh-desktop\docs\prompts\design-language-dsh.md`**——Zode 从 DSH 官方 npm 包提取的代码级设计规范。证据文件 `evidence/dsh/src/alias-theme.css`（153 规则块,组件写法直接查）+ `root-vars.css`。参考截图 `evidence/dsh/dsh-hero.png`。

一句话气质转变：**深色重块 → 浅色明亮分层**（底 #f9fafb、白卡片分层、品牌蓝紫 #3964fe、胶囊按钮 18px 圆角、输入 8px、菜单 12px、细 10% 黑边框、四级文字色、紧凑控件+均匀留白）。深色主题保留。

## 一、任务（Windows 版 apps/desktop,保留三栏结构与全部功能,只换设计语言）

1. **ui-tokens 重写**（packages/ui-tokens/src/tokens.css）：按蓝本 §1 建 alias 语义变量（bg-base/layer-1/2/label-primary-secondary-tertiary-dimmed/brand-primary/border-l1-l2/interactive-bg-hover-active/button-primary-fill-hover/shadow-lv1-3/字号行高三档/圆角 8-12-18/动效三档）,深浅两套值（:root 浅色默认 + [data-theme=dark] 深色同 alias 换值）;旧 --hmh-* 变量保留别名映射避免大面积破坏,新代码一律用新 token;
2. **app.css 全量换肤**：所有组件按蓝本 §3——按钮四型(胶囊 18px)/输入框(32 高/8px 圆角/focus 品牌边)/pill(24 高/12 圆)/菜单浮层(12px+shadow-lv3)/卡片(白底/12px/细边)/会话列表项(hover 灰/active inset 边)/滚动条细/spinner;titleBarOverlay 颜色联动新主题色(浅色 #f9fafb/深色按深值——renderer 的 chrome-theme IPC 已有,换新色值);
3. **默认主题切浅色**（theme.ts 的 resolve system 判定不变;ensure 新 token 双主题都完整）;
4. 布局/功能零改动：三栏/topbar/composer/Dock 六页签/设置弹层/全部交互不动——**只换视觉**;emoji 图标(⚙📎⇤▾)可换为更细腻的呈现但非必需;
5. 验证命令全绿：npm run typecheck / npm test / node scripts/ui-verify.mjs --dev --fake（31 步,若断言涉及颜色/尺寸按新视觉更新断言并在 commit 里说明）/ --dev --real。

## 二、验收门（Zode 终验）

| # | 门 |
|---|---|
| W1 | 浅色主题全局生效（底 #f9fafb 系/白卡片/无深色残留块——截图对照 evidence/dsh/dsh-hero.png） |
| W2 | 组件合规逐项（按钮胶囊/输入 focus #3964fe/菜单阴影/pill）——UIVERIFY dump 或截图 |
| W3 | 深色主题可用且切换即时（titleBarOverlay 联动新色） |
| W4 | 不回退：UIVERIFY fake 31/real 11 全绿;36 单测;typecheck 0 |
| W5 | 诚实条款：做不完/有偏差如实列;token 纪律不变 |
| W6 | 用户实测认可（最终标准） |

提交规范：单一 commit 或少量清晰 commit,message 注明"v4 DSH 设计语言"。禁改 apps/ohos/、packages/ohos 相关、G:\hmharness。

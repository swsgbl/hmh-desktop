# HMH Desktop 设计语言蓝本（DSH 风格 · 代码级规范）

> Zode 提取自 DSH 官方 Web UI 包（@deepseek-ai/dsh-web-frontend dist CSS,153 规则块）
> 证据：evidence/dsh/src/alias-theme.css + root-vars.css + var-names.txt(393 变量)
> 两版共用（Windows/深开鸿）；本文是唯一视觉真相,冲突时以它为准。

## 1. 色彩（默认浅色主题;深色主题同 alias 换值）

| token | 值(浅色) | 用途 |
|---|---|---|
| bg-base | **#f9fafb** | 全局底色 |
| bg-layer-1 | #ffffff | 卡片/输入框底 |
| bg-layer-2 | #f2f3f5 | pill/次级面板底 |
| label-primary | #0f1115 | 主文字 |
| label-secondary | #61666b | 次文字 |
| label-tertiary | #81858c | 辅助/图标 |
| label-dimmed | #adb0b6 | 占位符 |
| brand-primary | **#3964fe** | 品牌蓝紫(focus/hover 主色) |
| border-l1 | rgb(0 0 0 / 5%) | 极细分隔 |
| border-l2 | **rgb(0 0 0 / 10%)** | 常规边框(输入框/卡) |
| border-inverted | 对比色 | 浮层菜单边框 |
| interactive-bg-hover | rgb(0 0 0 / 4%) | hover 底 |
| interactive-bg-active | rgb(0 0 0 / 8%) | active 底 |
| button-primary-fill / hover | 品牌蓝 / 深一档 | 主按钮 |
| shadow-lv1/2/3 | 柔和分级阴影(浮层 lv3) | 菜单/弹层 |

状态色：success/warn/error 各 primary 一档(点/文字)。

## 2. 字体

- UI：`-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`
- 代码：`"SF Mono", "JetBrains Mono", Consolas, Menlo`
- 字号/行高三级：**12/18 · 14/22 · 16/24**（标题 16 w600；正文 14；辅助 12）

## 3. 组件规范（尺寸=px）

- **按钮**：无边框；圆角 **18px(胶囊)**;高 32;padding 0 14;四型 primary(品牌底)/ghost(透明+hover 灰)/outline(1px border-l2)/toolbar;字号 14
- **输入框**：高 32;1px border-l2;圆角 **8px**;focus 边框变 brand;内部透明;占位 label-dimmed
- **Pill/Chip**：高 24;圆角 12(全圆);bg-layer-2;active 时 ghost-active 底+inset 1px 边
- **菜单/浮层**：圆角 **12px**;1px border-inverted;shadow-lv3;内 padding 4
- **卡片**：bg-layer-1;1px border-l1 或无边框+阴影 lv1;圆角 **12px**
- **会话列表项**：高 ~36;圆角 8;hover interactive-bg-hover;active ghost-active+inset 边;左缩进 8
- **滚动条**：细 thumb(scrollbar-bg-l2)+hover 加深
- **spinner**：20px 2px 环,brand 色顶弧

## 4. 动效

- 缓动 `cubic-bezier(.4,0,.2,1)`;时长 fast .1s / 常规 .2s / slow .3s
- hover/active 一律动效;无弹跳无旋转(除 spinner)

## 5. 布局气质

浅色明亮;**大量留白但控件紧凑**(行高 22/控件 32);分区靠 bg-layer 分层与细边框,不用重色块;分隔线 border-l1;整体"干净、轻盈、现代 SaaS"。深色主题=同 alias 换深值(底 #101216 系,层 #16181d 系,label 反转),布局组件不变。

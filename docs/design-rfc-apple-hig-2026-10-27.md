# HMH Desktop Design RFC — Apple HIG-inspired 视觉规格(阶段 1)

- 日期:2026-10-27 · 分支:`ui/hig-rfc-2026-10-27`(基于 main v0.2.6) · 关联 Issue:#3
- 依据:`G:\hmharness\.audit\docs-2026-10-27\04_HMH_Desktop_Apple_HIG视觉交互规格.md`(下称"04 号规格")+ 本仓源码实测
- 前置:PR#4(`ui/a11y-reduced-motion-2026-10-27`,键盘可见性/36×36 触达/reduce-motion 四件窄改)已于本机全验收门通过并转 ready
- 范围声明:本阶段**只产出本文档 + token 层最小新增**(`packages/ui-tokens`),组件样式零改动。借鉴 Apple HIG 原则,不复制 Apple 资产/商标/SF Symbols;目标平台仍为 Windows x64 与 OpenHarmony/KaihongOS,不声称 macOS 原生支持。

---

## 1. 设计目标与三层视觉层级 → 现有三栏的映射

目标一句话(04 号规格 §1):把视觉从"AI 仪表板/一堆卡片"变成"专注完成工作任务的原生工作台"。主线是 `Workspace → Session → Request → Plan → Actions → Verification → Result`。

| 层级 | 内容 | 映射到现有结构 | 现状问题(源码证据) |
|---|---|---|---|
| **一级:当前任务** | 用户请求、运行状态、最终结果、是否需要审批 | 中栏 `workspace` 的 ConversationTimeline(`.turn.user` 请求气泡、`.turn.streaming` 流式、`.artifact-card` 交付物、`.approval-card` 审批) | 所有 `.turn` 共用同一 760px 白卡皮(`app.css:181-187`),用户请求/最终答案/工具过程视觉权重几乎相同;最终答案没有"主角"样式 |
| **二级:执行过程** | 计划进度、可折叠工具步骤、恢复与失败提示 | 中栏 `.tool-card`(details 默认折叠)+ `.status-chip` 状态章 + `.turn.system` 错误卡 | 工具卡已默认折叠(`app.css:209-230`)但与 turn 同宽同皮同白底;错误信息只有红边+`.err-meta` |
| **三级:可检查证据** | 文件变化、Diff、验证命令、环境快照、版本与 lineageId | 右栏 ContextDock(`.dock`,360px,Overview/Files/Diff/Evidence/Logs/Remote 六 tab) | 六 tab 已齐(`app.css:435-448`);但 Files/Diff 无显式只读声明,Evidence 复制 lineageId、Logs 筛选/复制等交互未逐项落 |

布局骨架现状(04 号规格 §1 实测 + 本仓核对):自定义标题栏 36px(`app.css:54`)、侧栏 264px/min 250/max 280(`app.css:65-73`)、气泡 max-width 760px、Dock 360px/min 320/max 420、≤1100px Dock 转底部 40vh、≤820px 侧栏隐藏(`app.css:411-419`)。04 号规格的目标区间(标题栏 44-52、侧栏 260-288、正文 760-900、Dock 320-380、窄窗 ≥560)中,**侧栏/正文/Dock 已在或接近目标区间,标题栏 36px 偏矮、820px 直接隐藏侧栏而不是转 drawer** 是两个已证差距,留待阶段 2+。

## 2. Design tokens 完整清单

以下 token 已全部落入 `packages/ui-tokens/src/tokens.css`(HIG RFC 块,纯新增)+ `index.ts`(TS 同源导出)。规则:旧 token 零修改零删除;组件本阶段零改动,token 处于"快照"状态,阶段 2 起逐组件切换。

### 2.1 字体层级(04 号规格 §4:12/18 · 13/20 · 15/23 · 20/28 · 28-32)

| token | 值 | 用途 | 现状对应 |
|---|---|---|---|
| `--hmh-font-size/line-height-caption` | 12/18 | 辅助信息 | =旧 `xs`(保留) |
| `--hmh-font-size/line-height-subtle` | 13/20 | 次要标签 | **新增**(现无 13 档) |
| `--hmh-font-size/line-height-body` | 15/23 | 正文/最终答案 | **新增**(现正文=14/22 `sm`) |
| `--hmh-font-size/line-height-heading` | 20/28 | 小标题 | **新增**(现最大仅 16/24 `md`) |
| `--hmh-font-size/line-height-title` | 28/34 | 页面标题(28-32 区间) | **新增** |

旧 `xs/sm/md` 三档保留为底层(04 号规格 §4:"当前 12/14/16 可保留作底层,但需明确标题和结果层级")。字体栈沿用系统栈(`-apple-system, 'Segoe UI', …` + mono),不固定依赖 SF Pro。

### 2.2 间距(4px 网格:`--hmh-space-xs/sm/md/lg/xl/xxl` = 4/8/12/16/24/32)

TS 侧 `spacing` 已有同源六档;本阶段补齐 CSS 变量。纪律:组件内部少量紧凑,组件之间留白区分;**不能所有容器都做卡片**——分区优先用布局和空间,这是对现状"通用白卡铺满"的直接纠偏。

### 2.3 圆角(`--hmh-radius-control/overlay/panel` = 8 / 12 / 16px)

| 档 | 区间 | 现状 |
|---|---|---|
| 控件 | 6-8 | `radius-sm`=8 ✓ 在区间 |
| 浮层 | 10-12 | `radius-md`=12 ✓ 在区间 |
| 面板 | 14-16 | `radius-lg`=18 ✗ 超区间;且 app.css 中**零引用**(死 token),弃用,立 `panel`=16 |
| 胶囊 | 仅 chip/少数按钮 | 现状 `.btn` 全量胶囊(`radius-pill`)、dock-tab/topbar pill 共 7+ 处 → 阶段 2 收敛 |

### 2.4 表面 4 级(`--hmh-surface-base/sidebar/content/elevated`)

现状 `bg-base / layer-1 / layer-2 / menu(+mask×2)` 已是可用的四级材质,但**侧栏与内容卡同为 `layer-1`**,层级感靠边框而非表面。新增语义层:侧栏目标值 = `bg-base`(内容浮于侧栏之上,浅色 #f9fafb vs #fff 微差,深色 #101216 vs #16181d 清晰)。迁移期组件仍引用 `bg-layer-*`,视觉不变;深色主题经 var() 惰性求值自动跟随。边框纪律:低对比,阴影只用于浮层(现状已如此,保持)。

### 2.5 品牌与状态色纪律(颜色不做唯一编码)

色板全量继承 DSH(`brand #3964fe`、状态三色、八态运行色)。纪律条款(非 token 值变更):品牌色只用于主行动/选中/focus;成功/警告/失败**必须**伴随文字标签 + 图标;对文字与图标检查对比度达 WCAG AA。现状反例:`.status-chip` 已是 dot+文字(✓),但 `.diff-state.add/mod/del` 只有颜色字母 A/M/D(✗,阶段 3 补文字)。新增 `--hmh-focus-ring-color/width/offset`(PR#4 focus-visible 样式的 token 化)。

### 2.6 动效(`--hmh-dur-hover/panel/complete` = 120 / 180 / 230ms)

| 档 | 04 号规格区间 | 旧档 | 说明 |
|---|---|---|---|
| hover | 100-140ms | `fast` 0.1s | 120ms 取中值 |
| 面板 | 160-220ms | `dur` 0.2s | 180ms |
| 完成 | 200-260ms | `dur`/`slow` | 230ms |

reduce-motion:`prefers-reduced-motion` 全局关断 + 停 `.session-running-dot` pulse / `.cursor` 闪烁已由 **PR#4** 落地(app.css 媒体查询),token 层无需重复。OpenHarmony/KaihongOS 侧无系统级 reduce-motion 等价物 → 应用内开关(见 runtime 升级方案附录),阶段 4 接入。

### 2.7 图标规范(统一线性 icon 集,弃用随机 Emoji)

尺寸档:`--hmh-icon-size-inline`=16px(行内/按钮内)、`--hmh-icon-size-status`=20px(状态/空态)。现状 Emoji/Unicode 图标分布(App.tsx 实测):☰ 菜单、▾ 下拉、📁 工作区/目录、⇤⇥ 侧栏收展、⚙/✕ 工具状态、🛡 审批、📦 交付物、📎 附件、★☆⤓🗄🗑 会话操作。**纪律**:统一线性 icon 集(开源许可,如 Lucide/Phosphor,不复制 Apple 专有图形);icon-only button 必须有 accessible name——现状 aria-label 体系已较完整(`App.tsx:1027-1030` 等),替换 icon 时保留。执行在阶段 3。

## 3. 六个核心组件:现状 → 目标差距表

| 组件 | 现状(源码证据) | 目标(04 号规格 §6) | 差距 |
|---|---|---|---|
| **Sidebar / SessionList** | 264px 固定列;`.session-item` padding 8/10 无固定行高;hover 灰底 / active 实底+inset 边;运行点 `hmh-pulse` 1.6s 无限循环;行操作 ★☆⤓🗄🗑 hover 显示(PR#4 后 focus-within 也显示);⇤⇥ 手动收展 | 列表项高约 40px;上下键导航/回车打开;右键菜单 pin/archive/export/delete;删除可撤销或二次确认;高频动作 hover 出现但键盘焦点可见 | 行高未定档(40px 档);无键盘列表导航;无右键菜单;删除为 `danger` 按钮直发,无撤销/确认;Emoji 待换;pulse 默认持续(仅 reduce-motion 下关断) |
| **ConversationTimeline** | `.turn` 统一 760px 白卡;user 右对齐浅染 `--hmh-user-turn-bg`;streaming 虚线边+`hmh-blink` 光标;`.status-chip` dot+文字;长输出无内滚动(`.turn-text` pre-wrap 通排) | 消息分组稳定;流式追加不导致历史重排;用户请求/最终答案/执行活动**三级视觉权重**;长代码块内滚动 | 三级权重缺失(全同皮);最终答案无 body(15/23)主角样式;无长代码内滚动;流式重排未验证(阶段 2 加测试) |
| **ToolActivity** | `<details>` 默认折叠;summary mono 12px + ⚙/✕ badge;`.tool-io` 220px 内滚动,out 类主色;错误 `err` 红色 badge | 默认折叠,展示工具名/简洁摘要/耗时/状态;展开看参数与完整输出;错误不吞 stdout/stderr 与结构化 code | 已基本达标(折叠✓ 内滚动✓);缺耗时字段;Emoji badge 待换线性 icon |
| **ApprovalCard** | `.approval-card` warn 边;🛡 icon + 600 字重标题;approve/reject `.btn`;aria-label 已有;权威在 runtime(UI 只转述,`app.css:232` 注释) | 工具名/参数摘要/风险/目标路径与权限说明;主批准次拒绝;Enter/Tab 能完成但不误触;UI 不替代 runtime 审批门 | 信息结构缺目标路径/权限说明;Enter 直接触发审批的防误触策略未定义;Emoji 待换 |
| **Composer** | textarea min 44/max 200px;发送按钮 44px 高;`enterSends` 可设置(Enter 发送/换行);📎📁/@附件/图片粘贴/拖落 | 基础高 88-130、扩展上限约 240;≥44px 主点击高;Enter 语义无歧义;附件/路径验证由 runtime 执行;断线草稿保留 | 基础高度 44px 偏矮(目标 88-130);运行中"停止"与"发送"状态语义待明确区分;断线草稿保留未验证 |
| **ContextDock** | 360px 六 tab pill;`.dock-row` 键值行;≤1100px 转底部 40vh;Overview 含 runtime 版本等 6 行(UIVERIFY 实测) | 320-380 默认可收起;Overview 给目标/状态/验证摘要;Files/Diff 默认只读;Evidence 可复制 lineageId;Logs 筛选+复制 | 宽度已合规;无手动收起(仅响应式);Files/Diff 无只读声明;Evidence 复制/Logs 筛选未落;tab 为 pill 待收敛圆角档 |

## 4. 实施顺序与风险(不重写整个 UI)

| 阶段 | 内容 | 验收门 |
|---|---|---|
| **P0(本 RFC)** | 文档 + token 快照(纯新增,组件零改动) | `typecheck`/`test`/`build` 全绿;app.css 零 diff |
| **P1(已完成)** | PR#4 a11y 四件套:focus-within / focus-visible / 36×36 / reduce-motion | 本机全过(31/31 UIVERIFY)+ 远端 CI 绿,已转 ready |
| **P2:token 迁移** | 组件内硬编码逐项换语义 token:按钮/输入圆角档、正文 15/23、间距六档、动效三档、侧栏表面分离;每组件一 PR | 每步:typecheck+test+build+`ui-verify --dev --fake` 全绿;截图基线(1440×900/1366×768/1024×768/820px,浅/深双主题)差异经审查 |
| **P3:层级与 icon** | 三级视觉权重落地(最终答案 body 主角、过程卡降权)、审批卡信息结构、Emoji→线性 icon 集(含许可审查与 i18n aria-label 保留) | 同 P2 + icon-only button accessible name 100%;对比度抽检 AA |
| **P4:交互增强** | 侧栏键盘导航/右键菜单/删除撤销、命令面板动词化、Composer 基础高度与停止语义、Dock 收起、Files/Diff 只读声明、Evidence 复制/Logs 筛选 | 键盘全流程无鼠标(启动→会话→发送→审批→Diff→主题);a11y 自动扫描高严重度 0 |
| **P5:门禁与实机** | 1000 会话/100+ 工具事件性能(行虚拟化);Windows 真实安装包 + OpenHarmony 实机 5 任务真人观察 | 发布验收:DOM/fake PASS ≠ 真人 PASS,必须实机 |

**风险与缓解**:
1. `App.tsx` 1459 行单文件承载全部页面/状态——P2/P3 拆组件(Sidebar/ConversationTimeline/ToolActivity/ApprovalCard/Composer/ContextDock 六件,event reducer 与视图分离)是前置,否则每步 PR 都在全文件上手术;UIVERIFY 断言依赖类名/文案,拆分需同步测试。
2. 迁移期双轨 token(旧 xs/sm/md + 新语义档)有漂移风险——纪律:新代码一律语义 token;每阶段收尾 grep 旧档残留。
3. 深色主题需双套值同步——引用型 token(var() 链)已自动跟随;新增字面值 token(圆角/间距/动效/字号)主题无关,天然安全。
4. Emoji 替换触及 i18n(L.* 文案与 aria-label)——icon 组件封装一次到位,避免二次返工。
5. OpenHarmony 适配(返回手势 onBackPress、深色跟随 colorMode+onConfigurationUpdate、reduce-motion 应用内开关)依赖 runtime 升级方案(2d5df7d 附录),跨仓协调,排 P4/P5。

## 5. DSH 基线(`docs/prompts/design-language-dsh.md`)继承与变更(逐条)

| # | DSH 条目 | 决定 | 说明 |
|---|---|---|---|
| 1 | 色板(bg/label 四级/brand #3964fe/border l1,l2,inverted/interactive/list-active/状态三色/八态色/user-turn 浅染/shadow lv1-3/scrollbar) | **全量保留** | 材质与色纪律已被双主题验证,仅新增语义包装(surface 四级) |
| 2 | 字体栈(系统 UI + mono) | **保留** | 不固定 SF Pro(平台中立) |
| 3 | 字号三档 12/18 · 14/22 · 16/24 | **底层保留,层级扩展** | 新增 13/20、15/23、20/28、28/34;正文 14→15 的切换在 P2 |
| 4 | 按钮胶囊 18px/pill、高 32、四型 | **胶囊收敛** | 胶囊仅限 chip/少数按钮;主按钮改 6-8 控件圆角(P2);`.btn` 高 32 保留但 icon-btn 已 36×36(PR#4) |
| 5 | 输入框高 32 / 圆角 8 / focus 变品牌边 | **保留** | 已在 6-8 区间,focus 环 token 化 |
| 6 | 菜单/浮层圆角 12 + border-inverted + shadow-lv3 + padding 4 | **保留** | =overlay 档,合规 |
| 7 | 卡片:bg-layer-1 + border-l1/l2 + 圆角 12 | **收敛** | "不能所有容器都做卡片":分区优先布局与空间;turn 卡圆角在 P2 评估 panel(16)vs overlay(12)归属 |
| 8 | 会话项 ~36 高 / hover 灰 / active 实底+inset | **保留并定档 40px** | 04 号规格 §6 行高 40px 档 |
| 9 | 动效 .1/.2/.3 三档 + 缓动 cubic-bezier(.4,0,.2,1) | **语义重映射** | →hover 120/panel 180/complete 230;缓动保留;reduce-motion 关断(PR#4) |
| 10 | 滚动条细 thumb | **保留** | — |
| 11 | 布局气质"干净轻盈 SaaS / 大量留白但控件紧凑" | **方向修正** | →"专注任务的原生工作台":内容优先、三层层级、动效克制;留白纪律(2.2)保留 |
| 12 | 深色=同 alias 换值机制 | **保留** | 引用型新 token 自动跟随 |

## 6. token 最小落地(本分支实际变更)

- `packages/ui-tokens/src/tokens.css`:**纯新增 48 行**(一个 HIG RFC 注释块),7 组语义 token:字体层级 5 档、间距 6 档、圆角 3 档、表面 4 级、动效 3 档、focus 环 3 变量、icon 尺寸 2 档。既有变量零修改、零删除;深色块零改动(var() 惰性求值自动跟随)。
- `packages/ui-tokens/src/index.ts`:新增 3 个同源导出 `typeScale` / `radius` / `motion`(+15 行);既有导出零改动。
- `apps/desktop/renderer/src/app.css`:**零改动**(本阶段不动组件样式;PR#4 的 a11y 改动在其自身分支)。
- 验收:typecheck / test / build 全绿(结果见交付记录);`radius-lg`(18px)确认 app.css 零引用后标记弃用。

## 7. 参考来源

- 04 号规格(本 RFC 的直接依据,2026-10-27 审计基线:hmharness main 0.23.42 / Desktop v0.2.6)
- Apple HIG: Designing for macOS / Design principles / Accessibility / Motion(developer.apple.com,经 04 号规格引用)
- 本仓实源:`apps/desktop/renderer/src/app.css`(515 行)、`App.tsx`(1459 行)、`packages/ui-tokens/src/{tokens.css,index.ts}`、`docs/prompts/design-language-dsh.md`

# 任务 D（阶段 1）：HMH Desktop Apple HIG-inspired 视觉规格落地（Desktop Issue #3）

你是高级桌面端产品设计师与 Electron/React 前端架构师。

## 工作环境（先读，不要假设）
- 工作目录：`G:\hmh-desktop`（本机克隆，main 在 v0.2.6）。先 `git status` 清点未跟踪文件（如 b[0]、scripts/mem-update*.mjs 是历史残留，不要提交它们，也不要删除）。
- 仓库：https://github.com/swsgbl/hmh-desktop（origin）。**禁止 push main、禁止自动合并 PR**。
- 已有 Draft PR#4（分支 `ui/a11y-reduced-motion-2026-10-27`）：app.css 的键盘可见性/focus-visible/36×36 触达/Reduce Motion 四件窄改 + docs/ui-refinement-2026-10-27.md。远端 CI 已绿。
- 本机 Windows shell 陷阱：不用 `VAR=x` 前缀、不用 heredoc、`;`/`&&` 链会被撕——复杂命令写 node 脚本执行。
- 先建并切换到新分支 `ui/hig-rfc-2026-10-27`（基于 main）。本阶段**只产出文档与 token 层面的最小代码**，不做大规模 UI 重写。

## 产品边界（不可违反）
- hmharness 是唯一 Agent/Cognitive Runtime；桌面端不复制 Agent loop、不做审批决策、不写认知数据。
- 目标平台 Windows x64 与 OpenHarmony/KaihongOS；不声称 macOS 原生支持。
- 只借鉴 Apple HIG 原则（内容优先、层级、灵活窗口、工具栏/侧栏一致、键盘可达、可撤销、动效克制、系统适配），**不复制 Apple 资产/商标/SF Symbols**。

## 阶段 1 任务（只做视觉基础，两步）
### 第一步：收编 PR#4
1. 在本地检出 PR#4 分支，审阅其改动与 docs/ui-refinement-2026-10-27.md。
2. 跑验收门（在 PR#4 分支上）：`npm run typecheck`、`npm test`、`npm run build`、`node scripts/ui-verify.mjs --dev --fake`（参数以 scripts/ui-verify.mjs 实际 --help 为准，不盲信文档命令；打包版 `--packaged --fake` 若需要完整打包可先跳过并标 NOT RUN）。
3. 产出验收记录（PASS/FAIL/NOT RUN 逐项）；如全过，在 PR#4 留言说明验证结果（gh pr comment）并 `gh pr ready 4`。不要合并。

### 第二步：Design RFC + token 快照（在新分支 ui/hig-rfc-2026-10-27）
产出 `docs/design-rfc-apple-hig-2026-10-27.md`，内容必须覆盖（依据 04 号规格文档，先读它：`G:\hmharness\.audit\docs-2026-10-27\04_HMH_Desktop_Apple_HIG视觉交互规格.md`，直接用 Read 工具读该路径）：
1. 设计目标与三层视觉层级（一级当前任务/二级执行过程/三级可检查证据）如何映射到现有三栏。
2. Design tokens 完整清单：字体层级（12/18、13/20、15/23、20/28、28-32）、间距 4/8/12/16/24/32、圆角（6-8 控件/10-12 浮层/14-16 面板）、4 级表面层级、品牌与状态色纪律（颜色不做唯一编码）、动效时长（hover 100-140ms/面板 160-220ms/完成 200-260ms + reduce-motion）、图标规范（统一线性 icon 集 + accessible name，弃用随机 Emoji）。
3. 六个核心组件（Sidebar、ConversationTimeline、ToolActivity、ApprovalCard、Composer、ContextDock）的逐组件现状→目标差距表。
4. 实施顺序与风险（不重写整个 UI；分几步走；每步验收门）。
5. 现有 DSH 风格基线 `docs/prompts/design-language-dsh.md` 的继承与变更点（哪些保留哪些替换，逐条列）。
6. token 最小落地：在现有 CSS token 体系上新增/调整变量（只动 token 定义层，不改组件样式），保证 `npm run build` 与 `npm test` 全绿。

## 交付模板（最终回复必须含）
- 变更动机与可验证问题
- 事实 vs 假设 vs 缺失证据
- PR#4 验收记录（逐项 PASS/FAIL/NOT RUN + 命令与输出摘要）
- RFC 文件路径 + token diff 摘要
- 实际执行的命令及原始结果
- 已知局限、风险、下一步唯一建议

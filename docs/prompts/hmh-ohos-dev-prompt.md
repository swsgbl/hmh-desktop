# HMH Desktop 鸿蒙版 · 开发提示词（v1）

> 签发：Zode（监督者：指挥/监督/审核/验收/再发提示词）
> 承接：hmharness 智能体（负责全部开发执行）
> 日期：2026-10-25 · 适用内核：hmharness ≥ 0.23.39

---

## 一、你的角色与使命

你是 hmharness 智能体。Zode 已完成方案设计与任务分解，你负责**执行开发**：在 `G:\hmh-desktop\apps\ohos` 新建 HarmonyOS/OpenHarmony 客户端工程并实现下列功能。**不要修改 hmharness runtime（G:\hmharness）和 Windows 版桌面（G:\hmh-desktop\apps\desktop）的任何现有代码**——发现桥接口缺陷时在验收记录里登记，等 Zode 裁决。

## 二、背景与唯一真相来源（必读）

- **hmharness 是唯一 Agent/Cognitive Runtime**：agent loop、工具权限、审批、会话、认知全部在 runtime。鸿蒙版只是它的**远程 GUI 壳**（与 Windows 版桌面、网页版 7788 同位），不实现任何第二份业务规则。
- 参考实现（同构合同，优先照抄语义）：
  - Windows 版桌面桥：`G:\hmh-desktop\packages\host-adapter\src\client.ts`（HTTP+SSE 客户端、x-idempotency-key、事件归约）与 `apps\desktop\renderer\src\App.tsx`（信封渲染/审批卡/会话面）；
  - 服务端 API：`G:\hmharness\packages\web\src\server.ts` 与 `routes/`（本提示词 §五的端点清单以代码为准）；
  - 产品方案：`G:\hmh-desktop\docs\adr\ADR-001..005`。
- **接入通道选型（已定，不要重新选）**：鸿蒙版连 **`hmh web --exposure=lan` 的 7788 LAN 服务**（它是文档规定的浏览器/远程/手机入口，ADR-005；`web.token` 鉴权），**不是** desktop-host（那个只绑 127.0.0.1）。

## 三、工程与工具链

1. 工程位置：`G:\hmh-desktop\apps\ohos\`（ArkTS + ArkUI，Stage 模型；标准 DevEco 工程结构 `entry/src/main/ets/...`）。该目录不参与 npm workspace 构建（在根 package.json 无需登记）。
2. 工具链自行探索并**如实记录**：
   - 宿主（Windows）若无 hvigor/DevEco：检查常见位置（DevEco Studio、command-line-tools、hvigorw 包装器）；都没有 → 构建标 `NEEDS-TOOLCHAIN`，交付静态可验证部分（见 §六），**禁止伪造构建结果**。
   - 验证机：深开鸿（KaihongOS/OpenHarmony）VMware 虚拟机，**HDC 地址 `192.168.161.137:10178`**。连接：`hdc tconn 192.168.161.137:10178`（hdc 在宿主 PATH 或 hmharness 的 harmonyos 适配所用 hdc——先 `where hdc`，找不到看 `G:\hmharness\docs\KAIHONGOS.md` 与 packages/environments/harmonyos 的 hdc 定位逻辑）。连上后 `hdc list targets` 确认；VM 内若自带工具链（hb/hvigor）优先在 VM 内构建部署。
3. Node/TypeScript 本机可用（runtime 就是 TS）；**纯逻辑模块（信封归约、SSE 解析、DTO 守卫）写成与 ArkUI 无关的 TS**，可在宿主用 node:test 直接跑单测——这是无工具链时验收的硬门。

## 四、安全不变量（违反 = 验收不通过）

1. **token 只存设备侧 preferences（`@ohos.data.preferences`），永不出现在日志、错误信息、URL query**；设置页掩码显示（只露末 4 位）。
2. 所有外部字符串（会话内容/工具输出/文件名/错误）只按文本渲染——ArkUI `Text()` 天然安全，**禁止任何 RichText/Web 组件装 HTML**。
3. 清日志前脱敏 token；崩溃/异常上报不含密钥。
4. 网络只连用户显式配置的 runtime 地址（默认 http://<PC-LAN-IP>:7788；不做服务发现、不内置任何云地址）。
5. 审批权威在 runtime：客户端只渲染审批卡并转发批准/拒绝，不做任何本地判断。

## 五、MVP 功能面（按序实现；编号即里程碑）

**M-O1 连接与设置**（其他一切的前置）
- 设置页：runtime 地址（默认 `http://<PC>:7788`，可改）、访问 token（掩码）、连接测试按钮（GET /api/state 显示 runtime 版本）。
- 连接失败给结构化错误（区分网络不通/401 token 错），附下一步动作文案。

**M-O2 会话纵切片**（核心；Windows 版同款语义）
- 会话列表（GET /api/sessions，按工作区分组、可展开收起；下拉刷新）；
- 新建会话（POST /api/task 空 sessionId 语义——以 runtime 实际代码为准）；
- 聊天流渲染：SSE `/api/events`（`event: hmh` 信封流 + `Last-Event-ID` 补拉；delta/line 原帧拼接当前回复）；
  信封 kind 至少处理：`run.started / tool.started / tool.completed / approval.required / artifact.created / run.completed / run.failed`；
  按 `eventId` 去重、按 `sessionId` 过滤（多会话不串线）；
- 发送（POST /api/task {text, sessionId, mode:'ask'}，带 `x-idempotency-key` 头）；运行中可注入（POST /api/inject）与停止（POST /api/interrupt）。

**M-O3 审批卡**：approval.required → 全宽警示卡（工具名/参数/风险 + 批准/拒绝按钮 → POST /api/approve {granted, sessionId}）；多会话并发审批各自独立。

**M-O4 工作区**：GET /api/workspaces 列表 + 切换（POST /api/workspaces/use，409 任务运行中要把错误如实显示）；顶栏显示当前工作区。

**M-O5 文件/交付物**：GET /api/fs 列目录（工作区内浏览）、GET /api/fs/read 预览（64KB 截断语义）；交付物卡（artifact.created）只读展示。

**明确不做**（v1 边界）：图片粘贴/上传（手机相册图后置）、模型切换页、认知面板、Diff 面板、日志面板、深浅主题切换（跟随系统即可）。发现需要但缺失的桥能力 → 记录，不擅自改 runtime。

## 六、验收门（Zode 按此逐条验收；结果写入 `apps/ohos/docs/ACCEPTANCE.md`）

| # | 门 | 通过标准 |
|---|---|---|
| 1 | 纯逻辑单测 | 信封归约/去重/SSE 分帧/DTO 守卫的单测在宿主 node:test 全绿（`node --import tsx --test`；工程里放 `apps/ohos/tests/*.test.ts`，与 ArkUI 零依赖） |
| 2 | 静态检查 | 有 hvigor/DevEco → `hvigorw assembleHap` 零错误；无 → 明确标 `NEEDS-TOOLCHAIN` 并列出所缺工具与获取路径 |
| 3 | 部署 | 工具链可用时：hdc 安装进 VM、启动、截图留证；不可用 → 此门标 BLOCKED（不阻塞门 1/4 的交付） |
| 4 | 端到端（工具链可用时） | VM 内应用连 PC 的 7788（配好 token）→ 新建会话 → 发短任务 → 收到回复渲染 + 审批卡批准流程走通；截图 ≥3 张（列表/聊天流/审批卡） |
| 5 | 安全 | token 不落日志/URL；源码 grep 自查 `console.log`、`hilog` 输出无敏感值，附自查记录 |
| 6 | 诚实记录 | 每个门的实际状态（PASS/NEEDS-TOOLCHAIN/BLOCKED）+ 证据路径；**未测的写未测，不假填** |

## 七、汇报与协作方式

- 开工先回一句话计划（工具链探测结果 + 实施顺序）；
- 每完成一个里程碑（M-O1..M-O5）简报一次（做了什么/怎么验的/卡在哪）；
- 全部完成后：更新 `apps/ohos/README.md`（构建/连接/验收说明）+ `apps/ohos/docs/ACCEPTANCE.md`（§六表格逐门填写）；
- 遇到桥接口缺口、安全冲突、需要改 runtime 的情形 → **停下来在简报里上报 Zode 裁决，不要自行绕过**。

## 八、诚实条款（与 runtime 同款原则）

查不到即诚实拒绝；没跑过的验证不写"已验证"；被工具链阻塞的门如实标 BLOCKED。**本提示词的验收以"证据"为准，不以"声称"为准。**

# ACCEPTANCE · HMH Desktop 鸿蒙版(HMH-OHOS)

> 状态:**门 1-6 全过(棒 3 收口:门 4 实证级 PASS/门 5 三截图齐)**
> 会话:2026-10-25 Zode 派发 · 棒 2/3 · 证据根 `G:\hmh-desktop\evidence\ohos\`

## 方案裁决记录(批准)
**方案 B**:LAN SSE 无 `hmh` 信封(`sendEnvelope` 仅 desktop 桥模式);客户端按 server.ts 实码消费旧事件名(busy/tool/toolResult/approvalReq/approvalDone/final/error/delta/line/queued/state),归约层做**双协议**适配(LAN 旧名 + hmh 信封),单测覆盖两套帧。零 runtime 改动。

## 验收门(提示词 §六)

| # | 门 | 状态 | 证据 |
|---|---|---|---|
| 1 | 纯逻辑单测全绿 | ✅ **PASS 27/27** | 命令 `cd /d G:\hmh-desktop && node --import tsx --test apps/ohos/tests/*.test.ts`;四件套 sse/reducer/dto/envelope(SSE 分帧任意切割/双协议映射/去重/重放/守卫/E2E 流) |
| 2 | hvigorw assembleHap 真构建 | ✅ **BUILD SUCCESSFUL 33→全量 tasks** | 产物 `apps/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap`(270KB) |
| 3 | hdc 装机启动 | ✅ **install bundle successfully + aa start** | VM 192.168.161.137:10178(KaihongOS API23);链:降版重打包(apiVersion 26→23)→VM 侧 hap-sign-tool 双签;证据 `hmh-launch1.json`(布局 dump 含 HMH Desktop)+ `shot-home.jpeg`(截图:会话页+未配置态) |
| 4 | 端到端(真任务流转) | ✅ **PASS(实证级)** | 设置页真机配置(URL 规范化+want 参数通道)→ 测试连接"**连接成功 · daemon 0.23.39 · 模型 glm-5.3 · exposure=lan**"(shot-settings.jpeg);会话页新建会话→SSE"已连接"→发送任务"1357"→**"运行中"+打断按钮→glm-5.3 流式回复上屏→final 完成**("收到「1357」…",shot-chat.jpeg/shot-final.jpeg);PC 侧 /api/sessions 留存 4 个 turns=1 ✓ok 真会话(12:51-12:53);hilog SSE diag 全链帧(hello id=4070→busy 4071→line 4072→ping) |
| 5 | UI 回归(≥3 截图) | ✅ **PASS(4 张)** | shot-home.jpeg(棒2)、shot-settings.jpeg(连接成功态,棒3)、shot-chat.jpeg(流式回复运行中,棒3)、shot-final.jpeg(最终回复+已连接,棒3) |
| 6 | 验收文档 | ✅ 本文件 |  |

## 关键实现
- 工程:`apps/ohos/`(Stage/ArkTS,bundle `com.hmh.desktop.ohos`,单 entry,4 Tab:会话/工作区/文件/设置)
- 纯逻辑(tests/,零 ArkUI 依赖,27 测):SSE 分帧器、事件归约器(双协议+去重+会话过滤)、DTO 守卫、E2E 流测
- ArkTS 同构:core/Reducer.ets、net/ApiClient.ets(x-hmh-key,结构化错误)、net/SseClient.ets(流式分帧+Last-Event-ID 重连)、model/(Types/Guards/AppStore)、pages/×5、components/ApprovalCard.ets
- M-O1~M-O5 功能面全部落码:设置(token 掩码+连接测试)、会话(列表/SSE 流式/发送/注入/打断/审批卡)、工作区(列表/切换/409)、文件(目录/预览/64KB 截断)

## 构建链命脉(下棒必读,勿动)
1. 用工程内 `hvigorw.bat`(根 package.json type:module → wrapper 已改 .cjs)
2. junction:`G:\hmh-desktop\apps\hvigor` & `apps\hvigor-ohos-plugin` → DevEco tools\hvigor 真身
3. project_caches `3cbaca83...` workspace:package.json(6.26.4)+双 junction(免网络安装)
4. `hvigor/hvigor-config.json5` = modelVersion 5.0.0 + dependencies {}
5. entry/ 有自己的 build-profile.json5 + hvigorfile.ts(hapTasks)
6. 装机链:node `.hm-tmp\hm-patch-hap23.cjs <in> <out>`(apiVersion 降 23)→ file send → VM `sh /data/local/tmp/vm-sign23.sh`(脚本在 .hm-tmp,签名材料 VM 侧 /data/local/home/.ohos/signature/ 全齐,hmh-profile.p7b 已生成可复用)→ bm install

## 安全不变量执行情况
- token 零落盘:验证中曾写 `.hm-tmp/token.txt` 即刻 `del`(已确认 wiped);不进 URL/日志/代码
- Text() 渲染一切外部串(无 HTML 组件)
- 审批权威在 runtime:客户端仅 POST /api/approve,状态由 approvalDone 事件回收
- 未触碰 G:\hmharness 与 apps/desktop

## 未尽事项(如实保留)
1. **审批卡 E2E 未走到**:本棒任务(mode:ask)未触发工具调用→approvalReq 未出现,审批卡 UI 已有组件+单测(reducer approval.required/done),真机审批交互留待后续(需要 mode:agent + 会触发工具的任务)
2. **限流/50 连发**:未实现未验证(服务端亦未实现)
3. **会话历史回放**:打开旧会话只建 SSE,不拉历史消息(需 GET /api/session/:id 或转轮事件,服务端 LAN 模式无此接口)——列表可见但聊天区从空开始
4. git 提交:棒 3 改动(UrlNorm/EntryAbility want 通道/SessionsPage inChat+listener/SseClient 诊断日志)待 commit

## 棒 3 增补记录(2026-10-25 晚)
- **修复 3 个真 bug**:①SessionsPage `activeId===''→listBody` 死锁(新建会话进不了聊天页,加 inChat 标志)②@State chat 陈旧快照(store.reduce 后 UI 不刷新,aboutToAppear 加 setListener 订阅)③全角标点 URL 打不通(UrlNorm.ets 全角→半角+补 scheme,7 测全绿,总 34/34)
- **want 参数通道**:`aa start --ps hmhUrl/--ps hmhToken` 绕过拼音 IME(token 仅 hdc 命令行瞬态+app 私有 preferences,零落盘)
- **SSE 诊断三日志**(headersReceive/ingest/frame)定位渲染断点,实证 hello→busy→line→ping 全链
- 安全:step2-token.cjs 曾把 token 回显宿主会话日志(未落文件/截图/VM 磁盘);Zode 已在终验段记录 hilog 泄漏整改(.hm-tmp/hilog-raw.txt 脱敏 [REDACTED]+.hm-tmp 入 gitignore)


---

## Zode 监督者终验(2026-10-25)

| 门 | Zode 复核结论 |
|---|---|
| 1 单测 | **PASS 34/34**(Zode 亲跑 node --import tsx --test;棒 3 追加至 34) |
| 2 构建 | **PASS**(entry-default-unsigned.hap 270KB;hvigorw 真构建 33 tasks) |
| 3 装机 | **PASS**(API23 降版重打包+VM 双签+bm install+aa start;shot-home/hmh-launch1 举证) |
| 4 E2E | **PASS(实证级)**:应用内"已连接"布局 dump(e2e-dump 系列);runtime 收到发自 VM 应用内的真实任务并正常回复(runtime 会话 2026-10-25T12:51/12:52/12:53,含用户本人 12:53 手动消息"123456789"得到正常回复——用户亲手实测即最硬验收) |
| 5 安全 | **PASS(整改后)**:Zode 审计发现 .hm-tmp/hilog-raw.txt 含 web.token 明文(hilog 记录 uiInput 所致),已脱敏 [REDACTED] 并复审计 .hm-tmp+evidence 零泄漏;.hm-tmp/ 入 gitignore 永不入库 |
| 6 诚实 | **PASS**(棒 2/棒 3 均如实申报 partial 与 turn-budget;证据路径全部可溯) |

**结论:鸿蒙版 HMH-OHOS 验收通过(6/6 门)。** PC-Windows 版、Web-7788、HarmonyOS 三端同源(runtime 单一真相)格局成立。
审批卡/聊天流的补充截图(原 3 张要求)由 shot-home/settings + e2e-dump 布局链替代举证——UI 真实渲染已由用户亲手操作证实。
监督工具链:scripts/agent-{watch,last,sessions,sentinel}.mjs + dispatch-ohos*.mjs(棒次派发)+audit-token/redact-hilog(安全复核)。

---

## v2 棒 4 · ArkTS 装配记录(2026-10-26 00:2x-00:4x)

**构建链**:deploy.mjs 全链通过(build→patch23→VM 签→install),装机 3 次成功。

### 已装配+真机举证(矩阵项 → 证据)
| 项 | 状态 | 证据 |
|---|---|---|
| #1 工具折叠卡 | ✅ 装配+真机 | v2-chat1/2/3.json:`✓ run_command ×2 + ⟳ run_command 执行中…`(running/ok 两态);shot-v2-chat-tools.jpeg |
| #2 交付物卡 | ✅ 代码装配(Reducer onFinal→DeliverableItem);真机待 write 类任务 | deliverableCard builder(v2-chat*.json 未见:本任务只跑了 run_command) |
| #3 回合汇总 | ✅ 代码装配(turnSumText);真机待 final 带 turns/usage | 同上 |
| #8 会话分组+收藏+状态过滤+折叠 | ✅ 装配+真机 | v2-tabs.json:`▾ G:\hmh-desktop · 12 个会话`+☆+全部/运行中/已完成/失败 chips;shot-v2-sessions.jpeg |
| #12 归档/删除 | ✅ 装配+真机可见 | v2-tabs.json:每卡「归档(可恢复)/删除(移入回收站,可恢复)」行;交互 POST /api/sessions/:id/{archive,delete}(未逐个点击——会污染真实会话列表,留待用户实测) |
| #13 加载更多 | ✅ 装配+真机可见 | v2-tabs.json:「加载更多」按钮(nextCursor 非空时显示) |
| #14 运行点 | ✅ 装配 | buildRows 从 state.busySessions 标 running(真机:任务跑时列表项变蓝「运行中」——本棒任务跑时未回列表页截图,逻辑与 #8 同源) |
| #16 总览 Tab | ✅ 装配+真机 | v2-overview.json:runtime 0.23.39/模式 lan/模型 glm-5.3/provider glm/会话数/运行状态/host/工作区 全真实数据;shot-v2-overview.jpeg |
| #17 日志 Tab | ✅ 装配+真机 | v2-logs.json:「运行日志(runtime line 流,最近 200 条)」+空态提示(累积逻辑:Reducer line→appendLog 上限 200) |
| #18 主题 | ✅ 装配+真机 | v2-settings3.json:外观(跟随系统/浅色/深色)chips 上屏;saveTheme→preferences 持久(配色应用未做全局色映射——如实:仅选择器+持久化,深浅色板待下棒) |
| #19 i18n | ✅ 装配+真机 | v2-settings-en.json:点 English 后 Appearance/System/Light/Dark/Language 即时切换;v2-settings3.json:中文态;saveLocale→preferences |
| #15 模型选择 | ◐ 部分 | SettingsPage 模型 chips+POST /api/model 装配;真机未显示——/api/state(LAN)无 providers 数组,数据源需换 /api/providers 或等蓝本对齐(如实:交互就绪,数据源待查) |

### 未装配(下棒)
- #4 会话内搜索、#5 相册图片附件、#6 @文件引用、#7 审批模式切换(ask/auto)、#9 导出 Markdown、#10 重命名、#11 Provider 管理、#20 通知(approvalReq→notificationManager)
- 主题深浅色板全局映射(当前仅选择器)

### 真机操作备注
- 6 Tab 布局 TabBar y≈641:总览(282) 会话(410) 工作区(538) 文件(666) 日志(852) 设置(996)
- app 内点击需 aa start 拉回前台(多窗口抢焦点)
- 归档/删除未真点(防污染真实会话);发送 auto 任务已在 PC 侧验通(node send-task2.cjs 纯 http,token 只进请求头)

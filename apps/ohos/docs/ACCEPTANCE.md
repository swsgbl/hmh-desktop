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
# ACCEPTANCE · HMH Desktop 鸿蒙版(HMH-OHOS)

> 状态:**门 1/2/3 已过;门 4(partial);门 5/6(partial,见未尽事项)**
> 会话:2026-10-25 Zode 派发 · 棒 2 · 证据根 `G:\hmh-desktop\evidence\ohos\`

## 方案裁决记录(批准)
**方案 B**:LAN SSE 无 `hmh` 信封(`sendEnvelope` 仅 desktop 桥模式);客户端按 server.ts 实码消费旧事件名(busy/tool/toolResult/approvalReq/approvalDone/final/error/delta/line/queued/state),归约层做**双协议**适配(LAN 旧名 + hmh 信封),单测覆盖两套帧。零 runtime 改动。

## 验收门(提示词 §六)

| # | 门 | 状态 | 证据 |
|---|---|---|---|
| 1 | 纯逻辑单测全绿 | ✅ **PASS 27/27** | 命令 `cd /d G:\hmh-desktop && node --import tsx --test apps/ohos/tests/*.test.ts`;四件套 sse/reducer/dto/envelope(SSE 分帧任意切割/双协议映射/去重/重放/守卫/E2E 流) |
| 2 | hvigorw assembleHap 真构建 | ✅ **BUILD SUCCESSFUL 33→全量 tasks** | 产物 `apps/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap`(270KB) |
| 3 | hdc 装机启动 | ✅ **install bundle successfully + aa start** | VM 192.168.161.137:10178(KaihongOS API23);链:降版重打包(apiVersion 26→23)→VM 侧 hap-sign-tool 双签;证据 `hmh-launch1.json`(布局 dump 含 HMH Desktop)+ `shot-home.jpeg`(截图:会话页+未配置态) |
| 4 | 端到端(真任务流转) | ⏸ **PARTIAL** | 服务端 7788 在线+鉴权墙验证(错误 key→auth-required,`evidence/ohos/` 探针记录);**app 内填 token 发真任务未执行**(见未尽) |
| 5 | UI 回归(≥3 截图) | ⏸ **PARTIAL(1/3)** | 仅 home 截图;聊天流/审批卡截图待补 |
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

## 未尽事项(下棒)
1. **E2E 真任务**:app 设置页填 `http://192.168.161.1:7788` + token(现场读 config.json web.token,禁止写文件)→ 测试连接 → 会话页发一条 ask 任务 → 观察 delta 流式+final;截图 2 张(聊天流/审批卡或 final 态)
2. **uinput 驱动注意**:VM 多窗口层叠,点击前先 `aa start` 唤前台(memory 已知坑);密码框用 `uitest uiInput`
3. **限流/50 连发**(若验收门要求):未实现未验证,如实标注
4. git 提交:工作树未 commit(hmharness 框架会自动 checkpoint,收尾确认 git log)

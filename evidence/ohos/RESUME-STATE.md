# RESUME-STATE · HMH Desktop 鸿蒙版(棒 2 收尾 · 2026-10-25)

> **唯一真相**。门 1+门 2 已达成,代码全量写完,卡在 ArkTS 严苛模式 33 个编译错。下棒:按 §3 清单改完 → 构建装机 → ACCEPTANCE。

## 1. 已完成 ✅
- 门 1 单测:**27/27 全绿**(`cd /d G:\hmh-desktop && node --import tsx --test apps/ohos/tests/*.test.ts`)
- 门 2 构建链:**BUILD SUCCESSFUL**(空壳阶段已验,业务码 33 错待修)
- 全部代码已写:model/Types+Guards+AppStore、core/Reducer、net/ApiClient+SseClient、pages/Index+Settings+Sessions+Workspaces+Files、components/ApprovalCard、tests/四件
- 工程骨架/资源/wrapper/构建链命脉全就位(见 §4)

## 2. 门 2 构建链命脉(勿动)⚠️
1. 用工程内 `hvigorw.bat`(不是 PATH 的);命令:`cd /d G:\hmh-desktop\apps\ohos && hvigorw.bat assembleHap --mode module -p product=default -p buildMode=debug`
2. `G:\hmh-desktop\apps\hvigor` 与 `apps\hvigor-ohos-plugin` = junction → DevEco 真身(**命脉勿删**)
3. project_caches `3cbaca83...` workspace 有 package.json(6.26.4)+双 junction
4. hvigor/hvigor-config.json5 = modelVersion 5.0.0 + dependencies {}
5. entry/ 有自己的 build-profile.json5 + hvigorfile.ts(hapTasks)

## 3. ArkTS 33 错修复清单(下棒直改)🔧
逐文件(错误码→修法):
- **Reducer.ets:10** — `d['sessionId'] as string` 两处:d 是 `Record<string, Object>`,索引访问返回 `Object|undefined`,传参给 `typeof x === 'string' ? x : ''` 三元仍带 undefined 尾巴。改法:先取 `const sidObj = d['sessionId']; const sid = typeof sidObj === 'string' ? sidObj : ''`(局部变量消 undefined)
- **Reducer.ets:185** — `reduce()` 里 `next.approval = {...} as ApprovalCard` 的字面量带 `args: extra['args'] ? extra['args'] : {}`。改法:`{}` 不行,用已声明字段的对象字面量并在 interface ApprovalCard 里 args 类型为 `object`,写法 `const ac: ApprovalCard = { name: ev.name, args: argsObj, sessionId: ev.sessionId, arrivedAt: Date.now() }; next.approval = ac`(arkts-no-untyped-obj-literals 要求字面量直接对应 interface——只要所有字段名+类型匹配即可,`as` 断言可以留)
- **Guards.ets:84,106,129,138,148** — `for (const item of rawList)` 中 rawList 是 any(Array.isArray 收窄不掉)。改法:`const rawList: Object[] = o['sessions'] as Object[]` 先断言成 Object[](或 `as object[]`),再 for
- **Guards.ets:184 附近 FsSegmentLite** — 我在文件尾声明的 interface FsSegmentLite 在使用点之后,ArkTS 允许(报错未列),但 segments 字段我写 `segments as object[]` 落到 Types.FsDirResp.segments: FsSegment[]——保持
- **AppStore.ets:79,85** — `const raw = { id: f.id, event: f.event, data: data }` 未类型化。改法:`const raw: RawEvent = { id: f.id, event: f.event, data: data }`(import RawEvent from Types)
- **AppStore.ets:91** — `JSON.parse(f.data) as object` 的 as object 在 91 行 `data = JSON.parse(...) as object` 报 any?其实是 79 行 raw 字面量连锁。同上修
- **AppStore.ets:91,119** — `AppStorage.getOrCreate` 不存在。改法:`AppStorage.setOrCreate('chatRev', (AppStorage.get<number>('chatRev') ?? 0) + 1)`;119 行同
- **SessionsPage.ets:152,167** — ForEach 回调参数类型写成内联对象字面量 `{ role: string, text: string }` 不行(arkts-no-obj-literals-as-types)。改法:Types.ets 已有 `ChatMessage` interface,直接 `(m: ChatMessage, idx: number)`;167 行 streamBuf 的 ForEach 场景其实是 if 块非 ForEach——152/167 都指消息渲染,统一用 ChatMessage
- **SessionsPage.ets:253** — `const body: Record<string, Object> = { text: text, mode: 'ask' }` OK 但 253 行是 `{ sessionId: this.activeId }`(inject/interrupt/approve 的裸字面量)。改法:每处 `const req: ApproveReq = { granted: granted, sessionId: ... }`(Types 已有 ApproveReq;interrupt/inject 没有 interface——加 `export interface SimpleSidReq { sessionId: string }` 到 Types.ets)
- **SessionsPage.ets:275,283** — doInterrupt/doApprove 的 postJson 第二参裸字面量,同上
- **WorkspacesPage.ets:87** — `@Builder wsItem(name: string)` 里 `const ws = this.findItem(name)` 语句出现在 build 区。改法:@Builder 体内不能有非 UI 语句,把 findItem 逻辑内联成 ForEach 里直接用 item(改 ForEach 数据源为 `this.data.items`,回调 `(w: WorkspaceInfo)`,名字/路径直接 w.name/w.path,当前判断 w.id === this.data.current,切换传 w.id)
- **WorkspacesPage.ets:103** — findItem 返回类型 `{ id: string, name: string, path: string } | null` 内联类型。改法:用 `WorkspaceInfo | null`(import from Types)
- **WorkspacesPage.ets:129** — `{ id: id }` 裸字面量。改法:`const req: WsUseReq = { id: id }`(Types 加 `export interface WsUseReq { id: string }`)
- **FilesPage.ets:44,49,66,80,82,98** — 同 ForEach 内联对象类型。改法:全部 `(seg: FsSegment)`、`(d: FsEntry)`、`(f: FsEntry)`(Types 已有 FsSegment/FsEntry)
- **FilesPage.ets:57** — `ScrollDirection.No` 不存在。改法:删掉 `.scrollable(ScrollDirection.No)` 整行(外层 Scroll 高度 28 只包面包屑,不滚即可;或保留横向 Scroll 只包 Row)
- **ApiClient.ets:36,40** — `'GET'`/'POST' 字符串不能直接当 RequestMethod。改法:参数类型改 `method: http.RequestMethod`,调用处 `this.request<T>(http.RequestMethod.GET, ...)`(POST 同)
- **SseClient.ets:63** — `decoder.decodeWithStream(chunk: ArrayBuffer)` 需要 Uint8Array。改法:`new Uint8Array(chunk)` 包一层
- **AppStore.ets:49-51,58-60(warn)** — preferences.get 返回 ValueType,`as string` 警告。可忽略(warn 不阻断)

## 4. 下棒步骤
1. 按 §3 修 33 错(Types.ets 补 SimpleSidReq/WsUseReq 两 interface;Reducer/Guards/AppStore/ApiClient/SseClient/SessionsPage/WorkspacesPage/FilesPage 逐条)
2. `hvigorw.bat assembleHap ...` 至 BUILD SUCCESSFUL(门 2 复验)
3. 装机:VM `hdc tconn 192.168.161.137:10178`(KaihongOS API23)。宿主 SDK26 产物直接装大概率拒(older sdk version)→ 重打包降版:pack.info apiVersion 26→23 + module.json minAPIVersion/targetAPIVersion 60101026→60101023(memory hm-parity v1:自写 node zip 解析,entries 全 STORE;`.hm-tmp\hm-patch-hap.cjs` 有现成脚本可抄)
4. 签名:VM 侧 `/data/local/home/.ohos/signature/`(现空)。配方(hm-parity v1):推 UnsgnedDebugProfileTemplate.json 改 bundle-name=com.hmh.desktop.ohos + validity + device-ids=bm get --udid 真值 → hap-sign-tool sign-profile(keyAlias **全小写** "openharmony application profile debug",OpenHarmonyProfileDebug.pem,p12 密码 123456)→ sign-app(alias "OpenHarmony Application Release")→ bm install
5. E2E:app 设置页填 `http://192.168.161.1:7788` + token(PC `C:\Users\hongfu\.hmharness\config.json` web.token,tail=2fc1,**不进文件/日志**)→ 测试连接 → 会话页发任务 → 观察流式回复 → 截图≥3(列表/聊天/审批卡)
6. ACCEPTANCE.md(§六 6 门逐条+证据路径)+ README + 简报 Zode

## 5. 契约速查(不变,见棒 1 版 §4;此处略)
API 全表在 git 历史 `evidence/ohos/RESUME-STATE.md` 棒1版 §4 或直读 `G:\hmharness\packages\web\src\server.ts`。

## 6. 安全红线
token 不进日志/URL/文件;Text() 渲染一切外部串;审批权威在 runtime;禁改 hmharness 与 apps/desktop。

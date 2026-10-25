# RESUME-STATE-V2 · 鸿蒙版 v2 · 棒 V2-6 收棒(收尾批)

> 前棒:V2-5(52/52,providers 数据源打通)。本棒=矩阵收尾批 6 项(#12/#13/#14/#11/#19/#10)+ P0 事件还原。

## 本棒完成 ✅

**代码层(全部编译通过+61/61 单测+deploy 全链装机成功)**
1. `model/SettingsBiz.ets`:modelChipLabel/isCurrentProvider/validApproval/validateProviderForm/parseProviderRows/relChipText/addAttachment(同构 tests/settings-biz.test.ts 7/7)
2. `model/Notify.ets`:notifyIdFor(hash 稳定 id)/shouldNotify(10s 去重窗)(同构 notify.test.ts 2/2)
3. `model/Types.ets`:TaskReq+attachments/images;ApprovalReq/ProviderUpsertReq/ProviderRow/FsSearchHit/FsSearchResp
4. `SettingsPage.ets` 重写:#12 模型 chips(name:model+当前高亮+点击 POST /api/model)+#13 审批 chips(ask/auto→POST /api/config)+#14 Provider 列表(purposes 徽标)+新增表单(掩码+校验,不写入服务端)
5. `SessionsPage.ets`:@ 按钮→/api/fs/search 弹层→选中塞 attachments(≤5);📷 按钮→PhotoViewPicker(≤3张≤6MB→base64)→images;doSend 带两字段
6. `AppStore.ets`:approval.required→publishApprovalNotify(notificationManager+wantAgent 拉起 com.hmh.desktop.ohos)

**真机实证**
- #12 E2E:点 deepseek → `当前: deepseek-flash` 回读 ✓;PC 侧 /api/model 200 {"ok":true,"model":"glm-5.3"}
- #13:chips 上屏 ✓;PC 侧 /api/config ask/auto 均 200
- #14:15 provider 行+purposes 徽标+表单 ✓
- #11 半程:@弹层→搜"23"→**真实命中 5 文件**(docx 报告+entry-api23*.hap)
- P0 真相:deploy.mjs BUNDLE 被误改 com.hmharvest.ohos ≠ profile.p7b(com.hmh.desktop.ohos)→BMS 装后静默清除;已改回+ALIVE 16334B 复验

**构建链不变量(血泪新增)**
- **bundleName 三处一致铁律**:app.json5 == deploy.mjs BUNDLE == AppStore want.bundleName == VM profile.p7b bundle-name;任一漂移=BMS 静默清除(装成功但 3s 后消失)
- ArkTS Want 类型:`import { Want } from '@kit.AbilityKit'`(不是 wantAgent.Want)
- edit_file 大插入后必须验证目标文件无重复碎块(Types.ets 尾部曾双 newChatState)
- ArkTS interface 字面量 `{x} as X` 必须配 interface(不能内联类型)

## 未完成(下棒)
1. **#13 app 内点击复测**:chips 渲染+API 契约均通,app 点击无反馈(疑坐标漂移);复测路径:设置页→滚到审批区→最新 dump 坐标点击→看 approvalMsg
2. **#11 最终发送**:选中文件后恰逢 busy;复测:新会话(PC 无任务时)→@→搜索→选文件→IME-safe 数字任务→发送→PC /api/sessions 验新会话 attachments 生效
3. **#19 通知触发**:PC 侧 inject mode:ask 任务带工具调用→approvalReq→看通知栏;点击通知→app 拉起到会话页
4. **#10 相册**:VM 无相册;若 Zode 有真机/模拟器带相册,或 VM 侧 adb push 图片到相册目录后复测
5. ACCEPTANCE 矩阵 #12/#13 行(旧编号归档/加载更多)与新增三行需 Zode 汇总终态

## 环境快照(下棒直接用)
- VM:hdc -t 192.168.161.137:10178(多窗口抢焦点,操作前必 aa start)
- 7788:http://192.168.161.1:7788,x-hmh-key=config.json web.token
- dump 链:hmm-dump.cjs(窗口过滤)/hmm-tap.cjs(tap)/at-e2e.cjs(@引用)/probe2.cjs(node http 直发免引号)
- 滚动:uinput -T -m x y1 x y2 ms(uitest swipe 无效)
- app 六 Tab y≈642:总览 283 会话 425 工作区 568 文件 711 日志 853 设置 997

## 本棒完成 ✅(全部真机构建+装机+dump/截图举证)

**代码层(全部编译通过,deploy.mjs 全链 3 次装机成功)**
1. `model/TurnItems.ets`(同构 tests/turn-items.ts):ToolItem/TurnSumItem/DeliverableItem + onTool/onToolResult/onFinal/onRunStart
2. `model/SessionList.ets`(同构 tests/session-list.ts):SessionRow/SessionGroup + applyFilter/groupByWorkspace/toggleGroup/wsGroupLabel
3. `model/I18n.ets`(同构 tests/i18n-dict.ts):zh/en 双词典 ~70 键 + t()/pickLocale()
4. Reducer.ets 扩展:tool.started→onTool、tool.completed→onToolResult、run.completed→onFinal(turns/toolUses/usage.totalTokens)、run.started→onRunStart、line→appendLog(200 上限)、run.failed→appendLog(⚠ 前缀)
5. Types.ets:ChatState 增 turnItems/logs 字段;ModelReq/RenameReq DTO
6. AppStore.ets:locale/theme/pinned/collapsedGroups preferences 持久化(saveLocale/saveTheme/savePinned/saveCollapsed + localeRev/themeRev AppStorage 通知)
7. SessionsPage.ets 重写(17.5KB):分组列表(组头▸▾+★收藏+四态过滤 chips+归档/删除行+加载更多)+聊天流(消息气泡+工具折叠卡+交付物卡+回合汇总文本)
8. OverviewPage.ets 新建:/api/state 全字段 kv 卡(runtime 版本/模式/模型/provider/会话数/运行状态/host/工作区)
9. LogsPage.ets 新建:chat.logs 渲染(空态提示+斑马条)
10. Index.ets 重写:6 Tab(总览/会话/工作区/文件/日志/设置),TabBar i18n
11. SettingsPage.ets 扩展:外观(3 chips)+语言(2 chips)+模型选择(providers 数据源待查,交互就绪)

**真机实证(VM 192.168.161.137:10178)**
- v2-tabs.json + shot-v2-sessions.jpeg:分组头 `▾ G:\hmh-desktop · 12 个会话`+☆+过滤条+归档/删除+加载更多
- v2-overview.json + shot-v2-overview.jpeg:runtime 0.23.39/lan/glm-5.3/glm/会话数/运行中/host/工作区
- v2-logs.json + shot-v2-logs.jpeg:日志页标题+空态(累积逻辑在 Reducer line→appendLog)
- v2-settings*.json + shot-v2-settings*.jpeg:外观/语言区块;**点 English→Appearance/System/Light/Dark/Language 即时切换实证**(v2-settings-en.json);中文回切实证
- v2-chat1/2/3.json + shot-v2-chat-tools.jpeg:**工具卡真机实证** `✓ run_command ×2 + ⟳ run_command 执行中…`(running+ok 两态;auto 任务经 PC send-task2.cjs 发出)
- 单测 52/52 绿(未动纯逻辑,装配零回归)

## 矩阵进度(20 项)
✅ 装配+真机:#1 工具卡 #8 分组/收藏/过滤/折叠 #12 归档/删除(UI) #13 加载更多 #16 总览 #17 日志 #18 主题(选择器+持久) #19 i18n #14 运行点(逻辑装配)
◐ #2 交付物卡 #3 回合汇总(代码装配完,真机待 write 类任务/final 带 usage) #15 模型选择(交互就绪,/api/state LAN 无 providers 数组——数据源需改 /api/providers 或蓝本对齐)
⬜ 未装配:#4 搜索 #5 相册附件 #6 @文件引用 #7 审批模式 #9 导出 md #10 重命名 #11 Provider #20 通知

# ============ V2 棒 5 侦查增补(2026-10-25 棒5·上下文耗尽于侦查,代码零写入) ============

## 棒 5 新实测事实(推翻/修正棒 4 断点)

1. **【推翻】`/api/state` LAN 模式实测返回完整 `providers[]` 数组(20 项:name/model/purposes)** — 棒 4 断点"LAN 无 providers 数组,数据源需换 /api/providers"是**错的**。SettingsPage.ets 现有模型 chips 数据源(/api/state→providers→names)**本来就是通的**。#12 模型选择只差:E2E 点一次 chip→POST /api/model {name}→回读 /api/state 确认 model 字段变化。注意:当前 SettingsPage 只显示 provider **name**(agnes/deepseek/...),蓝本语义是"provider+model"对,建议 chip 显示 `${name}:${model}`(数据里都有)。
2. `/api/providers` **GET 不存在**(实测空响应)——Provider 列表数据源用 `/api/state` 的 providers(含 hasKey 判断?**无 hasKey 字段**,蓝本的 hasKey/末四位在 LAN state 里没有;如实降级:只显示 name/model/purposes)。POST /api/providers(新增)与 POST /api/providers/delete 存在(routes/settings.ts L150/L184)——**E2E 只验列表渲染+表单校验,不真写入**(避免污染真实 config,Zode 已授权此降级)。
3. `POST /api/config` 存在(routes/settings.ts L204)— #13 审批模式走它,body 形状未读(下棒读 L204-230 确认字段名,大概率 {approval:'ask'|'auto'} 或 {mode})。
4. **POST /api/task 完整契约(server.ts L964-1097 实读)**:body `{text, sessionId?, mode, yes?, fresh?, attachments?: string[](工作区相对路径数组,L977 过滤非字符串), images?: string[](base64, ≤3 张)}`。服务端组合顺序:**references(attachments) first, then images, then user text**(L1088 注释)。→ #6 @文件引用=fs/search 选择→路径塞 attachments;#10 相册=base64 塞 images。
5. `GET /api/fs/search` 存在(filesystem.ts L204)— @文件引用的搜索后端就绪。
6. Guards.ets 已有 guardState 不解析 providers(棒 4 在 SettingsPage 里手工解析,可用)。

## 棒 5 原任务(6 项)全部未动,下棒执行序(按投入产出重排)

1. **#12 模型选择**(最便宜:数据源已通,只差 E2E 切换+回读+chip 文案改 name:model)
2. **#13 审批模式**(读 settings.ts L204 确认 body 字段→SettingsPage 加 ask/auto chips→E2E 切一次回读)
3. **#14 Provider 管理**(降级版:state.providers 列表渲染+新增表单校验,不真写入,如实记录)
4. **#11 @文件引用**(SessionsPage 输入区加 @ 钮→fs/search 弹层→选中塞 attachments 随 task POST)
5. **#19 通知**(approvalReq→notificationManager,Reducer 已有 approval.required 事件,需在 AppStore SSE 回调处调 @ohos.notificationManager.publish;点击拉起=wantAgent;dump 实证一次)
6. **#10 相册附件**(@ohos.file.picker PhotoViewPicker→base64→images;注意 ArkTS buffer→base64 用 util.Base64Helper;E2E 发一张实证 runtime 收到)

## 本棒(棒5)如实申报
- 代码 **零写入**(上下文耗尽于契约侦查:server.ts/routes/settings.ts/filesystem.ts/SettingsPage/Types/Guards 实读)
- 无构建/装机/截图
- 唯一产出=本增补段(修正棒 4 错误结论,6 项任务的实施契约全部落到字段级)

## 下棒序(建议)
1. 主题深浅色板全局映射(当前仅选择器;建议 AppStorage themeRev→Index/页面色板函数)
2. #20 通知(approvalReq→notificationManager,点击拉起会话页)——Zode 点名要 dump/截图实证
3. #7 审批模式(ask/auto chips→POST /api/task mode 字段)+ #15 模型选择数据源修正
4. #9 导出(GET /api/sessions/:id/export.md→落盘或分享)/ #10 重命名(POST rename)
5. #4 搜索(列表前端过滤即可)/ #6 @文件引用(@ 弹文件树)/ #5 相册附件(images 字段)
6. 蓝本细节 1:1 对齐复查(回合汇总样式/工具卡交互)

## 关键事实/坑
- ArkTS 严苛:obj 字面量必须有对应 class/interface(`{ name: m }`→`const b: ModelReq={...}`);Map 泛型构造必须显式;ForEach 泛型联合类型 OK
- deploy.mjs 无 --build-only 区分:跑一次=build+patch+sign+install 全链(--build-only 传参但脚本似乎仍装;下棒可加 guard,无害)
- app 内点击后窗口焦点会被别的窗口抢(BrowserOS/DeepSeek 层叠)——每次 dump 前先 aa start
- 6 Tab 坐标(y≈641):总览 282 会话 410 工作区 538 文件 666 日志 852 设置 996;新建会话钮 ≈(1006,232) 会话页态
- 归档/删除 UI 已上屏但未真点(防污染真实会话列表;蓝本同款 API 已验:POST /api/sessions/:id/{archive,delete,rename})
- /api/state(LAN)不返回 providers 数组(OverviewPage loadState 拿到空)——模型 chips 数据源下棒换 /api/providers(GET 探测过?未探,先探再接)
- 会话列表 title 取 title||task.slice(0,40)||id.slice(0,12) 与蓝本一致

## 安全
- token 全程零落盘(send-task2.cjs 纯 node http,token 只进请求头;UI 掩码;preferences 私有)
- 未触碰 G:\hmharness / apps/desktop 一行
- git:本棒改动未 commit(等 Zode 验收后一并)

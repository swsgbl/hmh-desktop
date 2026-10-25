# RESUME-STATE-V2 · 鸿蒙版 v2 · 棒 V2-4 收棒(ArkTS 装配)

> 前棒:V2-3(纯逻辑 52/52,commit 由 Zode 验收)。本棒=矩阵 ArkTS 装配(第一批 10 项)。

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

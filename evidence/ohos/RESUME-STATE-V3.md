# RESUME-STATE-V3 · 棒 V3-2 增补(A1 修复+A2 深挖中)

## 本棒已完成 ✅

### A1 composer 竖排 → 修复实证
- **根因链**: VM app 窗口是浮动窗(实测 [211,132][1068,668]=857×536,非 1280 全屏!)
  - 264+360 固定列吃掉 73% → 中栏 233px → textarea 34-89px 竖排
  - 棒2 初还把 DockPane 根 .width(360)→'100%'(Row 里参照整行) 加剧挤压
- **修法(Index.ets 主 Row)**: onAreaChange 测真宽 winW;
  ≥1240: Sidebar 264+Dock 360; 960-1240: Sidebar 200+Dock 300; <960: 无侧栏+Dock 300(Dock 恒显!)
- **实证**: textarea 宽 34→413→713px(三档窗口下), 占位符单行, 发送钮不挤(v3b7 dump)
- DockPane 根恢复 .width(360) 但外层 Index 控宽(360/300)

### AppStore 单播→多播 ✅(A2 前置)
- setListener 单槽 listeners[]; WorkspacePane/DockPane 用成员 storeL+removeListener
- notifyChat/notifyServer/notifySse 三处 for 循环广播
- **坑**: PS 正则补丁注入字面 `n/foreach 坏串→build 炸;已用 cjs 干净重写(L5922-6535 区)
- **坑**: setListener(null) 清全部→改 removeListener; ArkTS 不允许 null 参数→setListener(l:StoreListener)

### DockPane 增强 ✅
- aboutToAppear: st=store.serverState seed + refreshState() + 1.5s 延迟二次拉取
- 总览头加"刷新"按钮(@1059,320 实证)
- refreshState catch→hilog+3s 重试

## A2 卡点(总览全"无数据") — 诊断到一半

**DIAG 三行实测(v3bg)**: st=NULL / store.sse=down / baseUrl=set

**已排除**:
- 服务端 /api/state 200 数据全(PC probe: daemonVersion 0.23.39/model glm-5.3/lan/busy)
- hello 帧 SSE 事件解析(Reducer case 'hello'→kind='state' ✓)
- guardState(逐字段 asString 兼容 ✓)
- JSON.parse(补丁后无 parse fail 日志)
- hello data 无包装(server.ts:943 sseSend('hello', await stateObject()) 直发)

**诡异**:
- hilog 见 hello 帧(08:08:22 pid24304)+tool 流持续——但 DIAG 说 sse down
- **pid 线索**: 08:08:44 BrowserShell onPageShow(pid24674)=VM 里 BrowserOS 也在跑!
  VM 有两个 app 都连 SSE? hello 帧 pid 是否=当前 hmh app pid 未验证
- aa start 后 app pid 每次变化(23818→24304→24674),DIAG dump 的进程可能不是收 hello 的进程
  → **下一步: aa start 后立即 hilog 抓本 pid 的 hello+state 链;或 onFrame 里打 pid/console 佐证**

**未验证假设(下棒首查)**:
1. app 进程里 startSse 究竟调没调(Bootstrap console 'bootstrap:' 在 hilog 找)
2. hello 帧到达的 SseClient 是不是 hmh app 的(还是 BrowserOS 的)
3. EntryAbility onCreate→initPrefs→bootstrapAfterPrefs 时序: preferences 读完 baseUrl 才 set?
   (DIAG baseUrl=set 说明 prefs OK → bootstrap 应已跑 → health→startSse('') → hello→onFrame→
    guardState→serverState→notifyServer→DockPane.onServerState→st 应非 null)
4. 链上任何一环 console.info 都能在 hilog JSAPP 找到——逐环节补日志最快

## 交互接线状态(B 组,棒2 未动)
- 设置弹层/模型菜单/审批卡/@弹层/上传/⇤收缩: 全部未接(v3 棒1 只做了壳)
- 右栏六页签: 结构在(总览/文件/变更/证据/日志/远程实证), 内容除总览外未接数据

## 构建/装机链(本棒 6 轮全绿)
node apps/ohos/scripts/deploy.mjs (build→patch23→VM签→install→launch)
- 坑: cmd 直跑 node -e 中文引号必炸→一律 .cjs 文件
- 坑: PS 正则改 ets 文件高风险(字面 `n 注入)→一律 node cjs replace

## 下棒序
1. A2: aa start 后抓本 pid hilog 全链(bootstrap→hello→state→notifyServer), 环节缺哪补哪
2. B 组交互逐项接线(每项 dump 实证)
3. 单测回归 61/61 + commit

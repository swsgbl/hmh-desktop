# RESUME-STATE-V3 · 棒 V3-3 断点(Overview 数据链"最后一公里"已收敛到单一疑点)

## 本棒已完成 ✅

### 代码修复(全部已 build+装机,当前 VM 跑的就是这版)
1. **Guards.guardState 根修**:旧版 `busySessions:[]` 硬编码+`queue:asNumber`(服务端实为 string[])→ 现已解析 busySessions 数组+queue 数组长度计数
2. **Bootstrap 重试**:旧版 catch 一次性放弃("will not auto-connect")→ 现为指数退避重试(2s×10 上限 30s),**hilog 实证 `bootstrap: runtime reachable (try 1), starting global SSE` 生效**
3. **AppStore.adoptServerState(s)**:新增,refreshState 结果归仓+广播(与 SSE state 帧同路)
4. **AppStore.notifyServer 广播 serverRev**:`AppStorage.setOrCreate('serverRev', rev+1)`
5. **DockPane**:@StorageProp('sseConnected'/'serverRev' 带 @Watch onServerRev)+DIAG 行改为 `DIAG st/sse/rev`(rev 行是决定性观测:srv=N chat=N)
6. **AppStore state 分支诊断日志**:`hmh state frame: guarded=ok ver=0.23.39 ev=hello`(**hilog 已实证到达**)

### 决定性证据链(本棒核心收获)
- hilog: hello 帧**确实到达当前 app 进程**且 guardState 返回非 null(`hmh state frame: guarded=ok ver=0.23.39 ev=hello` @ 09:08:22,进程 28880)
- 但 dump(09:18): `DIAG rev | srv=0 chat=0` + st=NULL/sse=down
- **矛盾收敛为单一疑点**:notifyServer 必然 rev++(代码直读无分支),但 UI 读到 0
- **首要嫌疑(下棒第一刀)**:**AppStorage 的写入与读取不在同一实例作用域**——ArkUI Stage 模型里 UIAbility 早期(context 未挂 AppStorage 实例?)或 **SSE 回调线程非 UI 线程**(requestInStream 回调在 IO 线程?)→ AppStorage.setOrCreate 在非 UI 上下文可能落到不同 storage 或不通知。验证法:在 notifyServer 里 console.info 打 rev 值+在 DockPane aboutToAppear 定时 3s 轮询读 store.serverState 直转 @State(绕开 AppStorage),若轮询可见→AppStorage 线程问题实锤
- 次要嫌疑:hello 到达时机早于 DockPane 挂载+@Watch 不触发初始值;但 refreshState(1.5s 定时)也会 adoptServerState→notifyServer,仍 0,故此嫌疑弱

### 环境实锤(重要!)
- **VM 里有 BrowserOS 应用在崩溃循环**(每 ~2.3s `BrowserOS KaihongOS EntryAbility onCreate`)刷爆 hilog——抓 HMH 日志必须 `Select-String 'hmh|HMH'` 精确过滤,且要抓得快(易被刷出窗口)
- HMH app 本身活着(bm dump 完整/dump 布局 host=52 标题栏 HMH Desktop/中栏在渲染会话内容)
- 部署链时间戳坑:turn 75 的 build 命令被会话去重缓存挡掉**没有真跑**(产物 08:55 旧版),导致"改了源码装机无效"假象 40 分钟——**build 后必须核对 hap LastWriteTime**(powershell (Get-Item ...).LastWriteTime),且构建命令要换参数(如 --info)绕开缓存
- deploy.mjs --skip-build 装的是 patch-api23 后的 .hm-tmp\entry-api23-deploy.hap

### 环境快照(承棒2)
- hdc 在 PATH;VM 192.168.161.137:10178;bundle com.hmh.desktop.ohos(四处一致铁律)
- deploy: `cd apps\ohos && node scripts\deploy.mjs`(全链含 build)
- 截图: `hdc shell snapshot_display -f /data/local/tmp/x.jpeg` → file recv(反斜杠)
- 单测 61/61 本棒已跑零回归
- dump 解析模板:`node -e "const j=require('.../.hm-tmp/vX.json');const arr=[];(function walk(n){if(!n)return;const a=n.attributes||{};if(a.type==='Text'&&a.text)arr.push(a.text);(n.children||[]).forEach(walk)})(j);const i=arr.indexOf('DIAG st');console.log(arr.slice(i,i+22).join(' | '))"`

## 未完成(如实)
- A2 最终收口:上述单一疑点待下棒第一刀验证(AppStorage 线程/作用域)
- 六页签数据接入:文件/变更/证据/远程四页签仍是占位文案(日志页签已接 chat.logs)
- B 组交互(v3 棒1 壳未接线):设置弹层/模型菜单/审批卡/@弹层/上传/⇤收缩
- DIAG 三行定位后要删;本棒代码**未 commit**

## 下棒序
1. **A2 最后一刀**:notifyServer 加 console.info(rev 值);DockPane aboutToAppear 里 `setInterval(()=>{this.st=AppStore.get().serverState; this.sseOn=AppStore.get().sseConnected},2000)` 直接轮询 @State(绕 AppStorage)→若 3s 后 DIAG 变非 NULL→实锤 AppStorage 跨线程问题,改为 store 直轮询方案收口(总览页拿真实数据截图);若仍 NULL→AppStore 双实例嫌疑,在 startSse/onFrame 里 console.info 打 `AppStore.instance` 指纹(如随机数)对比 DockPane 侧
2. 收口后删 DIAG 行+截图存 evidence/ohos/v3/overview-data.jpeg
3. 单测回归+commit(含棒2 图标+本棒全部修复,一个 commit)
4. 六页签数据接入(文件页签接 /api/fs/list——GUARD guardFsDir 已有;变更页签接 /api/diff;证据/远程同法)
5. B 组交互逐项

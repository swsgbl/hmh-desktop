# RESUME-STATE-V3 · 棒 V3-2 续(图标修复+ A2 定位到最后一环)

## 本棒已完成 ✅

### 补充令:品牌图标修复 — **实证 PASS**
- 源 `apps/desktop/build/icon.png`(256×256,sha1 bb092f3cd964)同名覆盖 AppScope+entry 两处 app_icon.png
- hvigorw build→patch23→VM签→install→launch 全链绿
- **视觉实证**(evidence/ohos/v3/dock-zoom.png + icon-fixed.jpeg):dock 栏倒数第2图标 = "dark rounded square with a **blue letter H**"——品牌图标替换成功,橙色 DevEco 模板已消失
- 字节级佐证:deploy HAP 与 build HAP 均含源 icon PNG 头 64 字节(chkicon.cjs)
- 坑:bm dump 的 "icon":"" 是显示习惯(二进制资源不显字串),不代表没图标;VM 无传统桌面(KaihongOS 窗口管理器),dock 栏 systemui dump 40×40 Image 节点+裁剪放大(PowerShell System.Drawing 3x)是图标验证正道

### A2(总览全"无数据") — 断环定位到最后一环
- AppStore/SseClient/ApiClient/Guards/DockPane 五文件全读,**静态链完整无破绽**
- 运行时证据(a2diag3.cjs):当前 hilog 窗口 1726 delta+44 tool 帧在流(**SSE 数据面全通**),但 **hello/bootstrap/refreshState 三关键词 0 条**
- **结论**:SSE 连接是上棒装机后的旧连接(连接时收过 hello 但当时 st 更新链没走通/DIAG 截图在更早);本轮 deploy 后 app 进程重启,**新进程未执行 bootstrap**(或 hello 已滚出窗口)
- **未验证假设(下棒首查,10 分钟内可定)**:
  1. EntryAbility.onCreate 是否调用了 bootstrapAfterPrefs(读 EntryAbility.ets 源码 grep bootstrap)
  2. 若调了:aa start 后 30s 内抓 hilog(不延迟,hello 在连接头 1s 内)——当前抓晚了
  3. DockPane.refreshState 的 catch 走 hilog 0xD002200 'refreshState failed'——本轮 0 条=**没进 catch 也没成功**?→ 疑 aboutToAppear 时 baseUrl 空(prefs 异步未完)→api() 打到 ''+path→catch→hilog tag 0xD002200 可能被过滤,下棒直接搜 'hmh' domain
- DIAG 三行(在 overviewBody)可留作复验开关,定位后删除

### 环境快照
- hdc: `where hdc` = C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe(PATH 里直接用)
- VM 在线 192.168.161.137:10178;bundle=com.hmh.desktop.ohos(**四处一致铁律**:app.json5/deploy.mjs/want/profile.p7b)
- deploy: `cd apps\ohos && node scripts\deploy.mjs`(全链含 build)
- 截图链: `hdc shell snapshot_display -f /data/local/tmp/x.jpeg`(无 -e 参数!)→ file recv(本地路径反斜杠)
- VM 多窗口层叠(BrowserOS 抢屏):视觉验证用 dock 裁剪法;勿信 uinput HOME(非传统桌面)
- 单测基线 61/61(本棒未跑,未动纯逻辑,零回归风险)

## 棒 2 剩余(未动)
- B 组交互接线:设置弹层/模型菜单/审批卡/@弹层/上传/⇤收缩——全部未接(v3 棒1 只做了壳)
- 右栏六页签内容:除总览(数据链待修)外,文件/变更/证据/日志/远程均未接数据
- composer 竖排已修(棒2 初),titlebar 只有 ☰ 无 logo(蓝本对齐)——本棒未验,图标修复占位

## 下棒序(优先级)
1. A2 收口:EntryAbility grep bootstrap→aa start 后立即(<2s)抓 hilog 找 hello/bootstrap/refreshState 三词→缺哪补哪(预计 EntryAbility 没调或时序竞态)
2. 定位后删 DIAG 三行,总览页真实数据截图(对照 ui-shot-lang.png)
3. B 组交互逐项接线(每项 dump 实证)
4. 单测 61/61 回归 + commit(本棒图标改动未 commit!尽快)
5. ACCEPTANCE.md 图标行更新(证据已存)

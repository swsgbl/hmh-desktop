# RESUME-STATE-V4 · v4 收尾棒断点(IP 漂移修复已实证+UI 数据链根因三收敛)

## 本棒已完成 ✅

### 1. IP 漂移修复实证(Zode 指令第 1 件)
- PC 多网卡实况: 161.1(vmnet)/8.3(当前 LAN)/239.1/100.84(Tailscale 类)
- 7788 监听 0.0.0.0(PID 46472)在线
- **VM→8.3 链路实通**: want 参数写入 prefs(SaveXmlFile hmh***ore)→bootstrap 健康检查过→
  `hmh state frame: guarded=ok ver=0.23.39 ev=hello` @hilog
- **UI 实证**(v4e dump): `已连接 · 0.23.39 | glm-5.3 | 审批:ask` 顶栏+`G:\hmh-desktop · 18 个会话`列表全加载
- 修复方式: `aa start --ps hmhUrl http://192.168.8.3:7788`(onNewWant 持久化到 preferences)
- **运维场景已登记**: IP 漂移=已知场景(长期方案:配对二维码/服务发现,待 Zode 裁决,本轮不做)

### 2. v4 换肤工作树已提交(指令第 2 件的前半)
- 全部改动整理进本棒 commit(Theme 换肤/组件新肤/DockPane 轮询修复)
- 单测 61/61 零回归

### 3. UI 数据链根因——三轮收敛(本棒核心诊断,下棒第一刀就在这)
- **实锤链**: hello 帧到进程(`guarded=ok ver=0.23.39`)→ SSE 活流在跑(delta/tool/approvalDone 帧
  hilog 密集)→ 但 UI `DIAG st=NULL sse=down srv=0`
- **已排除**: AppStorage 跨线程(2s 轮询直读 store 仍 NULL→不是存储层问题)
- **收敛到**: store.serverState 本身为 null。两嫌疑:
  a) **hello 只在新连接首帧发一次**——app 冷启动 bootstrap 时 hello 早在 DockPane 挂载前消费完,
     而 refreshState(/api/state) 的 catch 分支可能静默循环失败(hilog 有 'refreshState failed' 需复查)
  b) **进程疑点**: hilog 里 HMH 日志 pid=9738 但旧日志 pid=8519——**VM 上可能有两个 HMH 进程实例**
     (8519 收 hello,9738 在跑 UI),单例 AppStore 跨进程不共享!
- **下棒验证法**: hilog 按 pid 分组看 'hmh state frame'/'config applied'/'bootstrap' 各来自哪个 pid;
  aa force-stop 后重启一次性抓全链日志对 pid

### 环境快照(承 v3)
- hdc 目标 192.168.161.137:10178(掉线重连即可);bundle com.hmh.desktop.ohos(四处一致铁律)
- deploy: `cd apps\ohos && node scripts\deploy.mjs --skip-build`(全链含 patch23+VM 签+装+启)
- 构建: `cd apps\ohos && hvigorw.bat --mode module -p module=entry@default -p product=default assembleHap --no-daemon`
  **构建后必核对 hap LastWriteTime(UP-TO-DATE 假象)**
- patch 脚本: apps/ohos/scripts/patch-api23.cjs(deploy.mjs 内置调用,勿直接裸调)
- VM 无 curl/wget——网络探测用 app 自身 want 参数+hilog 观测
- BrowserOS 崩溃循环刷屏 hilog——过滤用 Select-String 'hmh|JSAPP' 且要快
- VM 桌面多窗口层叠: dump 前必 aa start 拉前台,且 dump 可能抓到别家窗口(先看 total/头部文本)

## 未完成(如实)
- v4 commit 本棒已做(见 git log);RESUME 本文件即终态
- UI 数据链最后一刀(上述双嫌疑验证)未收口——**总览页仍无数据**
- 六页签四项(文件/变更/证据/远程)仍是占位文案(承 v3 未竟)
- B 组交互(承 v3 未竟)

## 下棒序
1. 双进程嫌疑验证(hilog pid 分组)→修复(单例化或 force-stop 清场)
2. refreshState catch 循环复查(hilog 'refreshState failed')
3. 总览数据截图存 evidence/ohos/v4/overview-data.jpeg
4. 六页签+B 组(承 v3 下棒序 4/5)

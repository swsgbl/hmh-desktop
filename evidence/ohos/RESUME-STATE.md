# RESUME-STATE · HMH Desktop 鸿蒙版(棒 3 收棒 · 2026-10-25 晚 · 证据齐)

> **唯一真相**。棒 3 战果与断点全在此。下一棒(棒 4)从 §3 开始。

## 1. 棒 3 已完成 ✅
1. **门 4 主链路全通**(真机真服务,非 mock):
   - 设置页填 URL+token(want 参数通道)→ 测试连接 → **"连接成功 · daemon 0.23.39 · 模型 glm-5.3 · exposure=lan"**(evidence/ohos/shot-settings.jpeg)
   - 会话页拉到 PC 真实历史列表(197 轮 turn-budget 等)
   - **新建会话 → 发送任务 "123456" → 服务器真实执行**(PC 侧 /api/sessions 出现 3 个 turns=1 ✓ok 新会话,时间戳 12:51:50/12:52:45/12:53:29 对应 app 内三次发送)
   - 修复两个真 bug:①SessionsPage `activeId===''→listBody` 死锁(新建会话进不了聊天页,加 inChat 标志)②无 normalizeBaseUrl 时全角标点 URL 打不通(新增 UrlNorm.ets+tests/url-norm.ts,7 测全绿,共 34 测)
2. **门 5 截图 2/3**:shot-home.jpeg(棒2)、shot-settings.jpeg(棒3)
3. 构建装机链三连走通(v3/v4 均 BUILD SUCCESSFUL→降版→VM 签→装→起)

## 2. IME 注入规律(血泪,勿重探)🧭
- 拼音 IME 拦截一切字母(inputText/text/uinput -K -t 全走 IME);**数字原样上屏**
- keyEvent 数字区 2056-2065 可注入;Esc/Enter 关不掉组合条
- 清空:longPress→全选→剪切(每次菜单坐标不同,先 dump 再点)
- **want 参数通道是正解**:`aa start --ps hmhUrl <url> --ps hmhToken <tok>`(EntryAbility onCreate/onNewWant 已实现,token 只进 app 私有 preferences)
- 输入框获得焦点后 inputText 数字可用(发送框 refocus 后 123456 成功入框)

## 3. 棒 4 待办 ⬜
1. **门 4 收尾:聊天流渲染链断点**——发送后消息/回复不上屏。三案并查:
   a. hilog 抓 SseClient onFrame(现 hilog 过滤词没命中,试 `hilog -x | grep -i hmh` 或直接看 JS_CONSOLE);
   b. PC 侧再发一条任务(用 app 已打开的会话 id,从 /api/sessions 拿),同时盯 app 屏——若上屏则链路通,问题只在"发送时刻的事件丢失"(SSE 连接建立于 openSession 时,事件 sessionId 过滤逻辑在 Reducer.toRunEvent 尾部);
   c. SSE 探针(curl -N /api/events)空闲时 8 秒无帧——**确认 LAN 模式是否有 hello/state 帧**;若无,检查 AppStore.startSse 的 onOpen 是否真触发(dump 显示"已连接"说明 SseClient 连上了,但可能 onFrame 从未到达)
2. **门 5 第 3 张截图**:shot-chat.jpeg(聊天流上屏后)+ 可选 shot-approval.jpeg
3. ACCEPTANCE.md 门 4/5 终态 + RESUME 终态
4. git commit(工作树有 UrlNorm/tests/EntryAbility/SessionsPage 改动)

## 4. 安全事件(如实,已报 Zode)⚠️
step2-token.cjs 曾把含 token 的 hdc 命令回显到宿主会话日志(session jsonl,本机私有目录)。未落文件/截图/VM 磁盘。建议评估轮换。

## 5. 现成工具(全在 .hm-tmp/)🔧
- e2e-read.cjs <json>(解析 dump,argv[2]=路径)
- deploy-v4.cjs(构建→降版→签→装→want 启动,一步到位,**复用这个**)
- check-server.cjs(PC 侧 curl 会话列表+hilog)
- sse-probe.cjs(SSE 帧探针)
- 坐标:设置tab@1009,690 会话tab@367,690 发送@1072,628 输入框中心@651,628 返回←@293,279 刷新@1071,283
- hdc file recv 本地路径必须反斜杠;长命令全走 .cjs

## 6. 服务端事实(已证)
- 7788 /api/state /api/sessions /api/task /api/events 全可用,x-hmh-key 鉴权
- 空闲 SSE 8 秒无任何帧(无 hello)→ AppStore.startSse 靠 onOpen 显示"已连接",事件帧何时来待查

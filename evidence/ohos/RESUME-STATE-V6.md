# RESUME-STATE-V6(设备本地内核共享)

> v6 棒 1 断点 · 2026-10-26 · 前序: v1-v5 见 RESUME-STATE-V2.md / ACCEPTANCE.md

## 已达成(铁证在 evidence/ohos/v6/)

### L1 设备 hmh 可跑 ✅
- hmharness 0.23.39 十五包已装:/data/local/home/.local/hmharness/node_modules/@hmharness/{cli,agent,kernel,web...}
- 启动器三份:/data/local/home/.local/bin/hmh + /usr/local/bin/hmh + /system/bin/hmh(后两份需 remount rw 才能改)
- **关键坑(本棒最大发现)**:本 VM 上 root 的 hdc shell 也禁 RWX,V8 JIT 必崩(Check failed: 12 == errno, SIGTRAP)。
  - node.bin 裸调必崩;必须走 wrapper /data/local/home/.ohos/node/bin/node(自带 --jitless + LD_LIBRARY_PATH)
  - 安装器生成的 hmh 启动器默认 drop --jitless(假设板端 root 可 JIT)→已用 /data/local/tmp/fix-launcher.cjs 补丁三份启动器:
    NODE_ALLOW_JIT 默认改 0 + drop 段改为默认追加 --jitless
  - **/usr/local/bin 与 /system/bin 的补丁在 remount rw 窗口内完成;若系统更新/重装启动器需重跑 fix-launcher.cjs**
- hmh --version → 进 REPL(0.23.39 --version 无此 flag,行为=进 REPL;验证用 echo /exit | hmh)

### L2 设备 web 起 ✅
- hmh web start --exposure=lan → 0.0.0.0:7788 LISTEN(node.bin PID 22791)
- config 已推送:providers 20 个(密钥经 hdc 直推,本地临时文件已销毁,web.log token 审计 0 hits)
- /api/state 200: model=glm-5.3 chatProvider=glm home=/data/local/home/.hmharness

### L3 应用连本地 ✅(evidence/ohos/v6/l3-app.json + l3-coldboot.json)
- aa start --ps hmhUrl http://127.0.0.1:7788 → 已连接 · 0.23.39 + glm-5.3
- netstat 铁证: com.hmh.desktop.ohos(34012) ↔ 127.0.0.1:7788(node.bin) ESTABLISHED
- 冷启动(无 want)自动连 127.0.0.1(preferences 持久化✓,列表=设备侧真实 0 会话)

## 进行中(L4 三端同核)
- app 端 ✎✅(见 L3)
- API 任务:POST /api/task 200,会话 web-mvowdf24/caiklf 建立,busy→false 走完,
  **但 jsonl 只有 session/start+user 两行,assistant 回复未落盘**——glm API 可达(401 probe),
  疑 jitless 下流式处理或落盘异常,待查(web.log 无错误)
- TUI 端:hmh --task 超时挂起(疑等 tty/网络),hmh run 未试成
- 浏览器端:未验(BrowserOS 9222 调试口在,可 browser_open 127.0.0.1:7788)

## 未做(L5)
- deploy-local-kernel.mjs 一键化(现有积木:v6-install.cjs 探测推送/fix-launcher.cjs/webrestart.cjs/push-config.cjs 全在 .hm-tmp)
- README-ohos.md 设备独立模式章节
- ACCEPTANCE.md v6 门 L1-L5 段

## 下棒执行序
1. L4 收口:先查 assistant 落盘(重发任务,tail jsonl 看流式写入;查 kernel 侧 stdout);
   TUI 用 script -c 或 ttyd(27681 在 LISTEN)跑;浏览器端 browser_open http://192.168.161.137:7788
2. L5: 整理 .hm-tmp 积木 → apps/ohos/scripts/deploy-local-kernel.mjs(参数: --target --token-env --arch x64|arm)
3. README-ohos.md 章节边界如实: 设备独立 HMH_HOME/侧载/arm 换 node
4. ACCEPTANCE v6 门;token 纪律复审(本轮 0 泄漏:web.log 0 hits,hilog 审计通过)

## 关键命令速查
- 设备 node: /data/local/home/.ohos/node/bin/node (wrapper, 勿用 node.bin!)
- hmh: /data/local/home/.local/bin/hmh (已打 jitless 补丁)
- web: hmh web stop; hmh web start --exposure=lan; log=/data/local/home/.hmharness/web.log
- API probe: HMHK=<token> /data/local/home/.ohos/node/bin/node /data/local/tmp/probe-dev.cjs
- 任务脚本: /data/local/tmp/dev-task.cjs (POST /api/task)
- dump: uitest dumpLayout -p /data/local/tmp/x.json → hdc file recv(本地路径必须反斜杠!)

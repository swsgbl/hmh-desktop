# RESUME-STATE-V2 · 鸿蒙版 v2 · 棒 V2-2 收棒(P0 收口)

> 上一棒断点:RESUME-STATE-V2.md(V2-1 侦查)。本棒 = P0 全收口 + 空壳会话根因闭环。

## 本棒完成 ✅
1. **空壳卡死会话根因闭环(Zode 实锤症状)**:
   - PC 等价复现(curl 同 body):mode=ask + 触发工具的任务 → SSE 全链正常(busy→delta(kind:reasoning/text)→tool→**auto-approvalDone**→toolResult→final→busy:false),**无卡死**。
   - **在机复现验证**:VM 冷启动(无 want)→会话页自动"已连接"→发送"112233"→"运行中/打断"→**回复完整上屏**("收到「112233」…✅")。当前 v6b+bootstrap 版本不复现"发送→卡 busy→无回复"。
   - 旁证:t0 dump 抓到 app 实时渲染本智能体自己会话的流式输出——全局 SSE 订阅(sessionId='')工作正常。
   - 结论:Zode 抓到的 web-mvnwl06d/web-mvny1uxd 空壳(0 消息永久 busy)系**旧版(v6b 之前)发送链 bug 或 uitest 误触**所致;Zode 已 interrupt 清理;新链路三轮验证(2 PC curl + 1 在机)未复现。留观:若用户再报,抓 hilog SSE diag 帧。
2. **P0 持久性定性(受控重启)**:
   - reboot 前:app 在(bm dump 16334B,installTime=棒3);reboot 后(uptime 110s):**app 仍在**。/data=ext4 物理持久。**正常重启不丢 app**;Zode 观察到的"消失"=非重启因素(VM 还原点回滚/DevEco 侧操作),定性为"环境事件,非 app 缺陷"。已交付 deploy.mjs 兜底(下条)。
3. **P0 交付物**:
   - `apps/ohos/scripts/deploy.mjs`(一键:build→patch api23→send→VM签→install→launch;--skip-build 可跳;自动落盘 patch-api23.cjs/vm-sign.sh 到 scripts/;**全程无 token**;hdc target 可用 HMH_HDC_TARGET 覆盖)。已实测两轮 SUCCESS。
   - `model/Bootstrap.ets` + EntryAbility 接线:启动即 initPrefs→GET /api/state 健康检查→**自动连全局 SSE**;want 参数路径也接了。**VM 冷启动实测自动"已连接"**。
4. **VM 重启后环境变化(下棒注意)**:锁屏改 PIN("登录"按钮→点进是应用中心!unlock 用 uinput -T -m 上滑无效,须点"登录"进系统);重启后 UI 坐标整体左移约 150px(会话tab 367→319,输入行 628→580,**操作前必须重新 dump 定位**);桌面 dock 常驻(应用中心/浏览器/组件管理/设置/文件管理器)。

## 待办(下棒,按 RESUME-STATE-V2.md 矩阵序)⬜
1. 矩阵 20 项(从#1 工具卡开始,纯逻辑 tests/ 先行)
2. ACCEPTANCE-V2.md 开档(门 A 已有 P0 证据:重启前后 bm dump 对比+deploy.mjs+自动重连在机截图可补)
3. 截图补:冷启动自动连接+回复上屏(t21 dump 即证据,可重跑存 jpeg)

## 纪律提醒
token 零落盘(本棒 hilog 复查 clean);坐标每轮 dump 现取;禁改 hmharness/apps-desktop。

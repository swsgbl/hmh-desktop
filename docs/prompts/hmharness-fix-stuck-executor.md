# hmharness · 修复任务:执行器挂死时 interrupt 无效(Zode 签发)

> 承接:Claude Code · 2026-10-26 · 目标仓库:**G:\hmharness**(生产仓,v0.23.39)
> 背景:桌面/鸿蒙客户端使用中多次(≥3 次)出现"空壳会话永久 busy"(0 条消息却
> 占 busy 位,POST /api/interrupt 返回 200 但无效),只能重启 web 守护清障。

## 复现线索(实测记录)
- 会话形态:/api/sessions/:id 返回 messages=[] 但 executors 里 busy;
- interrupt 链:server.ts 的 /api/interrupt → executors.get(sid).resolve/pending
  清理——挂死时 pending=null 但任务 Promise 未决,busy 位不清;
- 触发场景疑似:客户端(鸿蒙 app)发送后立即断开 SSE/网络闪断/provider 调用
  网络层挂起无超时。

## 任务
1. **定位**:server.ts task-runner 链路读一遍,找出"busy 置位/清除"全路径;
   写最小复现脚本(scripts/repro-stuck.mjs:构造挂起 provider/断连场景,证明
   busy 永久+interrupt 无效)——复现不了就如实说,凭码分析定位;
2. **修复**(最小侵入):
   a. interrupt 兜底:除了 pending 审批,还应 abort 任务执行(AbortController
      贯穿 provider fetch/工具执行;或 executor 级超时强清 busy);
   b. provider/网络调用统一超时(挂起→按 provider timeoutMs 判失败);
   c. SSE 断连不影响的正确性(断连≠挂死,但发送方断连后的孤儿任务要有出路);
3. **测试**:补单测(挂死→interrupt→busy 清;超时→run.failed);**全量测试
   npm test 必须全绿(855+ 基线,不许回退)**;
4. **纪律**:G:\hmharness 是生产仓——只做本修复相关最小改动;不升版本号不发
   版(发版走 hmharness 自己的流程,留用户裁决);commit message 注明根因;
5. 汇报:根因一段话+改动清单+复现/修复测试证据。

## 验收门(Zode)
| # | 门 |
|---|---|
| F1 | 复现或码级定位(有证据) |
| F2 | 修复后:挂死场景 interrupt 生效 busy 清(测试绿) |
| F3 | 全量测试零回退 |
| F4 | 改动最小聚焦(diff 审查无夹带) |

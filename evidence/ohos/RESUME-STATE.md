# RESUME-STATE · HMH Desktop 鸿蒙版(棒 3 收棒终态 · 2026-10-25 晚 · 全门通过)

> **任务完成**。门 1-6 全过(见 apps/ohos/docs/ACCEPTANCE.md)。本文件为终态归档。

## 终态摘要 ✅
- **门 4 E2E 实证闭环**:设置页配置(连接成功·daemon 0.23.39·glm-5.3·exposure=lan)→新建会话→SSE 已连接→发"1357"→运行中+打断→glm-5.3 流式回复上屏→final("收到「1357」…")
- **门 5 四截图**:evidence/ohos/{shot-home,shot-settings,shot-chat,shot-final}.jpeg
- 单测 34/34(棒 3 新增 url-norm 7 测);构建装机链 v6b 走通
- 棒 3 修 3 真 bug(inChat 死锁/chat listener 陈旧快照/URL 全角规范化)+want 参数通道+SSE 诊断日志

## 遗留(非阻塞,已记 ACCEPTANCE 未尽事项)
1. 审批卡真机 E2E 未触发(ask 模式无工具调用;需 agent 模式任务)
2. 会话历史回放未实现(打开旧会话聊天区从空开始)
3. 棒 3 代码改动待 git commit(收棒动作)

## 给下一棒(若续开发)🧭
- IME 规律/工具脚本/坐标全部在 git 历史的本文件旧版(hmh-ohos 棒 3 中场版)与 .hm-tmp/*.cjs
- deploy-v6b.cjs 是标准装机链(构建校验 BUILD SUCCESSFUL 后才装)
- 服务端事件契约:line={text,sessionId}、delta={kind,chunk,sessionId}、final={text,sessionId,runId,turns,toolUses,...}(server.ts relay 函数)

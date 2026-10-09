# HMH Desktop 开发验收报告(第 2 轮:阶段 E 会话纵切片)

日期:2026-10-10 · 交付人:AI 开发代理(ZCode)· 依据:04 号文档 M2/M3 + MasterPrompt 阶段 E
范围:真实 runtime 桥接(EventEnvelope 信封流)、审批纵切片、Electron main 统一 fake/real 路径、renderer 聊天/工具卡/审批卡 UI、断线补拉、3 会话并发。M4 的 Files/Diff 面板本轮未做(见 NOT RUN)。

## 变更摘要

**hmharness(packages/web)**:
- server.ts:desktop 模式下 run 生命周期事件同时以 `event: hmh` 信封发出(EventEnvelope:schemaVersion/eventId/sessionId/runId/per-run 单调 seq/occurredAt/kind),与既有事件名并存迁移;信封进 SSE 重放环 → Last-Event-ID 断线补拉生效。映射:busy→run.started(带新生成的 runId)、tool→tool.started、toolResult→tool.completed、approvalReq→approval.required(含 approvalId/tool/argsPreview/risk)、final→run.completed(text/turns/toolUses/usage)、error→run.failed(桥级 code:provider 认证/余额→AUTH_FAILED,其余→RUNTIME_CRASHED)。**子进程异常退出且无 final 时补发 run.failed**(桌面归约不会永远卡 running)。高频 line/delta 不做假映射,继续走原事件名。
- `busy`/`final` 事件附带 runId(现有 web UI 不读该字段,零影响)。

**hmh-desktop**:
- fake host 升级为完整替身:/api/task(脚本化 run 序列,ask 模式挂起等审批)、/api/approve(批准/拒绝双路径)、/api/interrupt、/api/sessions、SSE 重放环(Last-Event-ID 补拉);钩子 FAKE_HOST_TASK_FAIL(任务以 run.failed 收场)。
- supervisor:新增 `onReady(endpoint)` 回调——crash 自愈重启后端口/token 都是新的,宿主进程据此重建桥客户端(修复自愈后 client 指向旧端口的问题)。
- Electron main:统一路径——fake 与真实 hmharness 都经 `DesktopHostClient` 调同一组 API(/api/task /api/approve /api/interrupt /api/sessions);SSE 信封流订阅(isEventEnvelope 校验 → 50ms 批量 IPC);断线 1s 退避重连(带 lastEventId);hostCall 公共壳(未就绪→结构化 HOST_NOT_READY,不崩)。
- renderer:真实聊天流(run.started 用户消息/run.completed 回复/run.failed 错误卡)、工具折叠卡(默认折叠,展开看参数/输出)、**审批卡**(工具/参数/风险 + 批准/拒绝,转发 /api/approve;权威仍在 runtime)、运行中停止按钮(/api/interrupt)、会话列表(/api/sessions)、八态状态条。

## 变更文件

hmharness:
- M packages/web/src/server.ts(信封映射 + runId + 无 final 补 run.failed)
- + packages/web/src/__tests__/desktop-envelope.test.ts(2 测试)

hmh-desktop:
- M packages/host-adapter/src/{fake-host.ts, supervisor.ts}
- + packages/host-adapter/src/__tests__/e2e.test.ts(6 测试)
- M apps/desktop/electron/main/index.ts(统一桥接)、preload/index.ts(新方法)、renderer/src/{App.tsx, bridge.ts, app.css}
- M package.json(test script +e2e)、scripts/smoke-electron.mjs、+ scripts/smoke-real.mjs

## 测试命令与原始结果(2026-10-10)

| 命令 | 结果 |
|---|---|
| `cd G:\hmh-desktop && npm run typecheck` | 0 errors |
| `cd G:\hmh-desktop && npm test` | **30/30 pass**(0 fail 0 skip) |
| `cd G:\hmh-desktop && npm run build` | 全通 |
| `cd G:\hmh-desktop && node scripts/smoke-electron.mjs`(fake) | `SMOKE: host-ready=true no-crash=true` |
| `cd G:\hmh-desktop && node scripts/smoke-real.mjs`(真实 hmharness v0.23.33) | `REAL-SMOKE: bridge-ready=true mode-real=true no-crash=true`(真实 HMH_HOME 只读,未发任务) |
| `cd G:\hmharness && npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `cd G:\hmharness && node --import tsx --test --test-force-exit packages/web/src/__tests__/desktop-envelope.test.ts` | 2/2 pass(402 provider 驱动真实 task-runner 子进程) |
| `cd G:\hmharness && npm test`(全量) | **889/891 pass;2 fail = extension/real-browser 的 Firefox 真实浏览器断言,经干净基线( stash 本轮改动后重跑)复现同样失败 → 环境性(昨日全量同测试绿),与本轮改动无关**(该测试与本轮改动的包零 import 依赖) |

### 关键测试内容

- **纵切片 e2e(fake 层,6 测试)**:发送→run.started→tool.started/completed→completed;ask 审批批准路径(waiting_approval→批准→已执行写入);拒绝路径(审批被拒绝,未执行写入);**3 会话并发**(各自回复属于各自任务);**断线重连**(收到 tool.completed 立即断开,重连带 Last-Event-ID 补齐终态);任务失败(run.failed 携带 AUTH_FAILED + retryable:false)。
- **hmharness 信封(真实链路,2 测试)**:402 fixture provider + 真实 task-runner 子进程 → SSE 收到 run.started(task/mode 正确)与 run.failed(桥级错误码 + HTTP 402 信息);seq 单调、eventId 全局唯一;中途断线后 Last-Event-ID 从重放环补齐终态。

## PASS

1. M2 会话纵切片(fake 层全闭环;真实链路信封+桥验证)。
2. M3 审批:approval.required 事件带 approvalId/tool/argsPreview/risk;批准/拒绝双路径测试;**审批权威在 runtime**(UI 只转发 /api/approve;fake host 在未挂起审批时 404)。
3. 断线补拉:重放环 + Last-Event-ID(两侧都测)。
4. host crash 自愈后桥重建(onReady 回调)。
5. 3 会话并发互不串线。
6. 无 final 的异常退出补 run.failed(桌面不会永远 running)。

## FAIL

(无)

## NOT RUN(原因)

1. **GUI 人工验收**:发送→审批卡点击→回复渲染的真人操作流(自主环境无人工;自动化 GUI 驱动属阶段 H 硬化)。smoke 已覆盖进程/桥/SSE 层。
2. **真实 provider 的完整任务闭环**(花钱跑真模型):桥与信封已用 402 fixture 验证;真实模型的 end-to-end 留给用户首验(命令:`cd G:\hmh-desktop && set HMH_DESKTOP_REAL=1&& npm run dev`)。
3. M4 Files/Diff/交付物面板、M5 认知 Dock 数据面(下一轮)。
4. delta 流式渲染(高频流不在 9 kind;待产品决策后接入)。

## NEEDS-DATA

1. 真实模型任务的端到端时延/渲染性能(依赖真实 provider 跑一次)。
2. SSE 批量(50ms)在长转录下的 renderer CPU 占用(待长任务实测)。

## 安全与权限影响

- renderer 仍零 Node/零网络凭证;审批经 main 转发到 runtime 的后端门;token 不出 main(secrets 脱敏日志)。
- run.failed 的错误文本来自 provider 响应,仅以文本渲染(React 转义)。
- fake host 与真实 host 同一鉴权合同(X-Hmh-Key 全路由)。

## 手工验收步骤(给用户)

```powershell
cd G:\hmh-desktop
$env:HMH_DESKTOP_REAL='1'; npm run dev   # 真实 hmharness runtime
# 或 npm run dev                          # fake host(无需模型)
```
1. 窗口顶栏"已连接 · runtime 0.23.33 · 127.0.0.1:<端口>"。
2. 新建会话 → 输入目标回车:出现用户消息 → 工具卡(⚙ 折叠)→ 最终回复。
3. 审批模式任务:审批卡弹出 → 批准/拒绝 → 观察后续工具与回复。
4. 任务运行中点"停止"。

## 已知问题与下一步

1. M4:Files/Diff/交付物(/api/fs files=1 + /api/fs/read + artifact 事件);M5:Evidence/Logs(认知 API)。
2. delta 流式渲染与工具事件实时折叠细节。
3. 会话恢复(点历史会话加载 transcript 预览 /api/sessions/:id)。
4. 阶段 H 硬化:GUI 自动化测试矩阵、长列表虚拟化、Ctrl+K 命令面板。

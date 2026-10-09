# HMH Desktop 架构基线(阶段 A 交付物)

日期:2026-10-09 · 基线:hmharness v0.23.33(本机 G:\hmharness,commit dbfbc38)
方法:只读侦察(server.ts 全文 2169 行逐行阅读 + kernel/agent/CLI/web-daemon/task-runner 定向核实),未改动 hmharness 工作树。

> 本文是 MasterPrompt 阶段 A 的交付物:API/事件矩阵、可复用模块、危险耦合、候选改动、测试策略、GAP 清单。所有"应该存在"的接口都用搜索核实过;不存在的一律进 GAP,不做假实现。

## 1. 总体结论

hmharness 的 web 层(packages/web)已经具备桌面桥需要的**全部业务面**:per-session 子进程执行、SSE 广播与重放、审批门、工作区、会话管理、provider 设置。缺的不是功能,而是**可组合的宿主化能力**:端口回传、token 鉴权(loopback 下)、进程生命周期句柄、版本化事件信封。这四项就是 hmharness 侧需要做的全部改动(§5)。

## 2. API 矩阵(packages/web/src/server.ts,行号为 v0.23.33 实测)

### 2.1 任务与会话
| 路由 | 方法 | 语义 | 关键行为 |
|---|---|---|---|
| `/api/task` | POST | 提交任务 | body `{text,yes,mode,fresh,sessionId,attachments,images}`;busy 会话排队,其他会话立即跑(:1399-1409);附件路径必须在工作区内(:1299) |
| `/api/interrupt` | POST | 停止单会话 | 无 sessionId 且恰一个运行中→它(:1419-1420);给 child stdin 写 `{type:'abort'}` |
| `/api/inject` | POST | 运行中注入 | 路由到单会话 child stdin `{type:'inject',text}`(:1799) |
| `/api/approve` | POST | 审批应答 | `{granted,sessionId}`;per-session pending(:1554-1572) |
| `/api/queue` | GET/DELETE | 队列查询/清理 | per-session 或全量(:1429-1475) |
| `/api/sessions` | GET | 会话列表 | kernel listSessions,cursor 分页,标题在 workspaces.json(:1158-1192) |
| `/api/sessions/:id` | GET | 会话预览 | 最后 80 条,每条 500 字符(:1273-1279) |
| `/api/sessions/:id/export.md` | GET | 导出 Markdown | 与 CLI/TUI 同一 builder(:1249-1265) |
| `/api/sessions/:id/{rename,archive,delete}` | POST | 会话管理 | trash/archive 可恢复,不硬删(:1194-1241) |

### 2.2 状态与事件
| 路由/机制 | 语义 |
|---|---|
| `/api/state` | 全量状态快照(model/locale/busy/queue/skills/providers/goal…)(:565-631) |
| `/api/events` | SSE:monotonic id + 200 条重放环 + Last-Event-ID 补发(:943-964);15s 心跳(:2111) |
| 事件名 | `hello/state/busy/queued/queue/line/delta/tool/toolResult/approvalReq/approvalDone/injected/final/error/goal` |
| 鉴权 | loopback:Host/Origin 白名单(防 DNS rebinding,:726-729);lan/wan:配对 cookie/LAN IP/`X-Hmh-Key`/`?key=`(:704-724) |

### 2.3 工作区与文件(路径边界=后端权威)
| 路由 | 语义 |
|---|---|
| `/api/workspaces` GET/POST,`/use`,`/delete` | 工作区注册/切换(process.chdir 全局 cwd,:1050)/删除 |
| `/api/fs` | 目录浏览(只列目录+可选文件,驱动器枚举)(:1076-1156) |
| `/api/fs/search` | 工作区内模糊搜索,symlink 不跟随(:1687-1733) |
| `/api/fs/read` | 文件读取 64KB 上限+二进制嗅探+严格 UTF-8(:1736-1781) |
| `/api/open` | 资源管理器打开(必须 insideWs)(:1980-2007) |

### 2.4 设置与认知
`/api/config`(approval/locale/theme/evolution)、`/api/model`、`/api/providers(+/delete)`、`/api/locale`、`/api/command`(斜杠命令子集)、`/api/goal`、`/api/feedback`、`/api/label(list)`、`/api/cognitive*`(drift/skills/trajectories/replay/transfer/team/calibration/状态)、`/api/extension/status`、`/api/devices`、`/api/ssh`、`/api/remote-info`、`/api/pair-info`、`/api/tunnel/*`、`/api/qr`。

## 3. 可复用模块(直接 import,零依赖纯库)

| 模块 | 关键导出 | 对 Desktop 的意义 |
|---|---|---|
| `@hmharness/kernel` config.ts | `homeDir()` `loadConfig()` `patchConfig()` `setChatRoute()` `saveProvider()` | HMH_HOME 语义与 config.json 权威读写;`HMH_HOME` env 是唯一状态根覆盖(config.ts:15-17) |
| `@hmharness/kernel` session.ts | `findSessionFile` `listSessions(home,{limit,cursor,cwd,sort})` `loadTranscript` `exportSessionMarkdown` `readSessionHead` | 会话列表/恢复/导出与 CLI 同源 |
| `@hmharness/kernel` types.ts | `ChatMessage` `HmhConfig` `resolveProvider` `listProviders` | DTO 对齐基础 |
| `@hmharness/agent` runner.ts | `buildRegistry({announce:false})` `runAgentTask(opts)` | 直接进程内跑 agent(备选路径);`RunnerEvents` 全回调(runner.ts:327-336) |
| `packages/web/src/task-runner.ts` | stdin/stdout ndjson 协议 | **现成的进程边界**:stdin `{type:'inject'|'abort'|'approval'}`,stdout `{kind:'line'|'delta'|'tool'|'toolResult'|'approvalReq'|'approvalDone'|'injected'|'final'|'error'}`;payload 文件启动、读后即删 |
| web server.ts SSE | id + 重放环 | 断线补拉语义参考 |

会话磁盘格式:`HMH_HOME/sessions/YYYY/MM/DD/<id>.jsonl`,append-only `SessionEvent`(判别键 `t`:session/start/user/assistant/tool/approval/final);`SessionSummary` 带 createdAt/updatedAt,`SessionTranscript` 不带(在列表侧)。

## 4. 危险耦合与风险

| # | 耦合 | 位置 | 风险 | Desktop 对策 |
|---|---|---|---|---|
| C1 | `startServer` 返回 `Promise<void>`,EADDRINUSE 直接 `process.exit(1)` | server.ts:248, 2127-2134 | 库层杀宿主进程;桌面无法组合生命周期 | hmharness 侧改造 §5.1(必做) |
| C2 | 固定端口假设 | DEFAULT_WEB_PORT=7788(web-daemon.ts:20),probe/打印都用传入 port | 桌面与用户手动 `hmh web` 抢 7788 | §5.2 port=0 回传(必做) |
| C3 | loopback 无 token | server.ts:704-739 | 本机任意进程可打 API | §5.3 desktop 模式强制 X-Hmh-Key(必做) |
| C4 | `process.chdir` 全局工作区切换 | server.ts:1050 | 单 cwd 全局态;Desktop 多会话视图需 cwd per session(task-runner 的 cwd 已 per-session,只是切换工作区是全局) | Desktop 不复用 /workspaces/use 的全局切换,以会话 cwd 为准(阶段 E 处理) |
| C5 | 事件无信封 | broadcast 直接发裸 JSON | 无 eventId/seq/schemaVersion,重连去重靠前端按 id | Desktop 侧 EventStore 已实现去重/缺口;hmharness 侧 §5.4 输出 EventEnvelope(可与现有事件名并存) |
| C6 | CLI↔daemon 只有 pid/版本文件+HTTP 探测 | web-daemon.ts:24,48-57 | Desktop supervisor 不应碰这些文件 | Desktop 完全自己 spawn,不经过 web-daemon |
| C7 | `/api/task` 的 32MB body 与图片 vision 预处理在主 server 进程 | server.ts:1283-1381 | 大附件会阻塞 server 事件循环 | Desktop 首发 builder 不传 images(文本+@文件引用即可),后续再议 |

## 5. hmharness 侧候选改动(最小向后兼容;详见对应 PR/commit)

1. **可组合生命周期**:`startServer` 改为返回 `WebServerHandle { port: number; host: string; close(): Promise<void> }`;EADDRINUSE 抛结构化错误,由 CLI 调用点决定打印与退出(CLI 行为保持兼容)。
2. **port=0 实际端口回传**:`server.listen(0)` 后用 `server.address().port` 填进 handle。
3. **desktop host 模式**:新增入口(如 `packages/web/src/desktop-host.ts`):loopback + port 0 + 每次 spawn 高熵 token(env `HMH_DESKTOP_TOKEN` 传入)+ 全 `/api/*` 强制 `X-Hmh-Key` + stdout 引导行 `{"hmhDesktopHostReady":true,"port":N,"version":V}` + `/api/desktop/shutdown` 优雅关停。
4. **EventEnvelope 事件流**:`/api/events` 增加 `event: hmh` 的信封事件(带 schemaVersion/eventId/sessionId/runId/seq),与现有事件名并存迁移。
5. **页面层清理**(文档 04 列为前置):page.ts 的 innerHTML 路径安全回归——属于 Web 专项,Desktop 不阻塞。

## 6. 测试策略(本仓库)

- **contracts**:guards 正反例 + guard↔JSON schema 枚举一致性(漂移即红)。
- **host-adapter**:fake host 合同测试(401/state/SSE/shutdown/die 钩子);supervisor 状态机全路径(start ready/crash 自愈/烧完 failed/优雅 stop/token 不匹配),`--test-force-exit` 收尾(子进程+keep-alive socket 是集成测试常态)。
- **electron 壳**:恶意 URL 拒绝、未知 IPC 拒绝、renderer 无 process/require——依赖 electron 安装,本地/CI 跑;本机网络受限时如实标 NOT RUN。
- **hmharness 侧回归**:其全量 855 测试必须保持绿;desktop-host 新入口配独立测试。

## 7. GAP 清单(全仓核实,不存在)

| 项 | 核实方式 | 结论 |
|---|---|---|
| `EventEnvelope` 类型/符号 | 全仓 grep | 不存在;SSE 与 ndjson 均为裸形状 |
| port=0 支持(listening/address() 回读) | server.ts 全文 | 无;传 0 会绑随机端口但取不回 |
| 标准 Bearer/`Authorization` 桥鉴权 | server.ts 鉴权段 | 只有 `X-Hmh-Key`/`?key=`(且仅 exposure≠loopback) |
| loopback 模式 token | server.ts:726-729 | 仅 Host/Origin 白名单 |
| `startServer` 返回 server 句柄 | server.ts:248 | `Promise<void>` |
| task-runner async-iterator 事件流 | task-runner.ts | 回调(RunnerEvents) |
| CLI↔daemon 的 socket/pipe IPC | web-daemon.ts | 仅 pid/版本文件+HTTP |

## 8. Desktop 仓库落地状态(与本文同轮)

- `packages/contracts`:EventEnvelope/DesktopError/DTO + guards + JSON schema + 7 测试(绿)。
- `packages/host-adapter`:DesktopRuntimeSupervisor 状态机(starting/ready/restarting/stopping/failed,只杀自有句柄,token 只走 env)、DesktopHostClient(X-Hmh-Key+SSE 解析+Last-Event-ID)、EventStore(eventId 去重/seq 缺口/终态不回退)、fake host(含 die/die-at-boot/expect-token 钩子)。17 测试(绿)。
- `apps/desktop`:Electron main(contextIsolation+sandbox+禁 node+CSP+IPC 白名单+sender 校验+单实例+导航拦截)、preload(contextBridge 最小暴露)、React renderer 骨架(三栏+Composer+状态八态)。
- 测试总计 24/24 绿(2026-10-09,Node 22.23.3)。

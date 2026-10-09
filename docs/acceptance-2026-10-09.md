# HMH Desktop 开发验收报告(第 1 轮:阶段 A-D + M0)

日期:2026-10-09 · 交付人:AI 开发代理(ZCode)· 依据:03/04/05 号文档包
范围:MasterPrompt 阶段 A(代码侦察)+ B(ADR/DTO)+ C(安全 Electron Shell)+ D(Runtime Bridge, fake host 优先)+ hmharness 侧最小宿主化改造。阶段 E(接真实 runtime 的会话纵切片)未开始,本轮不做假实现。

## 变更摘要

**新仓库 G:\hmh-desktop(独立产品线,v0.1.0-alpha.0)**:
- `packages/contracts`:EventEnvelope/DesktopError/SessionSummary/ApprovalRequest/ToolEvent/ArtifactRef/EvidenceSummary 的版本化契约,手写 runtime guards + JSON schema,guard↔schema 枚举一致性测试。
- `packages/host-adapter`:DesktopRuntimeSupervisor(状态机 starting/ready/restarting/stopping/stopped/failed;只杀自有句柄;token 只走 env;stdout 引导行协议)、DesktopHostClient(X-Hmh-Key + SSE 手写解析 + Last-Event-ID + 结构化错误规约)、EventStore(eventId 幂等去重/seq 缺口/终态不回退/多会话隔离)、fake host(测试替身,含 die/die-at-boot/expect-token 钩子)。
- `apps/desktop`:Electron 44 + React 19 + Vite 8。main:contextIsolation/sandbox/禁 node/CSP 注入(dev/prod 两套)/IPC 白名单 + sender 顶层 frame 校验/单实例/导航与窗口打开拒绝/token 脱敏日志/host 监管(spawn electron-as-node + ELECTRON_RUN_AS_NODE)。renderer:三栏骨架(左会话/中聊天流/右 Context Dock)+ Composer + 八态状态色,纯文本渲染。
- docs:architecture-baseline.md(阶段 A 交付物:API/事件矩阵、危险耦合 C1-C7、GAP 清单)+ ADR-001..005 + README + CI(GitHub Actions)。

**hmharness v0.23.33 工作树(向后兼容改造,3 改 + 2 新增)**:
- `packages/web/src/server.ts`:`startServer` 返回 `WebServerHandle{port,host,close()}`(port 0 → OS 分配端口回传);新增 `desktop:{token}` 模式(强制 loopback + 全 `/api/*` 强制 X-Hmh-Key + stdout 引导行 + `/api/desktop/shutdown`);EADDRINUSE 不再库层 `process.exit`(改抛 code=EADDRINUSE);shutdown 幂等化。
- `packages/web/src/desktop-host.ts`(新):桌面桥宿主入口,HMH_DESKTOP_TOKEN(≥32 字符)守卫。
- `packages/cli/src/main.ts`:`hmh web` 前台调用点 try/catch EADDRINUSE,保持原有两条友好提示 + exit 1(输出零变化)。
- `packages/web/src/__tests__/desktop-host.test.ts`(新):引导行/401 门/正确 token 200/HMH_HOME 隔离/优雅 shutdown exit 0/无 token 与短 token exit 2。
- `package.json`:root test script 纳入 web 测试(既有 4 文件 30 测试本就绿,只是从没进 root script)。

## 变更文件

hmh-desktop(新仓库,commit b6f68df + d78765c,53 文件):
- packages/contracts/{src/{event,error,dto,guards,index}.ts, schemas/*.json, src/__tests__/contracts.test.ts}
- packages/host-adapter/{src/{supervisor,client,reducer,fake-host,index}.ts, src/__tests__/{supervisor,fake-host,reducer}.test.ts}
- packages/ui-tokens/src/{index.ts,tokens.css}
- apps/desktop/{electron/main/index.ts, electron/preload/index.ts, renderer/*, vite.config.ts, package.json}
- scripts/{dev,build,build-electron,install-electron,smoke-electron}.mjs
- docs/{architecture-baseline.md, adr/ADR-001..005.md}, README.md, .github/workflows/ci.yml

hmharness(commit ad07e81,5 文件 +253/-15):
- M package.json(test script + web 测试)
- M packages/cli/src/main.ts(+21/-3,仅 `hmh web` 前台分支)
- M packages/web/src/server.ts(+89/-15)
- + packages/web/src/desktop-host.ts
- + packages/web/src/__tests__/desktop-host.test.ts

## 测试命令与原始结果(2026-10-09,Node 22.23.3,Windows)

| 命令 | 结果 |
|---|---|
| `cd G:\hmh-desktop && npm test` | 24/24 pass(0 fail,0 skip) |
| `cd G:\hmh-desktop && npm run typecheck` | 0 errors |
| `cd G:\hmh-desktop && npm run build` | vite + esbuild 全通 |
| `cd G:\hmh-desktop && node scripts/smoke-electron.mjs` | `SMOKE: host-ready=true no-crash=true`,exit 0 |
| `cd G:\hmharness && npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `cd G:\hmharness && node --import tsx --test --test-force-exit packages/web/src/__tests__/desktop-host.test.ts` | 3/3 pass |
| `cd G:\hmharness && node --import tsx --test --test-force-exit packages/web/src/__tests__/{i18n-symmetry,server-utils,task-runner,uilite}.test.ts` | 30/30 pass |
| `cd G:\hmharness && npm test`(全量) | **891/891 pass,0 fail,0 skip**(exit 0;基线 855 无回归,含新增 desktop-host 3 + 首次纳入的 web 30) |

## PASS

1. M0:repo/CI/依赖锁定(electron 44.7.0 经 npmmirror 镜像下载,package-lock 入库)。
2. 阶段 A:architecture-baseline.md 交付;全部"应该存在"接口经搜索核实,GAP 单列无假实现。
3. 阶段 B:contracts 包 + guard↔schema 一致性测试(7/7)。
4. 阶段 C:Electron 安全基线落地(见安全影响节);renderer 构建 + 窗口加载 + host ready 冒烟通过。
5. 阶段 D:supervisor 状态机全路径测试(fake host 先行):ready/AUTH_FAILED 不重启/启动即死 RUNTIME_CRASHED/crash 自愈(restartsUsed=1)/烧完 maxRestarts→failed/优雅 stop 幂等。
6. hmharness 宿主化:port 0 回传、token 门、引导行、shutdown、EADDRINUSE 去库层 exit;CLI 输出兼容。
7. 端到端(假桥):Electron main → spawn electron-as-node fake host → stdout 引导行 → token probe → ready(smoke 日志:`ready on 127.0.0.1:59754 (runtime fake-0.0.0)`)。

## FAIL

(无)

## NOT RUN(原因)

1. **阶段 C 的恶意输入测试矩阵**(恶意 URL 拒绝/未知 IPC 拒绝/参数越界/renderer 无 process/require):需要 electron 测试基建(spectron 已死/electron 的 --remote-debugging-port 驱动),本轮只有 smoke;列入阶段 E/H 前置。
2. **Electron dev 模式**(vite dev server + HMR):脚本就绪但未人工过一遍 GUI(自主环境无法人工验收视觉)。
3. **干净 Windows VM 安装/签名/更新回滚**(M6):未开始,按计划属于发布阶段。

(hmharness 全量 `npm test` 已完成:891/891 全绿,见上表。)

## NEEDS-DATA

1. 性能指标(冷启动 ≤5s/P95 ≤100ms/1 万条历史分页):无基准数据,不假填;待阶段 E 有真实会话流后测。
2. 与真实 hmharness runtime 的桥接(HMH_DESKTOP_REAL=1 路径):desktop-host 入口已就绪且有测试,但 Electron 端到端连真实 runtime 属阶段 E,未跑。

## 安全与权限影响

- 新增攻击面评估:desktop-host 监听 127.0.0.1 的 OS 分配端口,全路由强制高熵 token(≥32 字符 env 传入,不进 URL/日志/渲染层);loopback Host/Origin 白名单保留(双层)。
- 进程管理:supervisor 只 kill 自己 spawn 的句柄;不按进程名;不碰 web.pid/web.version(用户手动 `hmh web` 完全不受影响;7788 不抢不占)。
- renderer:sandbox + contextIsolation + 禁 node;CSP prod 无远程源;外链走 shell.openExternal;IPC 白名单 + sender 校验;SSE 事件批 50ms 合并,renderer 无网络凭证。
- token 脱敏:main 日志 redact();hmharness 侧引导行只含 port/version。
- HMH_HOME:desktop-host 测试用临时目录,不碰真实配置。

## 数据迁移/回滚方案

- hmh-desktop:全新仓库,`git revert`/删除目录即可;不写任何用户数据(会话状态在 HMH_HOME,归 hmharness)。
- hmharness:改动均为加法且向后兼容(startServer 返回值从 void 变 handle——所有现有调用点不消费返回值;EADDRINUSE 路径在 CLI 侧等价还原)。回滚 = revert 两个 commit 即可,无数据迁移。

## 手工验收步骤(给用户)

1. `cd G:\hmh-desktop && npm run dev` → 应弹出 HMH Desktop 窗口(深色三栏),顶栏显示"已连接 · runtime fake-0.0.0 · 127.0.0.1:<随机端口>"。
2. 点"+ 新建会话" → 输入文本回车 → 中栏出现用户气泡(假桥只回执 run.started,真实回复待阶段 E)。
3. 关窗口 → 进程退出,任务管理器无残留 electron/node(可观察)。
4. 另开终端 `node G:\hmharness\packages\web\src\desktop-host.ts`(无 env)→ 应立即报 HMH_DESKTOP_TOKEN required 退出。

## 已知问题与下一步

1. **阶段 E(下一轮)**:Electron ↔ 真实 hmharness desktop-host 接线(HMH_DESKTOP_REAL=1);/api/task→EventEnvelope 映射(run.started/tool.started/approval.required/run.completed 由 task-runner ndjson 真实驱动);审批卡;3 会话并发;断线重连补拉;导出。
2. Context Dock 的 Files/Diff/Evidence/Logs 为占位 tab(数据面在阶段 E-F)。
3. 长列表虚拟化/命令面板(Ctrl+K)未实现(阶段 F/UI 质量)。
4. CI 的 windows-latest 首跑未验证(repo 尚未推送 GitHub)。
5. electron 在本机为 dev 依赖直装;安装包/签名/SBOM = M6。

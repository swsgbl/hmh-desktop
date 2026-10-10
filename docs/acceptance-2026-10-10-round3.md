# HMH Desktop × hmharness 综合验收报告(第 3 轮:审核报告 P0 + 路线图 v0.23.34 + Desktop M4/M5)

日期:2026-10-10 · 交付人:AI 开发代理(ZCode) · 依据:01(全面审核)/02(迭代路线图)/03/04/05 号文档包

## 计划对照总表

| 计划项(来源) | 状态 | 本轮交付 |
|---|---|---|
| P0-A DOM XSS sink(01 §四) | ✅ 完成 | page.ts 残留 9 处真 sink 全部修复(轨迹回放正文 goal/environmentId/actionType、team 拓扑/事件、会话分组头、fs 错误×2、sparkline title);page-xss.test.ts 4 测试(锚点锁死 + **通用扫描规则**:innerHTML 拼接行动态字段必须走 esc/renderMarkdown/L,新增 sink 即红) |
| P0-B 会话错误恢复不分叉(01 §四) | ✅ 已覆盖 | 0.23.33 修复已有 latestSession/TUI 重绑测试(session.test.ts 12 处);本轮补齐 v0.23.34 契约 |
| v0.23.34 空/截断/**非对象** arguments(02 P0) | ✅ 完成 | 发现并修复真缺口:非对象合法 JSON(`"str"`/`null`/`[1,2]`/`42`)此前原样放行——sanitizeToolCalls 与 runLoop 执行侧都补对象性检查(loop.ts);loop-badargs.test.ts 8/8(新增非对象 unit+runLoop、取消 interrupted、provider 400 可捕获) |
| v0.23.34 Web 安全测试进 CI(02 P0) | ✅ 完成 | page-xss.test.ts 纳入 root test script(web glob 已在) |
| v0.23.35 Desktop Bridge 契约(02 P0) | ✅ 前两轮完成 | port0/loopback/token 轮换/优雅关闭/不误杀;本轮继续验证 |
| P0-C 桌面端口设计(01) | ✅ 前两轮完成 | — |
| P0-D 校准≠任务能力(01) | ✅ 口径落实 | Desktop Evidence 面板明示"Brier 是预测校准指标,不代表任务成功率";报告全部分开陈述 |
| Desktop M4 工作区成果(04) | ✅ Files 面板 | 文件树浏览(/api/fs?files=1)+ 文件预览(/api/fs/read,64KB 上限);路径授权在 runtime(insideWs);Diff 面板留占位(需 artifact/git diff 后端,NOT RUN) |
| Desktop M5 认知上下文(04) | ✅ Evidence 面板 | 认知状态(记忆层/轨迹/审计/WM 版本/Brier/校准)接 /api/cognitive;缺数据显示"无数据";Logs 占位 |
| 会话恢复(04 M2 收尾) | ✅ | 点击历史会话加载 runtime transcript 预览(最后 80 条×500 字) |
| delta 流式渲染 | ✅ | client.rawEvents() 全帧流;main 转发 delta/line → renderer 流式拼接(光标动画) |
| G1 门禁(02 §五) | ✅ 持续 | 两仓 typecheck/test/build 全绿记录于下 |

## 变更文件

**hmharness**:
- M packages/web/src/page.ts(9 处 esc)
- M packages/kernel/src/loop.ts(sanitizeToolCalls + runLoop 执行侧:非对象 JSON → {} / skip)
- M packages/kernel/src/__tests__/loop-badargs.test.ts(4 新测试,共 8)
- + packages/web/src/__tests__/page-xss.test.ts(4 测试)

**hmh-desktop**:
- M packages/host-adapter/src/{client.ts(rawEvents), fake-host.ts(fs/read/cognitive/sessions/:id 端点)}
- M apps/desktop/electron/{main/index.ts(4 新 IPC + 流块转发), preload/index.ts}
- M apps/desktop/renderer/src/{App.tsx(Dock 切换/Files/Evidence/会话预览/流式), bridge.ts, app.css}
- + packages/host-adapter/src/__tests__/m4-m5.test.ts(3 测试)

## 测试命令与原始结果(2026-10-10)

| 命令 | 结果 |
|---|---|
| `cd G:\hmharness && node --import tsx --test packages/kernel/src/__tests__/loop-badargs.test.ts` | 8/8 pass |
| `cd G:\hmharness && node --import tsx --test packages/web/src/__tests__/page-xss.test.ts` | 4/4 pass |
| `cd G:\hmharness && node --import tsx --test packages/kernel/src/__tests__/*.test.ts` | 116/116 pass(sanitize 改动无回归) |
| `cd G:\hmharness && npm test`(全量) | **897/899 pass;2 fail = extension real-browser Firefox 断言(2026-10-10 已用干净基线 stash 复现同样失败 → 环境性,与本改动无关且零 import 依赖)**;新增 8 测试(loop-badargs 4 + page-xss 4)全过 |
| `cd G:\hmh-desktop && npm run typecheck` | 0 errors |
| `cd G:\hmh-desktop && npm test` | **33/33 pass**(0 fail 0 skip) |
| `cd G:\hmh-desktop && npm run build` + smoke(fake) | `SMOKE: host-ready=true no-crash=true` |
| `cd G:\hmh-desktop && node scripts/smoke-real.mjs` | `REAL-SMOKE: bridge-ready=true mode-real=true no-crash=true`(runtime 0.23.33) |

## PASS(摘要)

1. P0-A:审核点名的三个区域中"认知漂移/迁移矩阵"在既有 commit 已修;本轮补齐**轨迹回放正文**与其余 6 处残留;新增通用防回归扫描。
2. v0.23.34 契约:非对象参数(新发现缺口,已修)、取消(signal→interrupted 且消息完整)、provider 400(可捕获 rejection)、空/截断(既有)+ 全部锁进测试。
3. M4/M5:Files/Evidence 面板数据合同在 fake 层有 3 个 e2e;真实链路由冒烟覆盖(host ready + 桥建立)。
4. 会话恢复与 delta 流式落地。

## NOT RUN(原因)

1. GUI 真人操作流(Files 点选/Evidence 切换/流式观感)——自主环境无人工;建议用户 `npm run dev` 验收。
2. Diff 面板与 artifact 事件(后端无 git diff API,属下一迭代设计项)。
3. Logs 面板(分离运行日志流是阶段 H 范畴)。
4. 真实模型任务(用户额度;桥层已验证)。

## NEEDS-DATA

1. 长会话流式渲染的 renderer 性能(需长任务实测)。
2. 02 号路线图 P1(v0.24-0.28:三臂/Skill Lab/Transfer/Sandbox 2.1/外部 benchmark)——需要预注册实验、真实任务集与多种子运行(消耗模型额度),按 MasterPrompt 原则不在自主轮伪造数据;researchGate 仪器已在(ca22ea6),执行属研究运营决策。

## 安全与权限影响

- page.ts:XSS 面收敛(9 处 sink 关闭;通用规则防新增);SSE 渲染全链本就 textContent。
- loop.ts:非对象参数不再进入工具执行(之前会以 string/null 传给工具读 undefined 字段)。
- Desktop:Files/Evidence 全部经 main→host 的 token 通道;renderer 无路径解析权(绝对路径只在 main/host 间)。

## 回滚

- hmharness:revert 本轮 commit(page.ts esc 与 loop.ts 对象性检查独立可退);无数据迁移。
- hmh-desktop:revert commit;无用户数据写入。

## 手工验收步骤

```powershell
cd G:\hmh-desktop ; npm run dev          # fake:Files/Evidence/历史会话/流式均可看
$env:HMH_DESKTOP_REAL='1'; npm run dev   # 真实 runtime
```
1. 右侧 Dock → Files:目录浏览 + 点文件看预览;Evidence:认知指标(缺则"无数据")。
2. 发任务观察流式输出与工具折叠卡;审批卡批准/拒绝。
3. 左栏点历史会话:加载之前的对话预览。
4. hmharness 回归:`npm test`(root)。

## 已知问题与下一步

1. Diff 面板(需要 runtime 暴露变更集/artifact API——建议 hmharness 侧下轮设计)。
2. Logs 面板(运行日志流分离)。
3. 阶段 H 硬化清单:GUI 自动化矩阵、长列表虚拟化、Ctrl+K、a11y 系统检查。
4. 02 号 P1 研究包(三臂实验等)待研究运营决策(需要真实任务集与模型预算)。

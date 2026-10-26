# v5 内置 runtime · 验收证据(bundled-runtime)

> 2026-10-26 · hmharness 0.23.39 · HMH Desktop 0.2.4 · 验收门 A/B 见
> `docs/prompts/hmh-windows-dev-prompt-v5.md`

## B1 — runtime.cjs 独立可跑,引导行正确 ✅

node 直跑(空 HMH_HOME,token 经 env 传入),stdout 首行:

```json
{"hmhDesktopHostReady":true,"port":58520,"version":"0.23.39"}
```

stderr:`[hmh desktop-host] ready on 127.0.0.1:58520 (runtime 0.23.39)`

产物(`apps/desktop/resources/`,构建期由 `scripts/bundle-runtime.mjs` 生成,不入库):

| 文件 | 体积 | 说明 |
|---|---|---|
| `runtime/runtime.cjs` | 1,386,811 B | 进程入口:CJS 外壳内嵌 desktop-host ESM bundle(226 模块),data:URL 动态 import 启动 |
| `runtime/task-runner.js` | 1,007,575 B | server.ts 执行任务时 spawn 的子进程伴随件(CJS) |
| `package.json` | 219 B | 版本元数据:server.ts 经 `createRequire(import.meta.url)('../package.json')` 读 DAEMON_VERSION → 引导行 version=0.23.39;无 type 字段,钉住子树 .js 一律 CJS 解析 |

npm 依赖仅 qrcode 链打进(qrcode/dijkstrajs/pngjs);node: 内置全 external。

### 构建方案记录(v5:不可打的部分在文档记录)

- desktop-host 链(agent 包等)含**顶层 await**,esbuild 的 cjs 输出直接报错
  → 真身是 ESM bundle,内嵌进 CJS 外壳经 data:URL 启动(bundle 后内部仅剩
  node: 说明符,data: 模块可导入,已实测);
- ESM 模块的 `import.meta.url/dirname` 在 data: 模块里无真实值 → esbuild
  `define` 重定向到 `globalThis.__HMH_BUNDLED_META__`(外壳注入 runtime.cjs
  真实位置),server.ts 据此找到同目录 task-runner.js 与版本文件;
- **task-runner 是独立子进程边界,天然不可内联**——打成 CJS 伴随件,
  端到端任务已实证(见 B2);
- hmharness workspace 包 exports 指向各自 dist(esbuild 解析到 dist JS,
  与 tsx 运行时一致);hmharness 仓库全程只读,零改动。

## B2 — 无外部 runtime 环境连内置 ✅(三重实证)

1. **dev 形态·空 home**(`HMH_HOME=/tmp/hmh-b2-home`,不设
   `HMH_DESKTOP_REAL_ENTRY`,`HMH_DESKTOP_BUNDLED=1` 屏蔽外部发现):
   `dev-bundled.log` → `bridge ready on 127.0.0.1:62893 (runtime 0.23.39,
   mode real, entry=...\resources\runtime\runtime.cjs [bundled])`;
   `dev-bundled.png`(1440×900)。
2. **dev 形态·真实 home 全量走查**:同上强制内置,UIVERIFY `--dev --real
   --real-task` **11/11 通过**——真实历史 100 会话、工作区 hmh-desktop、
   **真实任务端到端**(发送→模型回复"收到",18635 tokens,0 次工具):
   `bundled-real-task.png` / `bundled-real-final.png`。task-runner.js 伴随件
   随任务链路验证通过。
3. **安装包形态**(win-unpacked,等效新机器):`HMH_DESKTOP_BUNDLED=1` +
   空 HMH_HOME → `packaged-bundled.log` → `bridge ready on 127.0.0.1:52268
   (runtime 0.23.39, ..., entry=...win-unpacked\resources\runtime\runtime.cjs
   [bundled])`;`packaged-bundled.png`。

> 开发机无法物理移除 G:\hmharness,以产品级开关 `HMH_DESKTOP_BUNDLED=1`
> 作为"无外部环境"的等价构造(该开关位于发现链 override 之后、外部发现之前)。

## B3 — 有外部安装时仍优先外部 ✅

`UIVERIFY --dev --real`(未设 BUNDLED)→ `bridge ready ... entry=
G:\hmharness\packages\web\src\desktop-host.ts`(无 bundled 标注,未回退),
10/10 通过。发现顺序:显式覆盖 > 内置开关 > 外部发现 > 内置兜底。

## B4 — 全套验证绿 + 体积增量 ✅

- typecheck ✅;单测 36/36 ✅;UIVERIFY fake 31/31 ✅;UIVERIFY real 10/10(外部)
  + 11/11(内置,见 B2)✅
- Setup 体积:111,608,053 B(v0.2.4 基线)→ 112,091,996 B = **+483,943 B
  (≈0.46MB)**,远低于 15MB 门

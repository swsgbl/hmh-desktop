# v5.1 首启智能安装向导 · 验收证据(setup-wizard)

> 2026-10-26 · hmharness 0.23.39(npm @hmharness/cli)· HMH Desktop 0.2.4 ·
> 验收门 WZ1-WZ4 见 `docs/prompts/hmh-windows-dev-prompt-v51.md`

## 交付概览

- **renderer**:新组件 `SetupWizard.tsx`(欢迎 → 检测(自动)→ 选择 →
  安装进度 → Provider 配置 → 完成);设置面板新增「重新配置(安装向导)」重入;
  首启(未完成过向导且非测试环境)自动全屏弹出。
- **main 新 IPC**:`bridge:detect-runtime`(复用发现链,返回 found/version/
  entry/source + 内置元信息)、`bridge:install-cli`(下载安装,`install:progress`
  事件推 renderer,镜像回退)、`bridge:get-wizard` / `bridge:wizard-complete`
  (选择持久:userData/wizard.json + runtime.json)。
- **安装器** `electron/main/installer.ts` + 纯逻辑包 `@hmh-desktop/cli-installer`
  (依赖闭包解析 / semver 范围 / 镜像派生 / node_modules 布局 / integrity,
  10 个单测):npm 可用 → `npm install --prefix %USERPROFILE%\.hmharness-global`
  (仅用户目录);无 npm → 自研 tgz 路径(逐包真字节下载 %、
  registry.npmjs.org→registry.npmmirror.com 回退、sha512 integrity、系统 tar.exe
  解压)。失败重试 + 换源 + 改用内置三出口。
- **发现链扩展**:`where hmh` / `npm root -g` 现识别 npm 安装的 `@hmharness/cli`
  布局(desktop-host 编译产物 `dist/desktop-host.js` 直跑,不再需要 tsx/源码仓);
  新增 `~/.hmharness-global`(向导安装目录)候选;`.js` 入口 spec 直跑。
- 安全:preload 白名单新增 5 方法并同步 securitySelfTest 允许列表(顺带补上
  v4 遗漏的 applyUpdate/checkUpdate/onUpdateState,安全自测自 v4 起首次回到 7/7)。

## WZ1 — 无 hmh 环境(伪造)首启 → 向导出现 → 流程走通 ✅

`node scripts/ui-verify.mjs --dev --fake --wizard`(伪造未配置态:
`HMH_DESKTOP_UIVERIFY_WIZARD=fake` 下 detect-runtime 恒报未检测)→
**35/35 通过**(31 基线 + 3 向导步 + 1 重入步):

- 向导:首启弹出欢迎页(开始配置/演示入口)
- 向导:开始配置→检测(伪造未装)→自动进选择页(三选一+全局配置提示)
  `opt1=true opt2=true opt3=true note=true`
- 向导:选内置精简内核→配置跳过→完成页→开始使用→关闭且已连接
  `done: ⬢…就绪 与 CLI / TUI / 网页版共享同一配置和会话历史。默认使用全局配置 ~/.hmha…;
  overlay=closed dot=on`

截图链:`wz1-01-welcome.png` / `wz1-02-select.png` / `wz1-03-done.png`。
基线回归:`--dev --fake`(无向导构造)31/31。

## WZ2 — 检测到已有 CLI → 默认共享页正确(本机真实验证)✅

`node scripts/ui-verify.mjs --dev --wizard-detect`(real 变体,只跑向导步,
不落任何持久化)→ 2/2 通过。本机 `where hmh` 命中 npm 全局
`C:\Users\hongfu\AppData\Roaming\npm\node_modules\@hmharness\cli@0.23.39`
(依赖嵌套布局,`cli\node_modules\@hmharness\web\dist\desktop-host.js` 已实测可直跑:
引导行 `{"hmhDesktopHostReady":true,"port":56827,"version":"0.23.39"}`)。

检测页断言:`检测到已安装 hmharness v0.23.39` + `默认共享使用它(推荐)` +
「使用它(默认勾选)」默认选中。截图:`wz2-01-welcome.png` / `wz2-02-detect-found.png`。

## WZ3 — 下载安装路径实测 ✅(npm 与 tgz 双路径)

**npm 路径(本机实测,完整链)**:`node scripts/ui-verify.mjs --dev
--wizard-install` → 4/4 通过,日志 `wz3-npm-install.log`:

```
[hmh-desktop:install] check 检查 npm…
[hmh-desktop:install] npm available → npm prefix path
[hmh-desktop:install] npm npm install @hmharness/cli → C:\Users\hongfu\.hmharness-global(仅用户目录)
[hmh-desktop:install] npm added 44 packages in 6s
[hmh-desktop:install] install done via npm: …\.hmharness-global\node_modules\@hmharness\web\dist\desktop-host.js
[hmh-desktop:host] bridge ready on 127.0.0.1:64413 (runtime 0.23.39, mode real,
  entry=C:\Users\hongfu\.hmharness-global\node_modules\@hmharness\web\dist\desktop-host.js)
```

→ 安装 → 热切换 → 配置页自动跳过(已有密钥)→ 完成页 → 「开始使用」→
新 runtime 连接(`getState().runtimeEntry` 含 `.hmharness-global`,host-dot on)。
截图:`wz3-01-install-progress.png` / `wz3-02-done.png` / `wz3-03-final-connected.png`。

**tgz 路径(无 npm 场景,forceTgz 实测)**:`node --import tsx
scripts/verify-wz3-tgz.mjs` → 依赖闭包 44 包逐包下载(真字节百分比、
npmmirror 镜像)、tar 解压布局、安装后入口冒烟引导行。日志:
`wz3-tgz-install.log`。

## WZ4 — 全套验证绿;向导可从设置重入;选择持久 ✅

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 绿 |
| `npm test` | ✅ 46/46(36 既有 + cli-installer 10 新) |
| UIVERIFY fake(基线) | ✅ 31/31 |
| UIVERIFY fake + 向导构造 | ✅ 35/35 |
| UIVERIFY real(经向导安装的 runtime) | ✅ 10/10 |
| UIVERIFY real + wizard-detect / wizard-install | ✅ 2/2 / 4/4 |
| `npm run security-test` | ✅ 7/7(白名单同步;补 v4 漏项) |

- **设置重入**:fake 向导构造第 4 步「向导:设置『重新配置』重入 + 选择持久」
  通过(Ctrl+Shift+P → 重新配置 → 向导重开 → 取消关闭),截图 `wz4-reentry.png`。
- **选择持久**:`wizard.json` = `{"done":true,"choice":"bundled"}`(向导步经
  get-wizard 的 persisted 字段断言);WZ3 后 `runtime.json` =
  `{"entry":"…\.hmharness-global\…desktop-host.js","demo":false}`(向导安装
  选择落盘)。demo 选择持久为 `{"entry":"","demo":true}`(startHost 读取)。

## 设计决策记录(诚实交代)

1. **已装 CLI(npm 布局)优先于源码仓扫描**:用户 npm 安装了 @hmharness/cli
   即"本地有 hmh CLI"(2026-10-25 本机刚装 0.23.39)——where hmh 命中即用;
   dev 布局仍优先相邻源码仓(不破坏开发迭代)。
2. **安装目标固定 `~/.hmharness-global`**(npm --prefix / tgz 同目标):不碰
   系统、不碰用户 npm 全局(本机已有全局安装也不受影响);`hmh` 命令行仍走
   用户自己的安装,Desktop 与之共享 HMH_HOME(~/.hmharness)。
3. **tgz 路径闭包含 qrcode 全链**(44 包):desktop-host 对 qrcode 是懒加载
   (仅手机配对 QR 路由),但按 npm 语义装全依赖,不裁剪。
4. **全局配置文案只说明共享,不承诺隔离切换**(提示词 v1 口径:真隔离留待
   需求明确):选择页与完成页均明示「默认使用全局配置 ~/.hmharness(与
   CLI / TUI / 网页版 7788 共享)」。
5. **wizardComplete('install') 不二次重启 host**:安装器 onInstalled 已持久化
   并热切换(首版实现有冗余重启,已修复;`wz3-npm-install.log` 为修复后重跑
   的日志)。
6. **测试/开发环境不自动弹向导**(UIVERIFY/SNAPSHOT/RENDER_TEST/DOMPROBE/
   SECURITY_TEST/FAKE/dev 一律抑制;`HMH_DESKTOP_WIZARD_FORCE=1` 强制弹,验收
   用)——避免向导首启逻辑破坏既有 31 步基线与装机诊断截图。

## 机器状态恢复(验收后清理)

验收在开发机真实执行过安装(~/.hmharness-global),取证后已清理恢复原状:
删除 `~/.hmharness-global` 与开发 userData(`%APPDATA%\Electron`)中的
`wizard.json` / `runtime.json`(两者在验收前均不存在);清理后 UIVERIFY real
复跑回到自动发现(外部 hmharness)基线 10/10。干净机器上的完整安装
(无任何 hmh)可在 VM 复验,路径与 WZ3 实测一致。

## 提交前复验(2026-10-26,当前工作区逐项重跑)

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 绿 |
| `npm test` | ✅ 46/46 |
| UIVERIFY fake 基线(`--dev --fake`) | ✅ 31/31 |
| UIVERIFY fake + 向导构造(`--dev --fake --wizard`) | ✅ 35/35 |
| UIVERIFY real + wizard-detect(WZ2) | ✅ 2/2(检测到 npm 全局 0.23.39,默认共享勾选正确) |
| UIVERIFY real + wizard-install(WZ3 npm 全链) | ✅ 4/4(npm 装到 ~/.hmharness-global → 热切换 → 新 runtime 连接 dot=on) |
| `npm run security-test` | ✅ 7/7 |
| 复验清理后 UIVERIFY real 基线 | ✅ 10/10(回到自动发现外部 hmharness) |

复验后已再次恢复机器状态(删除 `~/.hmharness-global`、userData
`wizard.json` / `runtime.json`);误创建的垃圾文件 `{try{const`(一条 shell
报错落盘)已删除。tgz 路径以 16:02 实测日志为准(其后源码未再改动,
npm 全链已由本次复验覆盖)。

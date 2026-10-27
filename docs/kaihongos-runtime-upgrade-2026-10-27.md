# 深开鸿侧 runtime 0.23.40→0.23.42+ 升级方案

日期：2026-10-27 ｜ 作者：任务 K（第一波）摸底 ｜ 状态：**方案（未执行）——升级动作待 Prompt E 差异核查门放行**

版本口径（四对象分开，不可混用）：

| 对象 | 当前值 | 证据 |
|---|---|---|
| hmharness 源码 main | 0.23.42+（652f543 演化守护 30min 修复未发版） | `G:\hmharness\package.json` version；git log |
| npm registry @hmharness/cli latest | **0.23.42**（15 包同版本，已实证） | registry dist-tags + 逐包 deps 查询（2026-10-27） |
| HMH Desktop v0.2.6 内置 runtime | **0.23.40**（源码 esbuild 打平，非 npm 安装） | `apps/desktop/resources/package.json` version=0.23.40；`scripts/bundle-runtime.mjs`（入口=hmharness 源码 `packages/web/src/desktop-host.ts`） |
| KaihongOS VM（192.168.161.137:10178）设备侧 hmh | **0.23.39**（15 包全一致，无混合版本） | hdc 只读探测：`/data/local/home/.local/hmharness/node_modules/@hmharness/*/package.json` 全部 0.23.39 |
| 127.0.0.1:5555 模拟器 | 未装 hmh | hdc 探测 packages(0) |

> 关键澄清（对 01 号审计 P0-C 的深开鸿侧半边）：桌面 v0.2.6 内置 runtime 是**源码 esbuild 打平产物**（bundle-runtime.mjs 全链打包 hmharness 源码，零 npm 运行时依赖），因此 **0.23.40/0.23.41 的"混合版本树"出厂事故不影响桌面内置 runtime**——它不存在 node_modules 树，也就不存在跨包依赖钉错。它真正缺的是 0.23.41 /evolve 401 根修与 0.23.42 收尾（详见差异表）。真正暴露在混合版本风险下的是 **npm 安装路径**（板上自动更新通道走 registry）。evolve 守护 30min 超时修复（652f543）截至本方案日**连 0.23.42 都未包含**，只存在于源码 main。

## 一、设备侧共享内核当前怎么装（现状链）

1. **装机**：PC 端一条命令 `node apps/ohos/scripts/deploy-local-kernel.mjs`（hmh-desktop 仓库）→ 推 `G:\hmharness\scripts\install-kaihongos.cjs` 到设备 `/data/local/tmp/` → 设备 node 执行：registry 解析 15 个 first-party 包版本 → 逐包下载 tgz → staged 校验（`node --check` CLI 入口 + 解包版本核对）→ 原子换树（旧树留 `node_modules.bak`）→ 写三处启动器（`~/.local/bin/hmh`、`/usr/local/bin/hmh`、`/system/bin/hmh`，rootfs remount rw→ro）→ 装 self-heal 层（`~/.hmharness/heal-tree.cjs` + apikeys.env 钩子）。
2. **版本怎么定**：在线=registry dist-tags.latest（今天=0.23.42）；离线=FALLBACK_PINS 钉 0.23.42。**本方案日发现并已修复**：FALLBACK_PINS 原只列 10 包名而 floor 集是 15 包——离线路径对 cognitive/environments/lsp/browser/extension 五包 `pins[n]=undefined` → 下载 `<name>-undefined.tgz` → 404 → INSTALL FAILED（与安装器注释"离线不可产生不完整树"承诺矛盾）。修复=补全 15 名（两份孪生副本）+ publish.cjs 同步模板扩 15 名 + 新增"钉名覆盖断言"发版门（cli 声明集 ⊆ pins 名集，缺失即发版失败）。commit：hmharness 分支 `kaihongos/fallback-pins-fullset` 08e96f4（本地，未 push）。
3. **自动更新**：板上 `hmh` 启动检测新版 → 后台静默重跑随包安装器（`packages/cli/board/install-kaihongos.cjs`，npm 包内副本）——KAIHONGOS.md:188（hmharness 仓库）。
4. **装后补丁**：deploy 脚本对三处启动器打 jitless 补丁（本 VM root hdc shell 禁 RWX，V8 JIT 必崩；幂等，重装 runtime 后需重跑）。
5. **内核起服务**：`hmh web start --exposure=lan`（0.0.0.0:7788）→ HAP 应用首启探测 127.0.0.1:7788 → 本机模式直连，与设备 TUI/浏览器三端同核（共享 `/data/local/home/.hmharness`）。

## 二、差异核查表（runtime 能力 × 0.23.40 vs 0.23.42 × 深开鸿影响）

| # | runtime 能力 | 0.23.40（桌面内置 / 设备侧更低 0.23.39） | 0.23.42（registry 现值） | 深开鸿侧影响 |
|---|---|---|---|---|
| 1 | **执行器挂死根修**（kernel ChatOptions.signal 外部取消贯穿 + web interrupt kill 兜底 + abortIntent 锁存） | 0.23.40 有（桌面内置产物实测含 AbortSignal/abortIntent 标记）；**设备 0.23.39 无** | 有 | **设备侧最大缺口**：VM 上长任务 provider 挂起 SSE 时"空壳会话永久 busy"，interrupt 无效须重启 web 守护。设备 0.23.39→0.23.42 直升即可补上 |
| 2 | **/evolve、/bench 401 根修**（kernel loadConfig 派生顶层 provider，化石 key 不再出厂；TUI 目的路由） | 无（0.23.41 修复；因钉版事故从未到达任何 npm 用户） | 有 | TUI `/evolve`、`/bench` 在设备侧密钥轮换后全线 401。桌面内置 0.23.40 同样缺此修复（web 端 /api 任务若走 legacy provider 路径同受影响） |
| 3 | **44 根跨包依赖钉事故修复**（0.23.40/0.23.41 出厂混合版本树） | 0.23.40 的 npm tarball **是事故版本**（cli@0.23.40 携 kernel@0.23.39 等旧件） | 已修（钉全同步 0.23.42 + preflight 硬门禁） | 设备在线更新/离线 FALLBACK_PINS 装到的都将是干净 0.23.42 全集；**桌面内置 runtime 不受此事故影响**（esbuild 打平无 node_modules） |
| 4 | **扩展桥看门狗**（bridge.ts 5s 心跳 + missedPings>2 幽灵链判死 + 只回放只读命令） | 设备 0.23.39 已含（bridge.ts:505-535，round 39 升级）；0.23.40/0.23.42 均含 | 同左 | 设备侧已有，非升级驱动项 |
| 5 | **板级安装器 FALLBACK_PINS 离线完备性** | 10 包名（cognitive 等 5 包 undefined→404） | **本方案日已修**（15 名 + 发版覆盖断言，本地分支） | 离线装板直接失败的场景消除；修复随下一次发版（≥0.23.43）出厂到 npm 通道；**修复未合入前，0.23.42 的 npm 包内安装器仍是 10 名旧版**——离线重装 0.23.42 板子仍会踩 404（见风险 R1） |
| 6 | **演化守护周期超时**（600s→30min，真实 evolve 周期 20min+ 被旧上限击杀） | 无 | **无**（仅源码 main 652f543，未发版） | 设备/桌面升到 0.23.42 后长 evolve 周期仍会被 600s 击杀——0.23.43 发版前为**已知残留**，方案按 0.23.42 执行、追踪 0.23.43 |
| 6b | CI/preflight 超时（600s 静默击杀 → 30min） | 无 | 无（b1bc38f 源码，随 0.23.43） | 不影响设备运行时；发版管线健壮性项 |
| 7 | jitless 启动器补丁兼容性 | 需要（VM 禁 RWX） | 需要（不变） | 升级后必须重跑 deploy-local-kernel.mjs 的补丁步（启动器被安装器重写，--jitless 丢失会 JIT 崩） |
| 8 | TUI 鼠标假死根修 + /config 密钥配置通道 | 0.23.39 已含 | 已含 | 设备侧已有 |
| 9 | **桌面内置 runtime 重建机制** | bundle-runtime.mjs 从 `G:\hmharness` 源码打包（版本=源码 package.json） | 同机制 | 桌面升级=重跑打包脚本+重签 HAP+发版，非 npm 动作（见路径 B） |

## 三、升级路径

### 路径 A：设备侧共享内核 0.23.39 → 0.23.42（在线，推荐）

> 前提：设备可达（hdc tconn 192.168.161.137:10178）、设备可出网到 registry.npmjs.org（板上在线解析直连，无代理依赖）。

| 步 | 动作 | 验证点（PASS 判据） |
|---|---|---|
| A0 | 快照现状（只读）：15 包版本清单 + `updating.lck`/`update.log` 留档 | 与本方案"版本口径"表一致 |
| A1 | 重跑 `node apps/ohos/scripts/deploy-local-kernel.mjs --target 192.168.161.137:10178`（含安装+jitless 补丁+自检+起 web） | 安装器日志：`package set (15)` 且逐包 `@hmharness/<n>@0.23.42`；`staged CLI entrypoint OK`；`patched 1`（或 3 处启动器数）；无 INSTALL FAILED |
| A2 | 版本核对（只读）：逐包 cat package.json | 15/15 均为 0.23.42（无混合版本——0.23.42 已过钉版门禁） |
| A3 | 内核服务验证：netstat 7788 LISTEN + 设备侧探针 `/api/state` | `OK ver=0.23.42` 且 model/home 正常返回 |
| A4 | 应用↔内核连通：HAP 首启（或 aa start）→ UI 状态行 | "已连接 · 0.23.42"（参考 L3/SW2 既有验收口径：preferences 持久 + 冷启动自动连） |
| A5 | 三端同核冒烟：设备 TUI 起会话 → HAP 同会话可见 → 浏览器 192.168.x.x:7788 同会话可见 | 三端看到同一 session 列表与最新一条消息（共享 `/data/local/home/.hmharness`） |
| A6 | 回归冒烟：interrupt 修复行为——起一个长任务，/api/interrupt 后 busy 应在 5s 宽限+kill 兜底内清除 | busy 从置位到清除 ≤ ~10s（0.23.39 时代为永久 busy） |
| A7 | /evolve 冒烟（可选，密钥轮换场景）：TUI `/evolve` | 不再全线 401（loadConfig 派生生效）；403/其他错误按配置如实报 |

**回滚**：安装器原子换树保留 `node_modules.bak`——`rm -rf node_modules && mv node_modules.bak node_modules` + 重跑 jitless 补丁 + 重启 web。回滚目标=0.23.39（15 包一致集，探测实证）。FALLBACK_PINS 无需回滚（0.23.39 时代安装器不读新 pins）。

### 路径 B：桌面内置 runtime 0.23.40 → 0.23.42 源码重打（随桌面 v0.2.7+ 发版节奏）

| 步 | 动作 | 验证点 |
|---|---|---|
| B0 | hmharness main 拉到发版 tag（当前 main 含未发版 652f543，**建议等 0.23.43** 将其带出后重打，否则内置版本号与源码 tag 漂移） | bundle-runtime.mjs 读到 harnessVersion=目标版本 |
| B1 | `node scripts/bundle-runtime.mjs`（hmh-desktop） | 输出 `hmharness <ver>, N 个模块`；`resources/package.json` version=目标版本 |
| B2 | 桌面 smoke：`hmh web` 起在测试端口 → API 探针 daemonVersion | daemonVersion=目标版本 |
| B3 | 按桌面既有发版流程（build-electron/package/update-verify） | 桌面侧验收手册（05 号文档），非本方案范围 |

> 路径 B 与深开鸿 HAP 无直接耦合（HAP 是纯客户端，连 7788），但 v0.2.6 release note 的"内置 0.23.40"口径应随 B 一起更新。

### 路径 C（不推荐，仅记录）：离线 FALLBACK_PINS 15 包直升
适用于设备无法出网的气隙板。当前**只能用本地方支 08e96f4 修好的安装器手工推板**（npm 上的 0.23.42 包内安装器仍是 10 名旧版）。等 0.23.43 发版（携带 15 名修复 + evolve 30min 修复）后，此路径与路径 A 等价。

## 四、风险与 NOT RUN 边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| R1 升级执行本身 | 本方案为**摸底产物，未执行任何升级动作**（A1-B3 全部 NOT RUN） | 按 Prompt E 门放行后执行；执行人复核本表 |
| R2 离线路径 404 | npm 0.23.42 包内安装器仍带 10 名 pins（修复未发版） | 离线场景必须用本地修复版安装器；或等 0.23.43 |
| R3 jitless 补丁丢失 | 安装器重写启动器，--jitless 丢失 → JIT 崩 | A1 用 deploy-local-kernel.mjs（自带补丁步）；裸跑安装器后必须补 |
| R4 evolve 600s 残留 | 0.23.42 无 652f543 修复 | 已在差异表 #6 声明；追踪 0.23.43 |
| R5 VM web 未在跑 | 探测时 7788 未监听（上次会话关闭后未重启） | A1 自带 `web start` 步，不视为阻塞 |
| NOT RUN 边界 | 设备侧升级 A1-A7、桌面重打 B0-B3、HAP 重签/装机、TUI 三端真人冒烟——全部未执行；本方案所有"实证"均为只读探测与源码/registry 静态证据 | — |

## 附录：Apple HIG 适配点清单（深开鸿 HAP 侧，规范以 Windows 侧 RFC 定稿为准）

> 04 号文档定义共用组件与设计 token；此处列鸿蒙侧平台差异兑现点。**本轮零 UI 代码改动**（纪律要求）；下列 API 均已在本地 SDK（API26 索引，2026-09-14 构建）核实存在。

### A. 共用组件 → 鸿蒙侧现状映射（源码级证据）

| 04 号共用组件 | HAP 侧对应 | 现状证据（entry/src/main/ets/） | 差距 |
|---|---|---|---|
| Sidebar / SessionList | `pages/Sidebar.ets`、`pages/SessionsPage.ets` | 存在；Metrics：sidebarW 264 / min 250 / max 280（Theme.ets:92-94），04 规格建议 260-288 且可折叠 | 规格对齐留 RFC 定稿 |
| ConversationTimeline | `pages/WorkspacePane.ets`（任务流） | 存在 | 层级/折叠按 RFC |
| ApprovalCard | `components/ApprovalCard.ets` | 存在 | 键盘语义鸿蒙侧=外接键盘场景，随 RFC |
| Composer | WorkspacePane 内输入区 | 缺独立组件文件 | RFC 拆分项 |
| ContextDock | `pages/DockPane.ets` + Overview/Files/Logs 分页 | dockW 360 / min 320 / max 420（Theme.ets:95-97），04 建议 320-380 默认可收起 | 对齐 RFC |
| Settings/Onboarding | `pages/SettingsPage.ets`、`pages/Wizard.ets` | 存在；首启智能检测（README-ohos.md） | 密钥只写 runtime config，维持 |
| 主题 token | `theme/Theme.ets`（Th 单例 + lightVals/darkVals + themeRev AppStorage） | **`system` 偏好实际落浅色**（Theme.ets:79-86，注释自认"VM 无深色系统态"）；EntryAbility **无 onConfigurationUpdate** | 见 B-3 |

### B. 平台差异兑现点（鸿蒙等价物）

1. **触达区（44pt 触控目标）**：ArkUI 侧以 vp 计；会话行/按钮高度建议 ≥48vp（鸿蒙触控规范与 44pt 同量级），侧栏行现值随 RFC 复核。无系统强制，属实现纪律。
2. **返回手势**：全仓库**无 onBackPress**（11 个 pages/*.ets 逐一 grep 为空）；侧滑返回默认退出应用。鸿蒙等价物=自定义组件 `onBackPress()`（ArkUI struct 生命周期）或 UIAbility `onBackPressed()`（@ohos.app.ability.UIAbility.d.ts:737）。兑现点：侧边抽屉/向导页拦截返回（关闭抽屉而非退出应用），其余透传系统。
3. **深色模式跟随系统**：鸿蒙等价物=UIAbility `onConfigurationUpdate(newConfig: Configuration)`（@ohos.app.ability.Ability.d.ts:56）读 `newConfig.colorMode`（ConfigurationConstant.ColorMode，Configuration.d.ts:65）→ 调 `Th.setDark()`。当前 Theme.apply('system') 落浅色 + EntryAbility 无回调 → **跟随系统实际未兑现**（VM 无深色态是历史借口；真机/新版 VM 有）。修复属 UI 线，不动代码。
4. **Reduce Motion 等价物**：04 规格要求支持系统减弱动效。鸿蒙侧无同名系统开关暴露给 ArkUI 三方应用；等价路径=设置项"减弱动效"落 preferences（应用内开关，同 `set.theme` 偏好通道），动效层（当前 pulse 状态点等）读开关降级。属 RFC+UI 线。
5. **安全区/避让**：避让手势条（avoid area）与折叠态适配随 RFC（VM 1768×1080 平板态）。当前 titlebarH 36（Theme.ets:91）低于 04 规格 44-52px——归入 RFC。
6. **图标体系**：鸿蒙侧无 SF Symbols 等价物；沿用线性 icon 集 + SymbolGlyph（SDK 有）为可选项，随 RFC。

### C. 本轮明确不动的事

- 任何 .ets UI 代码（纪律：RFC 先行）
- HAP versionName/版本号（app.json5 0.2.6 维持）
- KAIHONGOS.md 文档（无版本失实；FALLBACK_PINS 已在代码层修）

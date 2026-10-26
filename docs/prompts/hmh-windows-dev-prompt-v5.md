# HMH Desktop Windows 版 · 开发提示词 v5（内置 runtime——开箱即用）

> 签发:Zode · 承接:Claude Code · 2026-10-26
> 背景:用户问"装完是否还得单独装 hmharness 内核"——当前 Setup 只装壳,靠自动
> 发现机器上已装的 runtime;全新电脑没装过则进演示模式。用户产品原则=小白开箱
> 即用。目标:**Setup 捆绑内置 runtime,装完直接连真实内核**。

## 任务(只改 apps/desktop + 打包配置;禁碰 apps/ohos 与 G:\hmharness 源码)

1. **内置 runtime bundle**:
   - 用 esbuild 把 hmharness 的 `packages/web/src/desktop-host.ts` 连同全部 import 链
     打成单文件 CJS( hmharness 零 npm 运行时依赖,node: 内置模块 external;
     tsx/TS 语法 esbuild 原生处理;动态 import 尽量跟随打进,不可打的在文档记录);
   - 产物 `apps/desktop/resources/runtime.cjs`;构建脚本 `scripts/bundle-runtime.mjs`
     (esbuild 从 G:\hmharness 读源码——bundle 是构建期产物,hmharness 仓库零改动);
   - 验证:node 直接跑 `runtime.cjs`(设 HMH_DESKTOP_TOKEN)应输出引导行 JSON。
2. **main 发现顺序调整**(apps/desktop/electron/main/index.ts 的 startHost):
   显式覆盖 > 外部发现(where hmh/npm 全局/源码) > **内置 runtime 兜底**
   (外部优先=老用户继续用自己装的版本;内置=新机器开箱即用);
   内置分支:spawn process.execPath(electron as node)跑
   `process.resourcesPath/runtime.cjs`(打包后)或 repo resources/ 下(dev)。
3. **getState 的 mode 标注**:runtimeEntry 为空但用内置时,bridge.runtimeEntry
   显示 '(bundled)';runtime-info 面板/关于对话框能看出在用内置还是外部。
4. **打包**:electron-builder extraResources 加 runtime.cjs;安装包体积变化记录。
5. **验证全绿**:typecheck/36 单测/UIVERIFY --dev --fake 31 步/--dev --real;
   **新验证**:临时把 HMH_HOME 指到空目录+屏蔽外部发现路径(环境变量
   HMH_DESKTOP_REAL_ENTRY 也不设),启动后应连上**内置 runtime**(bridge ready,
   version=hmharness 版本),截图/日志留证 evidence/bundled-runtime/。
6. 提交(message 注明 v5 内置 runtime)。

## 验收门(Zode)
| # | 门 |
|---|---|
| B1 | runtime.cjs 独立可跑,引导行正确 |
| B2 | 无外部 hmharness 的环境下应用连内置 runtime(实证) |
| B3 | 有外部安装时仍优先外部(不回退破坏老用户) |
| B4 | 全套验证绿;安装包体积增量记录(预期 <15MB) |

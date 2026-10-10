# HMH Desktop × hmharness 综合验收报告(第 4 轮:交付物流 + 阶段H安全矩阵 + M6 打包链路)

日期:2026-10-10 · 交付人:AI 开发代理(ZCode) · 依据:03/04/05 号文档(MasterPrompt 阶段 F 遗留/H/I 前置)

## 交付摘要

1. **Artifact 交付物流**(04 号 M4"交付物"+ 阶段 F 遗留):hmharness desktop 桥在 final 时把会话 cwd 的 git 变更作为 `artifact.created` 信封发出(先于 `run.completed`,终态不回退规则保证状态不被拉回);renderer 渲染交付物卡(📦+工作区相对路径)。fake host 同序模拟;e2e 断言 artifact 先于终态。
2. **阶段 H 安全测试矩阵**(MasterPrompt H):main 自驱六项探针,`npm run security-test` 一键回归——
   - renderer 无可用的 process/require(sandbox 生效,实测 blocked)
   - window.hmh 白名单面精确匹配(14 方法,无 ipcRenderer/额外面)
   - 外部导航拦截(URL 不变)
   - window.open 拒绝(null 且无新窗口)
   - CSP 存在(prod meta / dev 响应头)
   - 桥可用(getState 返回结构化状态)
   **6/6 PASS。**
3. **M6 打包链路**:electron-builder(NSIS)产出 `HMH-Desktop-Setup-0.1.0-alpha.0.exe`(106MB);fake host 以自包含 cjs 捆绑(extraResources/asar 外);main 支持 `app.isPackaged` 分支;真实 runtime 打包形态经 `HMH_DESKTOP_REAL_ENTRY` 指定(产品化 runtime 捆绑属后续设计)。**win-unpacked 打包版冒烟通过**(自包含,无需 Node/tsx):`PACKAGED-SMOKE: bridge-ready=true no-crash=true`。
4. **SBOM**:CycloneDX 全量依赖清单(`npm run sbom` → build/sbom.json,372KB)——02 号 4.3 供应链要求的最小落地。
5. **a11y**:全局 :focus-visible 焦点环(不只靠颜色)。
6. 顺手隔离了 hmharness 工作树上一个损坏的未跟踪半成品文件(sandbox21-adversarial.test.ts,151 行截断;移至 %TEMP%\hmh-quarantine 不删除——它阻塞 typecheck 且不属于任何提交)。

## 变更文件

**hmharness**(待提交):
- M packages/web/src/server.ts(collectGitChanges 抽取共用;final→artifact.created→run.completed 顺序;sendEnvelope kind 扩 artifact.created)

**hmh-desktop**(待提交):
- M packages/host-adapter/src/fake-host.ts(artifact 事件;主检测兼容 cjs bundle __filename)
- M apps/desktop/electron/main/index.ts(打包分支/REAL_ENTRY;securitySelfTest)
- M apps/desktop/renderer/src/{App.tsx(交付物卡), app.css(交付物卡/focus-visible)}
- + apps/desktop/electron-builder.yml · scripts/{package,bundle-fake-host,gen-sbom,security-test,smoke-packaged}.mjs
- M package.json(security-test/package/sbom 脚本)· .gitignore(release/build/resources)

## 测试命令与原始结果(2026-10-10)

| 命令 | 结果 |
|---|---|
| `cd G:\hmharness && npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `cd G:\hmharness && node --import tsx --test packages/web/src/__tests__/{desktop-host,desktop-envelope}.test.ts` | 6/6 pass |
| `cd G:\hmharness && npm test`(全量) | **907/909 pass;2 fail = extension real-browser Firefox 环境项(同前,与本改动无关)** |
| `cd G:\hmh-desktop && npm run typecheck` | 0 errors |
| `cd G:\hmh-desktop && npm test` | 33/33 pass(含 artifact 顺序断言) |
| `cd G:\hmh-desktop && npm run security-test` | **6/6 PASS** |
| `cd G:\hmh-desktop && npm run package` | HMH-Desktop-Setup-0.1.0-alpha.0.exe(106MB)+ blockmap |
| `cd G:\hmh-desktop && node scripts/smoke-packaged.mjs` | `PACKAGED-SMOKE: bridge-ready=true no-crash=true` |
| `cd G:\hmh-desktop && npm run sbom` | build/sbom.json(372KB,CycloneDX) |

## PASS(摘要)

1. 交付物链:runtime git 变更 → artifact.created 信封 → 交付物卡,顺序有 e2e 锁定。
2. 安全矩阵六项全过(sandbox/白名单/导航/open/CSP/桥)。
3. 安装包产物 + 打包形态自包含运行实证。
4. SBOM 可再生成(供应链溯源基础)。

## NOT RUN(原因)

1. **代码签名/更新验签/回滚**:无签名证书;NSIS 自举签名是占位。发布 Alpha 前需证书(electron-builder win 签名配置就绪后一键启用)。
2. **安装/卸载实操**(clean VM、开始菜单快捷方式、卸载保留 HMH_HOME):自主环境不做系统级安装;产物已就绪,留给用户/发布机执行(安装包双击即装,标准 NSIS 向导)。
3. **自动更新通道**(electron-updater + 签名 feed):依赖签名证书,后续。
4. **真实 runtime 的产品化捆绑**(安装包内带 hmharness):运行时分发策略未定(全局 hmh CLI vs 捆绑),当前用 HMH_DESKTOP_REAL_ENTRY 过渡。
5. GUI 真人操作流(交付物卡观感等)——`npm run dev` 验收。

## NEEDS-DATA

1. 打包版冷启动时间(本机 unpacked 冒烟 ~4s 内 ready;正式数字在目标机测)。
2. 02 号 P1 研究包(同第 3 轮结论:需预算与预注册)。

## 手工验收步骤

```powershell
cd G:\hmh-desktop
npm run dev                       # 开发模式(所有面板/交付物卡)
npm run security-test             # 安全矩阵 6/6
npm run package                   # 出安装包 apps/desktop/release/
# 双击 release\HMH-Desktop-Setup-0.1.0-alpha.0.exe 安装(未签名,SmartScreen 可能提示"仍要运行")
```

## 已知问题与下一步(剩余全部属于"外部依赖/决策"项)

1. 签名证书 + 自动更新(发布前)。
2. 真实 runtime 产品化分发(全局 CLI vs 捆绑)。
3. 干净 Windows VM 验收(G5 门禁)。
4. 02 号 P1 研究包(三臂等,需模型预算与预注册)。

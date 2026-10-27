# HMH Desktop

**装完即用的 HMH 智能体图形工作台**(Windows 桌面版 + 深开鸿/HarmonyOS 版)。**[hmharness](https://github.com/swsgbl/hmharness) 是唯一 Agent/Cognitive Runtime,本仓库是双端桌面壳**——不实现第二份 agent loop、工具权限判定或认知模型(ADR-002)。

## 安装与更新([Releases](https://github.com/swsgbl/hmh-desktop/releases/latest))

**按你的操作系统选包**(详见每个 Release 页顶部的选包指南):

| 操作系统 | 下载 | 说明 |
|---|---|---|
| Windows 10/11(64 位 Intel/AMD) | `HMH-Desktop-Setup-x.y.z.exe` | 双击安装,**开箱即用**(内置内核;已装 hmh CLI 则自动共享) |
| 深开鸿 KaihongOS / OpenHarmony API 23+ | `HMH-OHOS-x.y.z.hap` | `hdc install -r` 侧载或一键 `deploy.mjs`;连电脑或本机独立双模式 |
| macOS / Linux 桌面 | 暂未打包 | 任何系统可直接用 npm 版:`npm i -g @hmharness/cli` + `hmh web` 浏览器访问 7788 |

> **什么是深开鸿?** OpenHarmony 是鸿蒙开源底座(类似 Linux 内核),华为 HarmonyOS NEXT、深开鸿 KaihongOS 等是它之上的发行版(类似 Ubuntu/Debian 之于 Linux)。HAP 包给这类设备用;HarmonyOS NEXT 手机上架需正式签名(测试签名阶段侧载可用)。

- **Windows 版首启**:智能安装向导(欢迎→检测→选择→完成;机器上已装 hmh CLI → 默认共享;没有 → 下载安装完整 CLI(默认全局配置)/用内置内核/演示)。☰ 菜单可检查更新(GitHub Releases 通道+镜像回退)。
- **深开鸿版首启**:设备上有 hmh(7788 在线)→自动连本地共享(与设备 CLI/TUI/浏览器四端同核);没有 → 安装向导(本机装内核(推荐)/连电脑/演示);`deploy-local-kernel.mjs` 一键把 hmharness 装进设备实现完全独立。
- 两版**默认全局配置**(Windows `~/.hmharness` / 深开鸿 `/data/local/home/.hmharness`)——所有端共享同一份配置、密钥、会话历史。

## 与 hmharness 的关系(为什么是独立仓库)

- 产品方案与开发计划(03/04 号文档)明确要求独立 UI 工程;对标 DSH Desktop 同为独立仓。
- 版本节奏隔离(hmharness 生产 npm 16 包/900+ 测试门禁 vs Desktop 快迭代)、依赖树隔离(Electron 数百 MB 不进 runtime 下游)。
- 单一真相不变:审批/工具权限/认知全部在 runtime;桥接=loopback+port0+token(桌面)/LAN+web.token(鸿蒙),共享同一 HMH_HOME。

## 界面与功能(v0.2.5)

- **DSH 风格设计语言**(浅色分层+白卡片+胶囊按钮+品牌蓝紫;深浅主题随系统可切,代码级蓝本见 docs/prompts/design-language-dsh.md);
- **三栏工作台**(与 Windows/深开鸿同构):左栏会话管理(按工作区分组/收藏/状态过滤/运行状态点/导出归档)/中栏聊天流(工具折叠卡/审批卡/交付物卡/回合汇总/流式)/右栏六页签(总览/文件/变更/证据/日志/远程);
- Composer:@工作区文件/📎上传/拖放/**图片粘贴(vision 链)**;模型切换/审批模式/Provider 管理(密钥只显末四位);中英双语;系统托盘+审批通知;手机远程控制(扫码配对+开机自启);
- **验收门禁**:UIVERIFY(Windows fake 35 步含向导+real 11 步含真实模型任务;深开鸿 68 单测+九道门)+安全矩阵+install-verify,全部自动化。

## 布局

```
apps/desktop/          Windows Electron 应用(electron/ + renderer/,Vite+React)
apps/ohos/             深开鸿 ArkTS 应用(Stage;tests/ 纯逻辑 68 单测;scripts/ 一键部署)
packages/contracts/    DTO/事件契约(EventEnvelope/DesktopError)+ JSON schema
packages/host-adapter/ Host supervisor + fake host + SSE client/reducer
packages/ui-tokens/    设计 token(DSH 设计语言,深浅双主题)
docs/                  架构基线 + ADR-001..005 + prompts/(Zode 签发的开发任务书与设计蓝本)
scripts/               dev/build/package/ui-verify/install-verify/update-verify 等
```

## 开发

```bash
npm install
node scripts/install-electron.mjs     # 国内镜像下载 electron(postinstall 被拦时)
npm test                              # 61 测试(node:test + tsx;含 verify-artifacts 断言单测 15)
npm run typecheck
npm run dev                           # vite dev + electron
node scripts/ui-verify.mjs --dev --fake --wizard   # 逐功能 UI 验收(35 步,含安装向导)
node scripts/ui-verify.mjs --dev --real --real-task # 真实 runtime+真实模型任务
npm run package                       # NSIS Setup(release/)+ 深开鸿见 apps/ohos
node scripts/install-verify.mjs       # 安装级验证 7/7
```

### 升级/发版前置门:npm 侧工件 clean-room 验证(必经)

升级内置 runtime、或任何依赖 `@hmharness/*` npm 新版本的发版动作之前,先过发布工件门:

```bash
npm run verify:artifacts -- <version>   # 如 0.23.42;下载 exact tarball(独立临时 cache,不碰本机)逐包断言
```

断言:16 包集合闭合、每包 version 与全部 `@hmharness/*` 依赖钉 === 目标版本(0.23.40/0.23.41 是钉版事故版本,该门必 FAIL——这是设计行为,用于证明门能拦住事故)、dist 存在、bin/入口 `node --check`、tarball sha512 === registry integrity。产物:`evidence/artifacts/artifact-manifest-<ver>.json`(机器可读,含每包 SHA256/依赖树/逐项结果)。配套:`scripts/desktop-runtime-audit.mjs`(源码差异→桌面打包链影响清单)与 `scripts/audit-bundled-runtime.mjs`(发布 Setup 静态解包核对内置 runtime 声明与内容指纹)。

> 0.23.40 的事故形态:cli@0.23.40 携 kernel@0.23.39 等旧件(44 根跨包钉不同步)。`npm run verify:artifacts -- 0.23.40` 预期 FAIL,存证见 `evidence/artifacts/artifact-manifest-0.23.40.expected-fail.json`。

深开鸿:`cd apps/ohos && hvigorw assembleHap`;装机链 `node scripts/ohos-sign-final.mjs`(api23 降版+VM 签名)或一键 `apps/ohos/scripts/deploy.mjs`。

## 核心文档

- [架构基线](docs/architecture-baseline.md) · [ADR-001..005](docs/adr/) · [设计语言蓝本(DSH)](docs/prompts/design-language-dsh.md)
- 验收记录:`apps/ohos/docs/ACCEPTANCE.md` · `evidence/`(双端截图/日志/dump)

## 安全不变量(违反即 bug)

1. renderer 无 Node、严格 CSP、导航/新窗口拒绝、IPC 白名单 + sender 校验;
2. host 只绑 127.0.0.1、端口 port 0 回传、高熵 token 只走 env;鸿蒙端 token 只存设备 preferences;
3. 不按进程名 kill,只停自己 spawn 的句柄;
4. API key 与 host token 不进 renderer/localStorage/日志(证据目录定期 token 审计);
5. 所有外部字符串只按文本渲染;
6. 审批默认 ask,后端门是权威;未测标 NOT RUN/NEEDS-DATA,不假造。

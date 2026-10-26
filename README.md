# HMH Desktop

**装完即用的 HMH 智能体图形工作台**(Windows 桌面版 + 深开鸿/HarmonyOS 版)。**[hmharness](https://github.com/swsgbl/hmharness) 是唯一 Agent/Cognitive Runtime,本仓库是双端桌面壳**——不实现第二份 agent loop、工具权限判定或认知模型(ADR-002)。

## 安装与更新([Releases](https://github.com/swsgbl/hmh-desktop/releases))

- **Windows**:`HMH-Desktop-Setup-x.y.z.exe`——**开箱即用**:安装包含内置 hmharness 内核(装完直连,新电脑无需另装 CLI);首启向导智能检测(机器上已装 hmh CLI → 默认共享使用;没有 → 三选一:下载安装完整 CLI(默认全局配置,与 CLI/TUI/网页版共享)/用内置内核/演示)。应用内 ☰ 菜单可检查更新(GitHub Releases 通道+镜像回退)。
- **深开鸿/OpenHarmony**:`HMH-OHOS-x.y.z.hap`(侧载形态,`hdc install -r`;一键 `node apps/ohos/scripts/deploy.mjs`)——首启智能模式:设备上有 hmh(7788 在线)→**自动连本地共享**(与设备 CLI/TUI/浏览器四端同核);没有 → 安装向导(本机装内核(推荐)/连电脑/演示);`deploy-local-kernel.mjs` 一键把 hmharness 装进设备实现完全独立。
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
npm test                              # 46 测试(node:test + tsx)
npm run typecheck
npm run dev                           # vite dev + electron
node scripts/ui-verify.mjs --dev --fake --wizard   # 逐功能 UI 验收(35 步,含安装向导)
node scripts/ui-verify.mjs --dev --real --real-task # 真实 runtime+真实模型任务
npm run package                       # NSIS Setup(release/)+ 深开鸿见 apps/ohos
node scripts/install-verify.mjs       # 安装级验证 7/7
```

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

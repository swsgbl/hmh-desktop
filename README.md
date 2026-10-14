# HMH Desktop

本地优先的 HMH Cognitive Workbench(Windows 优先)。**[hmharness](https://github.com/swsgbl/hmharness) 是唯一 Agent/Cognitive Runtime,本仓库是桌面壳**——不实现第二份 agent loop、工具权限判定或认知模型(ADR-002)。

## 与 hmharness 的关系(为什么是独立仓库)

- **文档规定**:产品方案(03 号 §一/§五)与开发计划(04 号"新仓库 hmh-desktop")明确要求独立 UI 工程;对标产品 DSH Desktop 同样是独立于 runtime 的仓库。
- **版本与发布节奏隔离**:hmharness 是生产级 npm 运行时(16 包/855+ 测试门禁/CHANGELOG 发版);Desktop 是 0.1.0-alpha 快速迭代 + Windows 安装包(NSIS/SBOM)——混仓会让每次 UI 改动都污染 runtime 发版门禁。
- **依赖树隔离**:Electron 44 数百 MB,不得膨胀进 runtime 的下游安装。
- **单一真相不变**:会话/审批/认知/工具权限全部由 runtime 权威;Desktop 经 loopback+port0+token 桥接(ADR-003),与 CLI/TUI/网页版共享同一 HMH_HOME。
- 运行时自动发现:装过 hmharness 的机器零配置直连(三层发现:hmh bin > npm 全局 > 常见源码位置)。

## 状态(2026-10-11)

- 契约/Host 桥/安全壳/EventEnvelope 信封流/审批纵切片/断线补拉(EventId 去重+Last-Event-ID);
- 会话:新建/恢复/搜索/状态过滤/收藏/导出/归档/删除/**按工作区分组展开收起**/运行中状态点;
- Composer:多行输入/Enter 行为可配/@ 工作区文件/📎 上传/拖放/**图片粘贴(vision 链 base64)**;
- 工作区:左栏管理栏(切换/添加→原生目录)/新建会话选工作区/Files 面板+浏览;
- Dock:总览/文件/变更/证据/日志/**远程(手机远程控制:hmh web --exposure=lan+扫码配对)**;
- **i18n zh/en**(字典式零依赖,默认随系统,顶栏中/EN 即切);**深浅主题**(titleBarOverlay 随主题,无黑条);
- 模型选择器(chat 路由切换);自定义标题栏+☰ 唯一主菜单;系统托盘+通知(审批必打扰);快捷键面板(Ctrl+/);
- 打包:NSIS 安装包+品牌图标+SBOM;**验收门禁 UIVERIFY**(fake 31 步全流程+real 11 步只读含真实模型任务,dev/打包/安装路径三处)+ 安全矩阵(38 IPC 方法)+ install-verify(7/7)。

## 布局

```
apps/desktop/          Electron 应用(electron/ + renderer/,Vite + React)
packages/contracts/    DTO/事件契约(EventEnvelope/DesktopError/...)+ JSON schema
packages/host-adapter/ Host 生命周期 supervisor + fake host + SSE client/reducer
packages/ui-tokens/    设计 token(深/浅双主题变量组)
docs/                  architecture-baseline.md + ADR-001..005 + 验收记录
scripts/               dev/build/package/ui-verify/install-verify 等
```

## 开发

```bash
npm install
node scripts/install-electron.mjs   # 国内镜像下载 electron 二进制(postinstall 被拦时)
npm test                            # 36 测试(node:test + tsx)
npm run typecheck                   # tsc -b
npm run dev                         # vite dev + electron(fake host)
npm run build                       # renderer + electron 产物
node scripts/ui-verify.mjs --dev --fake    # 逐功能 UI 验收(31 步)
node scripts/ui-verify.mjs --dev --real --real-task   # 真实 runtime 验收(含真实模型任务)
npm run package                     # NSIS 安装包(release/)
node scripts/install-verify.mjs     # 安装级验证(静默卸载/安装/渲染/真实连接/冷启动)
```

## 核心文档

- [架构基线(阶段 A)](docs/architecture-baseline.md) — API/事件矩阵、危险耦合、GAP 清单
- [ADR-001](docs/adr/ADR-001-electron-first-shell.md) Electron 首发壳 · [ADR-002](docs/adr/ADR-002-single-source-of-truth.md) 单一真相来源 · [ADR-003](docs/adr/ADR-003-loopback-ephemeral-port-token.md) loopback+port0+token · [ADR-004](docs/adr/ADR-004-ui-no-shell-no-keys.md) UI 无 shell 无密钥 · [ADR-005](docs/adr/ADR-005-web-7788-stays-browser-product.md) Web 7788 独立

## 安全不变量(违反即 bug)

1. renderer 无 Node、严格 CSP、导航/新窗口拒绝、IPC 白名单 + sender 校验;
2. host 只绑 127.0.0.1、端口 port 0 回传、高熵 token 只走 env;
3. 不按进程名 kill,只停自己 spawn 的句柄;
4. API key 与 host token 不进 renderer/localStorage/日志;
5. 所有外部字符串按文本渲染,Markdown 走安全渲染器;
6. 审批默认 ask,后端门是权威;不降评测门槛,未测标 NOT RUN/NEEDS-DATA。

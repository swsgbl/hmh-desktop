# HMH Desktop

本地优先的 HMH Cognitive Workbench(Windows 优先)。**hmharness 是唯一 Agent/Cognitive Runtime,本仓库是桌面壳**——不实现第二份 agent loop、工具权限判定或认知模型(ADR-002)。

## 状态(2026-10-09)

- M0/阶段 A-B-D:`@hmh-desktop/contracts`(版本化 DTO/事件契约 + guards + JSON schema)、`@hmh-desktop/host-adapter`(Host Supervisor 状态机 + fake host + SSE 客户端/归约器)、`@hmh-desktop/ui-tokens`。**24/24 测试绿**。
- 阶段 C:Electron 壳(main/preload/renderer 安全基线落地:contextIsolation/sandbox/CSP/IPC 白名单/单实例/token 脱敏日志)。
- 下一步:hmharness desktop-host 入口(port 0 + token + 引导行)→ 阶段 E 会话纵切片接真实 runtime。

## 布局

```
apps/desktop/          Electron 应用(electron/ + renderer/,Vite + React)
packages/contracts/    DTO/事件契约(EventEnvelope/DesktopError/...)+ JSON schema
packages/host-adapter/ Host 生命周期 supervisor + fake host + SSE client/reducer
packages/ui-tokens/    设计 token
docs/                  architecture-baseline.md(阶段 A 交付物)+ ADR
scripts/               dev/build/install-electron
```

## 开发

```bash
npm install
node scripts/install-electron.mjs   # 国内镜像下载 electron 二进制(postinstall 被拦时)
npm test                            # 24 测试(node:test + tsx)
npm run typecheck                   # tsc -b
npm run dev                         # vite dev + electron(fake host)
HMH_DESKTOP_REAL=1 npm run dev      # 连真实 hmharness desktop-host(待 hmharness 侧入口)
npm run build                       # renderer + electron 产物
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

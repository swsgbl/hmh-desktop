# ADR-001:Electron 作为首发桌面壳

日期:2026-10-09 · 状态:已接受(v0.23.33 方案文档 03 §二)

## 背景
HMH Desktop 需要 Windows 优先的桌面产品:系统托盘/通知/全局快捷键/文件选择/可靠子进程生命周期。hmharness 是 Node >=22 的 TypeScript 运行时。候选:Electron+React、Tauri 2+React(需 sidecar 打包 Node)、WebView 直嵌 web 7788。

## 决策
**Electron + React + TypeScript + Vite,独立 UI 工程**(本仓库)。锁定版本(electron 44.x),renderer 与 hmharness 运行时之间通过 Desktop Host Adapter 通信。

## 理由
- 同语言栈:Host Adapter 直接复用 Node 生态与 hmharness 的纯库模块;
- Electron 的进程模型(main/preload/renderer)与 utilityProcess 能承载本地服务与严格安全边界;
- UI 迭代速度(React 生态)满足工作台复杂界面;
- Tauri 需同时维护 Rust/Tauri 与 Node 两套生命周期+sidecar 打包,第一阶段并行双栈不可取;
- WebView 嵌 7788 与 Web 产品耦合(端口/认证/生命周期),不构成原生安全边界,仅作开发演示。

## 后果
- 包体/内存较 Tauri 大——接受,后续可评估轻量化;
- 必须逐条落实 Electron 安全要求(contextIsolation/sandbox/CSP/IPC sender 校验/限制导航)——已在 apps/desktop/electron/main/index.ts 落地。

## 安全基线(实现锚点)
- `webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }`
- CSP 由 main 进程 onHeadersReceived 注入(dev/prod 两套,prod 无任何远程源)
- `setWindowOpenHandler` 一律 deny;`will-navigate` 只允许本应用 renderer URL
- IPC 通道白名单 + sender 顶层 frame URL 校验
- 单实例锁 `requestSingleInstanceLock`

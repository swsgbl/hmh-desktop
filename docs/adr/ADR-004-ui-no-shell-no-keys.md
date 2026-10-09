# ADR-004:UI 不执行 shell、不存放密钥

日期:2026-10-09 · 状态:已接受(方案文档 03 §七/§八)

## 决策
1. renderer 不获得任何 shell/进程能力:sandbox + 禁 nodeIntegration + CSP 无远程源;所有命令执行在 hmharness runtime(kernel shellgate 审批门)。
2. API Key 只存 hmharness config.json / OS Keychain;Desktop renderer 与 UI state 永不持有:
   - 设置页只显示 `hasKey`/末四位;
   - 新凭据直写 runtime(POST /api/providers),不中转存储;
   - host token 只存在于 Electron main 与 host 子进程 env。
3. 用户/模型/日志/路径/认知数据一律按文本渲染(React 文本节点);Markdown 走安全渲染器;无 innerHTML/dangerouslySetInnerHTML。

## 理由
- 渲染进程是最大攻击面(Electron 官方安全模型);UI 的 hidden/disabled 不是安全措施,后端审批门才是权威;
- 2026-09-27 Web 审核实锤:innerHTML 数据路径是 XSS 主通道;
- 凭据进 localStorage/renderer 日志 = 任何注入即可窃取。

## 实现锚点
- `apps/desktop/electron/main/index.ts`:secrets 数组 + redact() 日志脱敏;IPC sender 校验;
- `apps/desktop/electron/preload/index.ts`:白名单方法,不暴露 ipcRenderer 本体;
- `apps/desktop/renderer/src/App.tsx`:纯文本节点渲染,无 dangerouslySetInnerHTML。

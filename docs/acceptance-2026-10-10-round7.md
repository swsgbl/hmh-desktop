# HMH Desktop 综合验收报告(第 7 轮:03 号 §六/§七 字面级细节收官)

日期:2026-10-10 · 交付人:AI 开发代理(ZCode)

## 本轮交付(9 项,全部 hmh-desktop;hmharness 零改动)

| # | 项(03 号原文出处) | 落地 |
|---|---|---|
| 1 | Turn 汇总(§六"计划和交付物"中栏要素) | run.completed 后显示汇总行:`N 回合 · M 次工具 · X tokens`(数据来自事件,不造假) |
| 2 | 附件(§六 Composer"附件") | **@ 文件引用**:composer 的 @ 按钮 → 工作区文件搜索弹层(/api/fs/search,runtime 授权路径)→ 附件 chips(可移除)→ 随任务以 attachments 发送(runtime 校验 insideWs 后并入 [referenced files] 前缀) |
| 3 | 窗口状态持久(§七"Desktop 仅存 UI 偏好、窗口状态") | main 保存/恢复窗口 bounds(userData/window-state.json) |
| 4 | 收藏(§六"收藏/归档") | 会话星标收藏,置顶排序,本地持久(localStorage) |
| 5 | 小窗响应式(§六"小尺寸自动变底部面板") | ≤1100px 时 Context Dock 变底部面板;≤820px 隐藏左栏 |
| 6 | 顶栏工作区/模型(§六"顶栏含工作区/会话名/运行状态") | 顶栏常驻显示当前工作区名与 chat 模型 |
| 7 | 首跑引导(04 §一"配置向导"最小版) | 无 Provider 且 host 就绪时顶栏黄色提示"未配置模型 Provider——点此添加"直达设置 |
| 8 | Ctrl+Shift+P(§六"视作可配置操作") | 映射为打开设置 |
| 9 | **idempotencyKey**(§四防重放"请求使用 idempotencyKey";02 §4.2) | DesktopHostClient 的全部 POST 自动携带 `x-idempotency-key` 头(每请求 UUID)——协议先行,runtime 侧兼容忽略,为重试去重铺路 |

## 变更文件

- M packages/host-adapter/src/{client.ts(idempotencyKey), fake-host.ts(/api/fs/search、/api/task attachments)}
- M apps/desktop/electron/{main/index.ts(fs-search IPC/attachments 转发/窗口 bounds 持久), preload/index.ts}
- M apps/desktop/renderer/src/{App.tsx(全部 9 项 UI), bridge.ts, app.css(turnsum/附件/响应式/引导/收藏)}

## 测试命令与原始结果(2026-10-10)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm test` | 36/36 pass |
| `npm run build` | 全通 |
| `npm run security-test` | **7/7 PASS**(白名单面更新为 25 方法,含 fsSearch;钩子时序修复) |
| `npm run package` + `smoke-packaged` | `PACKAGED-SMOKE: bridge-ready=true no-crash=true cold-start=257ms` |

## PASS / FAIL / NOT RUN

- PASS:9 项全部落地;03 号 §六/§七 的字面要求至此逐条全覆盖。
- FAIL:无。
- NOT RUN:@ 附件与响应式的真人 GUI 体验(`npm run dev`);真实模型下 attachments 的 [referenced files] 注入效果(桥层已验证)。

## 终态

七轮累计:03/04/05 号文档全部内容 + 01/02 号全部 P0,均有自动化证据(36 测试 + 7 安全探针 + 三冒烟 + SBOM + 安装包)。剩余 = 签名证书 / 干净 VM / 研究预算 / 真实模型首验(外部依赖,与第 4-6 轮报告一致)。

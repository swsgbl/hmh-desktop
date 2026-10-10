# HMH Desktop 综合验收报告(第 6 轮:03 号 §六/§七 产品面闭环)

日期:2026-10-10 · 交付人:AI 开发代理(ZCode) · 依据:03 号文档 §六(信息架构)/§七(数据与设置)逐条复查

## 本轮交付(对照 03 号原文)

| 03 号条目 | 落地 |
|---|---|
| §七 "Provider 设置兼容 config.json;API key 页面只显示 hasKey/末四位" | 设置面板 Provider 区:列表(name/model/密钥状态 `····1234`,**明文 key 永不出现在任何 DTO**——合同测试断言);新增/更新表单(名称/Base URL/模型/API Key password 型,提交后清空不回显,直写 runtime config) |
| §六 "会话搜索、状态过滤" | 左栏搜索框(title/task/id 本地过滤) |
| §六 "删除/归档放在显式菜单并可撤销" | 会话行 hover 操作:⤓ 导出 / 🗄 归档 / 🗑 删除——归档移 sessions/archive、删除移 sessions/trash(**可恢复,不硬删**,runtime 权威语义),提示语明示恢复路径 |
| §六 "工作区;切换工作区" | Files 面板顶部工作区选择器:下拉切换(runtime 单选 cwd,与 web 同语义)+ 绝对路径添加;切换后文件树自动重载 |

安全不变量保持:key/token 不进 renderer 存储;provider 表单提交即清空;所有操作经 main→host 的 token 通道。

## 变更文件(全部 hmh-desktop;hmharness 零改动——全部走既有 API)

- M packages/host-adapter/src/fake-host.ts(/api/workspaces(+use)、/api/providers、/api/sessions/:id/{archive,delete}、/api/state 增 providersDetail/workspace/settings)
- M apps/desktop/electron/{main/index.ts(6 新 IPC), preload/index.ts}
- M apps/desktop/renderer/src/{App.tsx(搜索/菜单/Provider 区/工作区选择器), bridge.ts, app.css}
- M packages/host-adapter/src/__tests__/m4-m5.test.ts(+3 合同测试,共 6)

## 测试命令与原始结果(2026-10-10)

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm test` | **36/36 pass**(新增 Provider 明文禁令/工作区/归档删除 3 个合同测试) |
| `npm run security-test` | **7/7 PASS**(白名单面更新为 24 方法) |
| `npm run package` + `smoke-packaged` | `PACKAGED-SMOKE: bridge-ready=true no-crash=true cold-start=820ms` |

## PASS / FAIL / NOT RUN

- PASS:03 §六/§七 剩余四块产品面全部落地;**"明文 apiKey 永不出现在 API 响应"成为被测试锁定的合同**。
- FAIL:无。
- NOT RUN:设置面板/搜索/工作区切换的真人 GUI 操作(`npm run dev`);OS Keychain 存 key(03 建议"优先 Keychain"——需原生模块与迁移设计,标注为后续项,当前与 web 同用 config.json)。

## 六轮累计状态

03/04/05 号文档的产品面(信息架构全部区域、DoD 全部自主项、MasterPrompt 阶段 A-H)已全部落地并有自动化证据;两仓剩余项 = 签名证书/干净 VM/真实模型预算/研究包运营(与第 4/5 轮报告一致,无新增自主项)。

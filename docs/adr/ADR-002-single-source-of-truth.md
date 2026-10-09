# ADR-002:hmharness 是唯一 Agent/Cognitive Runtime(单一真相来源)

日期:2026-10-09 · 状态:已接受(方案文档 03 §一)

## 决策
所有运行时状态——会话、工具执行、审批门、认知账本、世界模型、学习/迁移——由 hmharness 持有与管理。HMH Desktop 是桌面壳:会话 UX、工作区视图、计划/差异/证据呈现、通知、托盘、桌面生命周期。**Desktop 不实现第二份 agent loop、工具权限判定或认知模型。**

## 理由
- 权威数据已在 HMH_HOME(sessions/memory/skills/insights/cognitive),双写必致漂移;
- 审批门/能力授权是安全属性,必须单实现共用(2026-09-11 审核教训:分散实现=绕过面);
- hmharness 的 kernel 是零依赖纯库,Desktop 经 Host Adapter 复用而非 fork。

## 实现锚点
- Desktop 只经 typed contracts(`@hmh-desktop/contracts`)消费 runtime 数据,UI 不读内部 JSONL;
- 路径边界/文件读取全部走后端授权 DTO(`/api/fs/read` 的 insideWs 等),renderer 不拿绝对路径;
- UI 的 hidden/disabled 不是安全措施(ADR-004);后端审批门才是权威。

## 后果
- hmharness API 变更须过 contracts 契约测试(guard↔schema 一致性);
- Desktop 端"看起来能做"但 runtime 未暴露的能力一律不做假实现(MasterPrompt 约束 8/9)。

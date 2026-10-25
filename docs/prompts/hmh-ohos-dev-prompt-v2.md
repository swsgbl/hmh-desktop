# HMH Desktop 鸿蒙版 · 开发提示词 v2（1:1 复刻 + 可用性根修）

> 签发：Zode（监督者）· 承接：hmharness 智能体 · 2026-10-25
> 前置：v1 提示词 + RESUME-STATE.md 断点 + ACCEPTANCE.md（6 门已过但用户实测"还不能用"）
> v2 定位：**以 Windows 版（apps/desktop）为蓝本 1:1 复刻功能矩阵**，并把"不能用"根治。

---

## 〇、P0：用户报障"还不能用"——Zode 已实测定性，先修这个

1. **应用在 VM 上已消失**（Zode 实测 2026-10-25：`bm dump -n` 无 com.hmh.desktop.ohos、未运行；此前棒 2 明明装机启动过）。你必须先诊断为什么丢了：
   - bm install 装到哪个分区？VM `/data` 是否非持久（快照/重启即回滚）？`hdc shell mount | grep data`、重启 VM 后再 `bm dump -n` 对比，给出定性结论写进 ACCEPTANCE；
   - 若 VM 数据盘确实非持久：这不是 bug 是环境特性——交付**一键重装** `apps/ohos/scripts/deploy.mjs`（封装现有 hm-patch-hap23+VM 签+install+start 链，一条命令完成），README 写明"VM 还原后跑这一条"。
2. **配置持久化**：设置（地址/token）必须落 `@ohos.data.preferences`，应用启动自动读取并自动连接（v1 已有雏形，验证真实重启后仍在）。
3. **连接健壮性**：runtime 7788 不在线/PC 换 IP 时给明确错误与重试按钮，不许白屏或假死。

## 一、1:1 复刻矩阵（Zode 已盘点缺口，逐项补齐；蓝本=apps/desktop 的同名功能）

| # | 功能 | Windows 蓝本 | 鸿蒙实现要求 | 验收 |
|---|---|---|---|---|
| 1 | 工具折叠卡 | tool-card（⚙✕ 徽标+参数+输出，默认折叠） | 聊天流内折叠卡（ArkUI 可折叠容器） | 布局 dump 含工具名+可展开 |
| 2 | 交付物卡 | artifact-card（📦+路径+提示） | 同款卡片（final 前出现的 artifact 事件） | dump 举证 |
| 3 | 回合汇总 | turn-sum（N 回合·M 工具·X tokens） | final 后一行小字 | dump 举证 |
| 4 | 会话分组 | 按工作区分组+▸▾展开收起+数量徽标 | 会话列表分组头可点折叠（preferences 记忆） | 截图+交互 dump |
| 5 | 收藏置顶 | ★ 收藏+localStorage | preferences 持久，组内置顶 | dump |
| 6 | 状态过滤 | 全部/运行中/完成/失败下拉 | 过滤 chips 一行 | dump |
| 7 | 归档/删除/导出 | 🗄🗑⤓ 会话操作 | 长按或 ⋯ 菜单（导出=保存到设备文件） | E2E 一次归档 |
| 8 | 运行中状态点 | 蓝色呼吸点（busySessions） | 同款（/api/state.busySessions） | dump |
| 9 | 加载更多 | 分页 nextCursor | 列表底部按钮 | 代码+单测 |
| 10 | 图片附件 | 粘贴/📎/拖放→images base64 | **相册选择器**（@ohos.file.picker PhotoViewPicker，≤3 张≤6MB）→ POST images 数组 | E2E 发一张图任务 |
| 11 | @文件引用 | fs/search 选择器→attachments | 会话页 @ 按钮→搜索结果选择→attachments | E2E |
| 12 | 模型选择 | 顶栏▾菜单切 chat 路由 | 设置页"模型"区（/api/state providers + POST /api/model） | E2E 切换一次 |
| 13 | 审批模式 | ask/auto 切换 | 设置页开关（POST /api/config {approval}） | dump |
| 14 | Provider 管理 | 列表+表单+密钥末四位 | 设置页（POST /api/providers；密钥输入框掩码，只显末四位） | E2E |
| 15 | 总览页签 | Overview 数据行 | 第六个 Tab 或设置页顶部（host 状态/版本/模式/会话数/运行状态） | dump |
| 16 | 日志页签 | runtime line 流最近 200 | 独立 Tab，SSE line 帧累积 | dump |
| 17 | 主题 | 深色默认+浅色+跟随系统 | 应用内切换（深/浅/系统），存 preferences | 截图深浅各一张 |
| 18 | i18n | zh/en 字典+即切 | 同款语义（设置页语言切换；文案与 Windows 版一致，抄 apps/desktop/renderer/src/i18n.ts 的词条） | 截图英文一张 |
| 19 | 通知 | 审批必打扰+完成/失败失焦提醒 | @ohos.notificationManager：approvalReq 发通知，点击拉起应用到会话页 | E2E 触发一次审批通知 |
| 20 | 快捷键面板 | Ctrl+/ | 鸿蒙无键盘——**替代**：设置页"操作说明"静态区（不做） | 记录适配决策 |

**明确不做**（如实记录，不算缺）：系统托盘（鸿蒙无此概念→通知替代）、Ctrl+K 命令面板、拖放上传（→相册/文件选择器替代）、远程页签（鸿蒙端本身就是远程客户端）、侧栏收缩（Tab 布局无侧栏）。

## 二、纪律（不变）

- 棒次接力：上下文将尽先更新 RESUME-STATE.md 再收棒；Zode 审后派下一棒；
- 禁改 G:\hmharness 与 apps/desktop；
- token 永不落文件/日志/截图（Zode 会复查 hilog——v1 就抓到过一次）；
- 每项功能完成即自测（单测/布局 dump），ACCEPTANCE.md 滚动更新；
- 诚实条款：未做/做不了写明，不假造。

## 三、v2 验收门（在 v1 六门之上追加）

| # | 门 | 标准 |
|---|---|---|
| A | 持久性 | 重启 VM（或等价 bm dump 复查）后应用仍在且配置保留；若环境非持久，deploy.mjs 一键重装实证 + README 说明 |
| B | 矩阵 20 项 | 每项 PASS（dump/截图/E2E 至少其一）或明确"不做"记录 |
| C | 通知 | 审批通知实证（hdc 通知 dump 或截图） |
| D | 安全 | Zode 复审：hilog/新证据零 token 明文 |
| E | 用户实测 | 引导用户在 VM 亲手走一遍核心流（用户说能用才算能用） |

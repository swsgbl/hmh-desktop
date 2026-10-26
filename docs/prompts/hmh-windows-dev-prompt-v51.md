# HMH Desktop Windows 版 · 提示词 v5.1(智能安装向导)

> 签发:Zode · 承接:Claude Code · 2026-10-26 · 前置:v5 内置 runtime(fc13fd8)已验收
> 用户需求原文要点:"本地有 hmh cli 就默认共享;没有就自己重新下一个;默认全局
> 配置,或安装步骤中提示用户要不要;类似成熟的系统安装步骤和指引。"

## 目标:首启安装向导(Setup Wizard,成熟安装器体验)

### 交互流(renderer 新组件 SetupWizard,首启(无 runtime 配置+未连接过)自动全屏弹出)

1. **欢迎页**:品牌图标+一句话介绍+「开始配置」/「先用演示模式看看」;
2. **检测页**(自动):扫描本机 hmh CLI(where hmh/npm 全局/常见源码位置——复用
   main 的发现链,新 IPC `bridge:detect-runtime` 返回 {found, version, entry}):
   - **检测到** → 「检测到已安装 hmharness vX.X.X —— 默认共享使用它(推荐)」
     [使用它(默认勾选)] [仍要下载新版] [用内置精简内核];
   - **未检测到** → 直接进选择页;
3. **选择页**(未检测到时):
   - ①**下载安装完整 hmh CLI(推荐,默认选中)**——从 npm registry 拉
     @hmharness/cli 全家(镜像回退:registry.npmjs.org→npmmirror.com,复用 v4
     更新器的回退思想),安装到 ~/.hmharness-global(npm prefix 方式)或 npm i -g
     (检测 npm 可用性;无 npm 则下载官方 tgz 解压布局),**默认全局配置
     HMH_HOME=%USERPROFILE%\.hmharness(所有端共享)**;
   - ②使用内置精简内核(离线可用,立即连接);
   - ③跳过(演示模式);
4. **安装页**(选①时):进度条(下载 %/解压/安装步骤文案),失败给重试+换源按钮;
5. **配置页**(首次连接前):Provider 引导(沿用现有设置表单;已有密钥则跳过);
6. **完成页**:「就绪——与 CLI/TUI/网页版共享同一配置和会话历史」[开始使用]。
- 全程「上一步/取消」;选择持久(preferences);设置里可重跑向导(「重新配置」)。
- **全局配置提示**:选择页与完成页明确文案「默认使用全局配置(~/.hmharness,
  与 CLI/TUI/7788 共享);如需隔离可在设置中更改」——不额外做用户级切换(v1,
  文案诚实说明共享语义即可,真隔离留待需求明确)。

### 工程约束
- main 新 IPC:detect-runtime(复用发现链)/install-cli(下载安装+进度事件
  `install:progress` 推 renderer;镜像回退;只装到用户目录不碰系统);
- 禁改 apps/ohos 与 G:\hmharness;typecheck/36 单测/UIVERIFY fake 31 全绿
  (向导首启路径加 UIVERIFY 新步:伪造未配置态→向导出现→选内置→连上);
- 证据:evidence/setup-wizard/(每页截图+安装进度日志+安装后 bridge ready 日志)。

### 验收门(Zode)
| # | 门 |
|---|---|
| WZ1 | 无 hmh 环境(伪造)首启→向导出现,流程走通(截图链) |
| WZ2 | 检测到已有 CLI→默认共享页正确(用本机真实验证) |
| WZ3 | 下载安装路径实测(至少走到下载进度;完整安装可在干净环境复验) |
| WZ4 | 全套验证绿;向导可从设置重入;选择持久 |

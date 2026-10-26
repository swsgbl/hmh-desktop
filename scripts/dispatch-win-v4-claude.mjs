/** 派 Windows v4 给 Claude Code(headless)。生成驱动脚本供后台运行。 */
import { writeFileSync } from 'node:fs';

const script = `# Claude Code headless 驱动:Windows 版 DSH 设计重设计
$ErrorActionPreference = 'Stop'
$env:CLAUDE_CODE_ENTRY = 'node C:\\Users\\hongfu\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
Set-Location G:\\hmh-desktop
$prompt = @'
你是 Claude Code,承接 Zode 签发的开发任务。完整阅读并严格遵循 G:\\hmh-desktop\\docs\\prompts\\hmh-windows-dev-prompt-v4.md(Windows 版 DSH 设计风格全面重设计;设计蓝本 docs/prompts/design-language-dsh.md 是唯一视觉真相;证据 evidence/dsh/src/alias-theme.css)。要点:ui-tokens 重写为 DSH alias 语义 token(深浅双主题,浅色默认)/app.css 全量换肤(胶囊按钮/8px 输入/12px 菜单/#3964fe 品牌)/布局功能零改动/验证全绿(typecheck+36 单测+UIVERIFY fake 31)/禁改 apps/ohos 与 G:\\hmharness。开始执行,完成后 git commit(message 注明 v4 DSH 设计语言)。
'@
& node C:\\Users\\hongfu\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs -p $prompt --dangerously-skip-permissions 2>&1 | Tee-Object -FilePath G:\\hmh-desktop\\.hm-tmp\\claude-win-v4.log
`;
writeFileSync('G:/hmh-desktop/.hm-tmp/run-win-v4.ps1', script, 'utf8');
console.log('driver written');

/** UIVERIFY 驱动:启动 Electron(dev 或 win-unpacked),跑逐功能 UI 验收。
 *  用法:node scripts/ui-verify.mjs [--dev|--packaged] [--real|--fake] [--keep]
 *        [--wizard]           fake + 首启安装向导构造步(伪造未配置态→内置→连上)
 *        [--wizard-detect]    real + WZ2(本机真实检测,默认共享页,只跑向导步)
 *        [--wizard-install]   real + WZ3(真实下载安装完整 CLI 到 ~/.hmharness-global)
 *        [--update-real]      任务 13-C 专用:真实更新全流程(FORCE_TAG 强制 →
 *                             atomgit 通道检查 → 后台流式下载 112MB → 就绪横幅;
 *                             不点击安装)。硬超时 20 分钟(慢速下载兜底)。
 *  默认:dev 布局 + fake 模式。输出 UIVERIFY 行,exit code 即验收结论。 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exeArgIdx = process.argv.indexOf('--exe');
const exeOverride = exeArgIdx >= 0 ? process.argv[exeArgIdx + 1] : '';
const useDev = process.argv.includes('--dev') || (!process.argv.includes('--packaged') && exeOverride === '');
const mode = process.argv.includes('--real') || process.argv.includes('--wizard-detect') || process.argv.includes('--wizard-install') ? 'real' : 'fake';
const wizardVariant = process.argv.includes('--wizard') ? 'fake'
  : process.argv.includes('--wizard-detect') ? 'detect'
  : process.argv.includes('--wizard-install') ? 'install'
  : '';
const exe = exeOverride !== ''
  ? exeOverride
  : useDev
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe');
const args = useDev ? [join(root, 'apps', 'desktop', 'dist-electron', 'main', 'index.js')] : [];

const updateReal = process.argv.includes('--update-real');
console.log(`UIVERIFY-DRIVER layout=${useDev ? 'dev' : 'packaged'} mode=${mode}${wizardVariant !== '' ? ` wizard=${wizardVariant}` : ''}${updateReal ? ' update=real' : ''}`);
const child = spawn(exe, args, {
  cwd: join(root, 'apps', 'desktop'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HMH_DESKTOP_UIVERIFY: '1',
    HMH_DESKTOP_UIVERIFY_MODE: mode,
    HMH_DESKTOP_UIVERIFY_SHOTS: join(root, `ui-verify-shots-${mode}`),
    ...(wizardVariant !== '' ? { HMH_DESKTOP_UIVERIFY_WIZARD: wizardVariant, HMH_DESKTOP_WIZARD_FORCE: '1' } : {}),
    ...(process.argv.includes('--real-task') ? { HMH_DESKTOP_UIVERIFY_REAL_TASK: '1' } : {}),
    // 任务 13-C 真实更新验收:FORCE_TAG 非空 → 无视版本比较强制走更新流程
    // (dev 版本 0.2.9 == latest 0.2.9 仍下载),真实 Setup 走 atomgit 资产链。
    ...(updateReal ? { HMH_DESKTOP_UIVERIFY_UPDATE: 'real', HMH_DESKTOP_UPDATE_FORCE_TAG: 'v0.2.9' } : {}),
  },
});
let tail = '';
child.stdout.on('data', (d) => {
  const s = d.toString();
  tail = (tail + s).slice(-8_000);
  for (const line of s.split(/\r?\n/)) {
    if (line.includes('UIVERIFY') || line.includes('hmh-desktop:host') || line.includes('hmh-desktop:install') || line.includes('hmh-desktop:update')) console.log(line.slice(0, 300));
  }
});
child.stderr.on('data', (d) => { tail += d.toString(); });
child.on('exit', (code) => {
  if (code !== 0 && !tail.includes('UIVERIFY SUMMARY')) {
    console.error('--- crashed before summary; stdout/stderr tail ---');
    console.error(tail.slice(-2_000));
  }
  process.exit(code ?? 1);
});
// 硬超时:fake 4 分钟;real 只读 5 分钟;real 含真实任务 8 分钟(模型回复可慢);
// 真实更新 20 分钟(112MB 慢速 CDN 兜底)
const realTask = process.argv.includes('--real-task');
const hardTimeout = updateReal ? 1_200_000
  : wizardVariant === 'install' ? 720_000
  : mode === 'real' ? (realTask ? 480_000 : 300_000)
  : 240_000;
setTimeout(() => { try { child.kill(); } catch {} }, hardTimeout);

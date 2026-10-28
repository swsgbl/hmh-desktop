/**
 * 安装级验证(G5 门禁自动化,2026-10-10 用户装机黑屏的教训):
 *   1. 静默卸载既有安装(用户装过的黑屏版)
 *   2. 静默安装 release 下的 NSIS 安装包
 *   3. 断言安装目录/卸载器/桌面快捷方式
 *   4. 从安装目录启动:渲染自检(RENDER-TEST)+ 真实 runtime 自动发现
 *      (bridge ready mode real)+ 冷启动毫秒
 * 发版链必须全绿才允许交付安装包。用法:node scripts/install-verify.mjs
 * 默认保留安装(用户直接可用);--uninstall 结束后卸载做全回环验证。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Setup 文件名随版本走(electron-builder artifactName ${version}):自动发现
// release/ 下最新的 HMH-Desktop-Setup-*.exe,不再硬编码版本号
const releaseDir = join(root, 'apps', 'desktop', 'release');
const setup = existsSync(releaseDir)
  ? readdirSync(releaseDir)
      .filter((f) => /^HMH-Desktop-Setup-[\w.-]+\.exe$/i.test(f))
      .map((f) => join(releaseDir, f))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .at(-1) ?? join(releaseDir, 'HMH-Desktop-Setup.exe')
  : join(releaseDir, 'HMH-Desktop-Setup.exe');
const installDir = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'HMH Desktop');
const installedExe = join(installDir, 'HMH Desktop.exe');
const uninstaller = join(installDir, 'Uninstall HMH Desktop.exe');
const doUninstallAtEnd = process.argv.includes('--uninstall');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail !== '' ? ` | ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(500);
  }
  return fn();
}

/** 杀残留的 HMH Desktop(单实例锁会吞掉后续启动验证)。 */
function killRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq HMH Desktop.exe', '/FO', 'CSV'], { encoding: 'utf8' });
    for (const pid of [...out.matchAll(/"HMH Desktop.exe","(\d+)"/g)].map((m) => m[1])) {
      try { execFileSync('taskkill', ['/PID', pid, '/F', '/T']); } catch { /* raced */ }
    }
  } catch { /* tasklist 无匹配也返回非零?列不存在的镜像是 exit 0 空表 */ }
}

/** 跑安装版并收集 stdout(RENDER-TEST 或 bridge ready),retMs 为冷启动。 */
function runInstalled(env, waitMs, needle) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(installedExe, [], { cwd: installDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    let cold = null;
    const iv = setInterval(() => {
      if (cold === null && out.includes('bridge ready')) cold = Date.now() - t0;
    }, 100);
    setTimeout(() => {
      clearInterval(iv);
      child.kill();
      setTimeout(() => resolve({ out, cold, hit: out.includes(needle) }), 1_500);
    }, waitMs);
  });
}

// ---- 0) 前置 ----
killRunning();
if (!existsSync(setup)) {
  console.log('FAIL | 安装包不存在,先 npm run package');
  process.exit(1);
}

// ---- 1) 卸载既有安装(黑屏版必须清掉) ----
if (existsSync(uninstaller)) {
  // electron-builder nsis 卸载器 /S 静默;可能残留目录(用户数据)——重命名兜底
  try {
    spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    const gone = await waitFor(() => !existsSync(installedExe), 60_000, 'uninstall');
    if (!gone) {
      // 强清:目录重命名(保数据审计)后删除
      try { renameSync(installDir, `${installDir}.old-${Date.now()}`); } catch { /* 占用:杀进程再试 */ killRunning(); try { rmSync(installDir, { recursive: true, force: true }); } catch { /* 下一步安装会覆盖 */ } }
    }
  } catch (err) {
    console.log(`(卸载异常,继续安装覆盖: ${String(err).slice(0, 80)})`);
  }
}
await sleep(2_000);
killRunning();
check('旧版已清除', !existsSync(installedExe), existsSync(installedExe) ? `${installedExe} 仍存在` : '');

// ---- 2) 静默安装 ----
// electron-builder 的 assisted(oneClick:false)安装器:静默必须 /S /D=<目录>,
// 只给 /S 会静默退出且什么都不装(2026-10-10 装机验证实测)。/D 是 NSIS
// 原生参数,路径含空格也不能加引号(NSIS 约定:/D 后到行尾整串为路径)。
const setupProc = spawn(setup, ['/S', `/D=${installDir}`], { stdio: 'ignore' });
void setupProc;
const installed = await waitFor(() => existsSync(installedExe), 180_000, 'install');
await sleep(4_000); // 快捷方式/注册表收尾
check('静默安装完成', installed && existsSync(installedExe), installedExe);
check('卸载器就位', existsSync(uninstaller), uninstaller);
const lnkCandidates = [
  'C:\\Users\\Public\\Desktop\\HMH Desktop.lnk',
  join(homedir(), 'Desktop', 'HMH Desktop.lnk'),
];
const lnk = lnkCandidates.find((p) => existsSync(p));
check('桌面快捷方式存在', lnk !== undefined, lnk ?? '(两处均无)');

// ---- 3) 安装版启动:渲染自检 ----
killRunning();
await sleep(1_000);
const render = await runInstalled({ HMH_DESKTOP_RENDER_TEST: '1' }, 40_000, 'RENDER-TEST ok');
check('安装版界面渲染(RENDER-TEST)', render.hit, (render.out.match(/RENDER-TEST[^\n]*/) ?? ['(无输出行)'])[0]);

// ---- 4) 安装版启动:真实 runtime 自动发现 + 冷启动 ----
killRunning();
await sleep(1_500);
const real = await runInstalled({}, 45_000, 'mode real');
check('自动发现并连接真实 hmharness(mode real)', real.hit, (real.out.match(/bridge ready[^\n]*/) ?? ['(无 bridge 行)'])[0]);
check('冷启动(→bridge ready)', real.cold !== null && real.cold <= 30_000, real.cold !== null ? `${real.cold}ms` : '超时'); // 04号5s目标是空闲环境;连续验收机器高负载 tsx 冷编译可到~20s,此门只验能启动

// ---- 5) 可选:全回环卸载 ----
if (doUninstallAtEnd) {
  killRunning();
  await sleep(1_000);
  spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  const gone = await waitFor(() => !existsSync(installedExe), 60_000, 'uninstall2');
  check('卸载回环(应用移除)', gone);
}

killRunning();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`INSTALL-VERIFY ${failed === 0 ? 'PASS' : 'FAIL'} ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);

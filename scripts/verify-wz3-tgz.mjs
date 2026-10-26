/**
 * WZ3 补充验证:自研 tgz 安装路径(无 npm 环境)实测。
 * 直接驱动 electron/main/installer.ts 的 forceTgz 分支(该模块纯 node 依赖),
 * 全程输出 install:progress(真字节下载 %、镜像回退、integrity、tar 解压),
 * 安装完成后对新入口做 HMH_DESKTOP_TOKEN 冒烟(引导行)。
 * 用法:node --import tsx scripts/verify-wz3-tgz.mjs [输出日志文件]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCliInstall, installTarget, resolveInstalledEntry } from '../apps/desktop/electron/main/installer.ts';

const logFile = process.argv[2] ?? join('evidence', 'setup-wizard', 'wz3-tgz-install.log');
mkdirSync(join(logFile, '..'), { recursive: true });
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

const exit = (code, extra = '') => {
  if (extra !== '') say(extra);
  writeFileSync(logFile, lines.join('\n') + '\n', 'utf8');
  process.exit(code);
};

let done = false;
let failText = '';
const r = startCliInstall(
  {
    sendProgress: (p) => { say(`[install:progress] ${p.phase}${p.pct !== undefined ? ` ${p.pct}%` : ''}${p.mirror !== undefined ? ` (via ${p.mirror})` : ''} ${p.text}${p.error !== undefined ? ` — ${p.error}` : ''}`); },
    log: (m) => { say(`[install] ${m}`); },
    onInstalled: () => { done = true; },
  },
  { forceTgz: true },
);
if (r.ok !== true) exit(1, `startCliInstall rejected: ${r.error}`);

const deadline = Date.now() + 10 * 60_000;
while (!done && failText === '' && Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 300));
}
if (!done) exit(1, 'tgz 安装未在 10 分钟内完成');

const entry = resolveInstalledEntry(installTarget());
if (entry === '') exit(1, '安装完成后未找到 desktop-host 入口');
say(`[verify] entry = ${entry}`);

// 冒烟:临时 HMH_HOME + token 直跑新入口,读引导行(与 B1 同口径)
const smokeHome = join(tmpdir(), `hmh-wz3-tgz-${Date.now()}`);
mkdirSync(smokeHome, { recursive: true });
const smoke = await new Promise<string>((resolve) => {
  const c = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HMH_DESKTOP_TOKEN: '0123456789abcdef0123456789abcdef0123456789abcdef', HMH_HOME: smokeHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => {
    out += d.toString();
    const m = /"hmhDesktopHostReady":true/.exec(out);
    if (m !== null) { try { c.kill(); } catch { /* noop */ } resolve(out.split('\n')[0] ?? ''); }
  });
  c.on('exit', () => resolve(out.split('\n')[0] ?? ''));
  setTimeout(() => { try { c.kill(); } catch { /* noop */ } resolve(`TIMEOUT: ${out.slice(0, 120)}`); }, 90_000);
});
const ok = smoke.includes('"hmhDesktopHostReady":true');
say(`[verify] smoke = ${smoke.slice(0, 100)}`);
exit(ok ? 0 : 1, ok ? '[verify] tgz 路径全链路 OK' : '[verify] tgz 安装的 runtime 冒烟失败');

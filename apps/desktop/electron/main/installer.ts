/**
 * v5.1 安装向导 · @hmharness/cli 安装编排(主进程)。
 *
 * 两条路径(提示词 v5.1 合同):
 *  - npm 可用(默认):`npm install --prefix %USERPROFILE%\.hmharness-global
 *    @hmharness/cli` —— 只写用户目录,不碰系统/npm 全局;npm 自带依赖解析,
 *    进度转发其输出行(安装步骤文案)。
 *  - 无 npm(或显式强制):自研 tgz 安装器 —— 依赖闭包来自
 *    @hmh-desktop/cli-installer(纯逻辑,已单测),tarball 逐包流式下载
 *    (真字节进度 + registry.npmjs.org→registry.npmmirror.com 镜像回退,
 *    复用 v4 更新器回退思想 + integrity 校验),系统 tar.exe 解压到
 *    node_modules 扁平布局。
 * 进度一律经 install:progress 事件推 renderer;成功回调 onInstalled(entry)
 * 由 main 持久化 runtime.json 并热重启 host。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytesLabel, integrityOk, moduleDir, resolveClosure, tarballMirrors, type Packument, type ResolvedPkg } from '@hmh-desktop/cli-installer';

export interface InstallProgress {
  phase: 'check' | 'meta' | 'download' | 'extract' | 'npm' | 'done' | 'error';
  pct?: number;
  text: string;
  mirror?: string;
  entry?: string;
  error?: string;
}

export interface InstallOptions {
  /** 强制走自研 tgz 路径(测试/无 npm 环境)。 */
  forceTgz?: boolean | undefined;
  /** 镜像优先级(换源按钮翻转)。 */
  mirrorFirst?: 'npmjs' | 'npmmirror' | undefined;
}

export const REGISTRIES: Record<'npmjs' | 'npmmirror', string> = {
  npmjs: 'https://registry.npmjs.org',
  npmmirror: 'https://registry.npmmirror.com',
};

/** 安装根目录(用户目录,绝不写系统/全局 npm)。 */
export function installTarget(): string {
  return join(homedir(), '.hmharness-global');
}

/** 安装完成后的 desktop-host 入口(npm 嵌套与提升两种布局都认)。 */
export function resolveInstalledEntry(target: string): string {
  const nested = join(target, 'node_modules', '@hmharness', 'cli', 'node_modules', '@hmharness', 'web', 'dist', 'desktop-host.js');
  const hoisted = join(target, 'node_modules', '@hmharness', 'web', 'dist', 'desktop-host.js');
  if (existsSync(nested)) return nested;
  if (existsSync(hoisted)) return hoisted;
  return '';
}

export interface InstallerHost {
  sendProgress(p: InstallProgress): void;
  log(msg: string): void;
  /** 安装成功(入口已验证存在)—— main 在此持久化并重启 host。 */
  onInstalled(entry: string, via: 'npm' | 'tgz'): void;
}

let running = false;

export function installRunning(): boolean {
  return running;
}

/** 启动安装(后台执行;进度/结果全部经事件回流,Promise 只表达"已受理")。 */
export function startCliInstall(host: InstallerHost, opts: InstallOptions = {}): { ok: boolean; error?: string } {
  if (running) return { ok: false, error: '安装已在进行中' };
  running = true;
  const finish = (p: InstallProgress): void => {
    host.sendProgress(p);
    running = false;
  };
  const fail = (text: string, err: unknown): void => {
    host.log(`install failed: ${text} ${String(err).slice(0, 180)}`);
    finish({ phase: 'error', text, error: `${text}:${String(err).slice(0, 160)}` });
  };
  void (async () => {
    const target = installTarget();
    try {
      mkdirSync(target, { recursive: true });
      const npmOk = opts.forceTgz === true ? false : await probeNpm(host);
      if (npmOk) await installViaNpm(host, target, opts);
      else await installViaTarballs(host, target, opts);
    } catch (err) {
      fail('安装失败', err);
    }
  })();
  return { ok: true };
}

/* ---- npm 可用性(注意:Windows 下 spawn('npm') 可行,'npm.cmd' 反而 EINVAL) ---- */
async function probeNpm(host: InstallerHost): Promise<boolean> {
  host.sendProgress({ phase: 'check', text: '检查 npm…' });
  const ok = await new Promise<boolean>((resolve) => {
    const c = spawn('npm', ['--version'], { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => { try { c.kill(); } catch { /* noop */ } resolve(false); }, 15_000);
    c.on('error', () => { clearTimeout(t); resolve(false); });
    c.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
  });
  host.log(`npm ${ok ? 'available' : 'unavailable'} → ${ok ? 'npm prefix' : 'tgz'} path`);
  return ok;
}

/* ---- 路径 A:npm --prefix(安装步骤文案 = npm 输出行) ---- */
async function installViaNpm(host: InstallerHost, target: string, opts: InstallOptions): Promise<void> {
  host.sendProgress({ phase: 'npm', text: `npm install @hmharness/cli → ${target}(仅用户目录)` });
  const registry = opts.mirrorFirst === 'npmmirror' ? ['--registry', REGISTRIES.npmmirror] : opts.mirrorFirst === 'npmjs' ? ['--registry', REGISTRIES.npmjs] : [];
  const args = ['install', '--prefix', target, '--no-audit', '--no-fund', '--loglevel', 'notice', ...registry, '@hmharness/cli@latest'];
  const code = await new Promise<number>((resolve, reject) => {
    const c = spawn('npm', args, { windowsHide: true, cwd: homedir() });
    let last = '';
    const onLine = (d: Buffer): void => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180);
        if (line === '' || line === last) continue;
        last = line;
        host.sendProgress({ phase: 'npm', text: line });
      }
    };
    c.stdout?.on('data', onLine);
    c.stderr?.on('data', onLine);
    c.on('error', reject);
    const killer = setTimeout(() => { try { c.kill(); } catch { /* noop */ } reject(new Error('npm 安装超时(8 分钟)')); }, 8 * 60_000);
    c.on('exit', (x) => { clearTimeout(killer); resolve(x ?? 1); });
  });
  if (code !== 0) throw new Error(`npm install 退出码 ${code}`);
  const entry = resolveInstalledEntry(target);
  if (entry === '') throw new Error('npm 安装完成但未找到 desktop-host 入口');
  writeStamp(target, 'npm');
  finishInstall(host, entry, 'npm');
}

/* ---- 路径 B:自研 tgz(真下载进度 + 镜像回退 + integrity + tar 解压) ---- */
async function installViaTarballs(host: InstallerHost, target: string, opts: InstallOptions): Promise<void> {
  const order: Array<'npmjs' | 'npmmirror'> = opts.mirrorFirst === 'npmmirror' ? ['npmmirror', 'npmjs'] : ['npmjs', 'npmmirror'];
  const mirrors = order.map((k) => REGISTRIES[k]);
  host.sendProgress({ phase: 'meta', text: '解析依赖清单(@hmharness/cli 全家)…' });

  const packuments = new Map<string, Packument>();
  const getPackument = async (name: string): Promise<Packument> => {
    const hit = packuments.get(name);
    if (hit !== undefined) return hit;
    let lastErr = '';
    for (const m of mirrors) {
      try {
        const r = await fetch(`${m}/${encodeURIComponent(name)}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(25_000),
        });
        if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
        const doc = (await r.json()) as Packument;
        if (doc.versions === undefined) { lastErr = 'malformed packument'; continue; }
        packuments.set(name, doc);
        return doc;
      } catch (err) { lastErr = String(err).slice(0, 60); }
    }
    throw new Error(`获取 ${name} 元数据失败(全部镜像:${lastErr})`);
  };

  const closure = await resolveClosure({ name: '@hmharness/cli', spec: 'latest' }, getPackument);
  const root = closure.find((p) => p.name === '@hmharness/cli');
  host.log(`closure: ${closure.length} packages (root @hmharness/cli@${root?.version ?? '?'})`);
  host.sendProgress({ phase: 'meta', text: `依赖清单就绪:${closure.length} 个包(@hmharness/cli@${root?.version ?? '?'})` });

  const staging = join(target, '.staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  for (let i = 0; i < closure.length; i++) {
    const pkg = closure[i]!;
    const urls = tarballMirrors(pkg.tarball, mirrors);
    let buf: Buffer | null = null;
    let usedMirror = '';
    let lastErr = '';
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(300_000) });
        if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
        const total = Number(r.headers.get('content-length') ?? '0');
        const reader = r.body?.getReader();
        if (reader === undefined) throw new Error('no body');
        const chunks: Buffer[] = [];
        let got = 0;
        let lastEmit = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done === true) break;
          const b = Buffer.from(value);
          chunks.push(b);
          got += b.length;
          if (got - lastEmit > 256 * 1024) {
            lastEmit = got;
            host.sendProgress({
              phase: 'download',
              pct: Math.round(((i + Math.min(got / (total || got), 1)) / closure.length) * 100),
              text: `下载 ${pkg.name}@${pkg.version}(${i + 1}/${closure.length})· ${bytesLabel(got)}${total > 0 ? ` / ${bytesLabel(total)}` : ''}`,
              mirror: new URL(u).host,
            });
          }
        }
        buf = Buffer.concat(chunks);
        if (!integrityOk(buf, pkg.integrity)) { lastErr = 'integrity 不匹配'; buf = null; continue; }
        usedMirror = new URL(u).host;
        break;
      } catch (err) {
        lastErr = String(err).slice(0, 60);
      }
    }
    if (buf === null) throw new Error(`下载 ${pkg.name} 失败(全部镜像:${lastErr})`);
    const tgz = join(staging, `${i}.tgz`);
    writeFileSync(tgz, buf);
    host.sendProgress({
      phase: 'download',
      pct: Math.round(((i + 1) / closure.length) * 100),
      text: `下载 ${pkg.name}@${pkg.version} 完成(${bytesLabel(buf.length)},via ${usedMirror})`,
      mirror: usedMirror,
    });
  }

  host.sendProgress({ phase: 'extract', text: '解压并布局 node_modules…' });
  for (let i = 0; i < closure.length; i++) {
    const pkg = closure[i]!;
    await extractTgz(join(staging, `${i}.tgz`), staging, pkg);
    host.sendProgress({ phase: 'extract', pct: Math.round(((i + 1) / closure.length) * 100), text: `解压 ${pkg.name}(${i + 1}/${closure.length})` });
  }
  rmSync(staging, { recursive: true, force: true });

  const entry = resolveInstalledEntry(target);
  if (entry === '') throw new Error('tgz 安装完成但未找到 desktop-host 入口');
  writeStamp(target, 'tgz');
  finishInstall(host, entry, 'tgz');
}

/** tar.exe(Win10+ 自带)解压 tgz 到 exDir,再把 package/ 挪到 node_modules 布局。 */
async function extractTgz(tgz: string, staging: string, pkg: ResolvedPkg): Promise<void> {
  const exDir = join(staging, `x-${pkg.name.replace(/[^\w.-]/g, '_')}`);
  rmSync(exDir, { recursive: true, force: true });
  mkdirSync(exDir, { recursive: true });
  const code = await new Promise<number>((resolve, reject) => {
    const c = spawn('tar', ['-xzf', tgz, '-C', exDir], { windowsHide: true, stdio: 'ignore' });
    c.on('error', reject);
    c.on('exit', (x) => resolve(x ?? 1));
  });
  if (code !== 0) throw new Error(`tar 解压 ${pkg.name} 失败(退出码 ${code})`);
  const dest = moduleDir(installTarget(), pkg.name);
  const parent = dest.slice(0, dest.lastIndexOf('\\'));
  mkdirSync(parent, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(join(exDir, 'package'), dest);
  rmSync(exDir, { recursive: true, force: true });
}

/** 安装戳(向导完成页/设置面板展示安装方式与时间;不承载运行时逻辑)。 */
function writeStamp(target: string, via: 'npm' | 'tgz'): void {
  try {
    writeFileSync(join(target, 'installed-by-hmh-desktop.json'), JSON.stringify({ via, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function finishInstall(host: InstallerHost, entry: string, via: 'npm' | 'tgz'): void {
  host.log(`install done via ${via}: ${entry}`);
  host.sendProgress({ phase: 'done', text: `安装完成(${via})`, entry });
  host.onInstalled(entry, via);
  running = false;
}

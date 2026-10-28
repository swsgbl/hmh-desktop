/**
 * 桌面发布产物(resources/)声明版本与实际内容一致性核查(任务 E,2026-10-27;
 * v0.2.7 起指纹档位=0.23.45:结构化输出双修+server close 句柄排干)。
 *
 *   node scripts/audit-bundled-runtime.mjs --setup <Setup.exe> [--ver 0.2.7]
 *
 * 静态解包(7z,不运行安装器——实装验收属 NOT RUN 边界,由用户在干净 VM 做):
 *   NSIS Setup → app-64.7z → resources/{package.json,runtime/}
 * 核对:
 *   C1 resources/package.json 声明版本(=bundle-runtime.mjs 写入的 harnessVersion)
 *   C2 内容指纹:声明 0.23.45 ⇒ runtime.cjs 必含 0.23.40 已有特征(挂死根修
 *      abortIntent)、0.23.41+ 特征(kernel loadConfig 派生顶层 provider)与
 *      0.23.45 特征(server close 句柄排干 regTimer),必不含 main 未发版特征
 *      (evolution-daemon 30min)——声明与实际内容互相印证。
 *   C3 与本仓库 apps/desktop/resources(打包链本机产物)byte 级 SHA256 对照。
 * 输出 evidence/artifacts/bundled-runtime-audit-<deskver>.json。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEVEN_ZIP = join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const setup = flag('setup');
const deskVer = flag('ver', '0.2.7');
const declaredRuntime = flag('expect-runtime', '0.23.45');
if (!setup || !existsSync(setup)) {
  console.error('usage: node scripts/audit-bundled-runtime.mjs --setup <path-to-Setup.exe> [--ver 0.2.7] [--expect-runtime 0.23.45]');
  process.exit(2);
}
const outPath = resolve(root, flag('out', join('evidence', 'artifacts', `bundled-runtime-audit-${deskVer}.json`)));

function sh(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').slice(-1500)}`);
  return r.stdout;
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---- 内容指纹(特征串与断言语义见文件头;来源:hmharness git v0.23.40/v0.23.41/v0.23.45 源码) ----
const FINGERPRINTS = [
  { id: 'FP-stuck-fix-0.23.40', needle: 'abortIntent', expect: true,
    meaning: '执行器挂死根修(web interrupt kill 兜底/abortIntent 锁存,0.23.40 已含)' },
  { id: 'FP-evolve401-0.23.41+', needle: 'merged.provider = { ...routed }', expect: true,
    meaning: '/evolve /bench 401 根修(kernel loadConfig 派生顶层 provider,5515994=0.23.41 起,0.23.45 必含)' },
  { id: 'FP-close-drain-0.23.45', needle: 'regTimer', expect: true,
    meaning: 'server close() 句柄全排干(cb87fd1=v0.23.45;lifecycle registry 的 regTimer 标识符经 esbuild 保留)' },
  { id: 'FP-evo30min-main', needle: 'exceed the old 10min cap', expect: false,
    meaning: 'evolution-daemon 30min(652f543,未发版;且该文件不在桌面打包链,双重不可能)' },
];

// ---- 1. NSIS 解包 ----
const work = join(tmpdir(), `hmh-bundled-audit-${Date.now()}`);
mkdirSync(work, { recursive: true });
const nsisDir = join(work, 'nsis');
const appDir = join(work, 'app');
try {
  sh(SEVEN_ZIP, ['x', '-y', `-o${nsisDir}`, setup]);
  // electron-builder NSIS 的 payload 在 $PLUGINSDIR 下
  const payload = [join(nsisDir, '$PLUGINSDIR', 'app-64.7z'), join(nsisDir, 'app-64.7z')]
    .find(existsSync) ?? join(nsisDir, '$PLUGINSDIR', 'app-64.7z');
  sh(SEVEN_ZIP, ['x', '-y', `-o${appDir}`, payload]);

  // ---- 2. 定位 resources ----
  const resDir = join(appDir, 'resources');
  if (!existsSync(resDir)) throw new Error(`resources/ not found after extracting ${relative(work, payload)}`);
  const resPkgPath = join(resDir, 'package.json');
  const runtimeCjs = join(resDir, 'runtime', 'runtime.cjs');
  const taskRunner = join(resDir, 'runtime', 'task-runner.js');
  const resPkg = JSON.parse(readFileSync(resPkgPath, 'utf8'));
  const runtimeText = readFileSync(runtimeCjs, 'utf8');

  // ---- 3. 核对 ----
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  add('C1-declared-version', resPkg.version === declaredRuntime,
    `resources/package.json ${resPkg.name}@${resPkg.version} (expect @hmharness/web@${declaredRuntime})`);
  for (const fp of FINGERPRINTS) {
    const found = runtimeText.includes(fp.needle);
    add(fp.id, found === fp.expect,
      `${found ? 'contains' : 'lacks'} "${fp.needle}" (${fp.expect ? 'required' : 'must be absent'}) — ${fp.meaning}`);
  }

  // ---- 4. 与本仓库打包残留对照(主 checkout 与 worktree 均解析到自身) ----
  const localRes = join(root, 'apps', 'desktop', 'resources');
  const files = {};
  for (const [label, p] of [['runtime.cjs', runtimeCjs], ['task-runner.js', taskRunner], ['package.json', resPkgPath]]) {
    files[label] = { sha256: sha256(p), bytes: readFileSync(p).length };
  }
  let localMatch;
  if (existsSync(localRes)) {
    localMatch = {};
    for (const label of Object.keys(files)) {
      const lp = join(localRes, label === 'package.json' ? 'package.json' : join('runtime', label));
      localMatch[label] = existsSync(lp) && sha256(lp) === files[label].sha256;
    }
  }

  const report = {
    schema: 'hmh-desktop/bundled-runtime-audit@1',
    generatedAtUtc: new Date().toISOString(),
    release: { tag: `v${deskVer}`, setup: { path: setup, bytes: readFileSync(setup).length, sha256: sha256(setup) } },
    declared: resPkg,
    files, localResidueMatch: localMatch ?? '(local residue not present)',
    result: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    checks,
    note: 'static extraction only (7z, installer never executed) — in-VM install/upgrade acceptance stays NOT RUN',
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[bundled-audit] declared ${resPkg.name}@${resPkg.version} — ${report.result}`);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  console.log(`  local residue match: ${JSON.stringify(localMatch ?? null)}`);
  console.log(`[bundled-audit] json -> ${relative(root, outPath)}`);
  process.exitCode = report.result === 'PASS' ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

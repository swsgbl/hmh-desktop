/**
 * npm 发布工件 clean-room 验证(任务 E,2026-10-27)——升级/发版前置门。
 *
 *   node scripts/verify-artifacts.mjs <version> [--registry <url>] [--out <file>] [--keep-tmp]
 *
 * 对给定版本:从 registry 在线下载 exact tarball(npm pack + 独立临时 cache,
 * 不碰本机 ~/.npm;--prefer-online 绕过任何缓存),解包逐包断言:
 *   1) 16 包集合闭合(cli + 其全部 @hmharness/* 依赖)
 *   2) 每包 version === 目标;每个 @hmharness/* 依赖钉 exact === 目标(抓 0.23.40/0.23.41 钉版事故)
 *   3) dist/ 存在且入口文件在 tarball 内
 *   4) bin/入口文件 node --check 语法通过
 *   5) tarball sha512 === registry dist.integrity;SHA256 记入 manifest
 * 输出机器可读 manifest(默认 evidence/artifacts/artifact-manifest-<ver>.json)。
 * PASS exit 0,FAIL exit 1(0.23.40 预期 FAIL——事故版本必须被抓住)。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageRecord, checkSetClosure, HMH_SCOPE, hmharnessDeps, summarize, tarBinary } from './lib/artifact-verify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

// ---- 参数 ----
const argv = process.argv.slice(2);
const version = argv.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const registry = flag('registry') ?? DEFAULT_REGISTRY;
const keepTmp = argv.includes('--keep-tmp');
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: node scripts/verify-artifacts.mjs <version> [--registry <url>] [--out <file>] [--keep-tmp]');
  process.exit(2);
}
const cliName = `${HMH_SCOPE}/cli`;
// @hmharness scope 已知全集(16 包):cli 闭包 15(cli + 14 first-party deps,
// 即板上 FALLBACK_PINS floor 集)+ codexhost-bridge(独立旁挂,不进 cli 依赖树,
// 2026-10-27 registry 实证 latest=0.23.42)。任务口径:16 包版本一致。
const KNOWN_SCOPE_PACKAGES = [
  'agent', 'browser', 'cli', 'codexhost-bridge', 'cognitive', 'domain-harmony',
  'domain-ops', 'environments', 'evaluation', 'evolution', 'extension',
  'kernel', 'lsp', 'observability', 'sandbox', 'web',
].map((n) => `${HMH_SCOPE}/${n}`);
const outPath = resolve(root, flag('out') ?? join('evidence', 'artifacts', `artifact-manifest-${version}.json`));

// ---- 工具:统一走 npm 子进程(代理/重试由 npm 处理),cache 钉在临时目录 ----
function npm(args, cwd) {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  }
  return r.stdout;
}
function npmJson(spec) {
  const raw = npm(['view', spec, '--json', '--registry', registry, '--cache', tmpRoot, '--no-audit', '--no-fund']);
  const parsed = JSON.parse(raw);
  // npm 11 的 --json 把结果包成数组(dist-tags 是单对象数组;完整 manifest 同样)
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
}
function tarballSha512s(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'hmh-artifact-verify-'));
const tryFinally = async (fn) => { try { return await fn(); } finally { if (!keepTmp) rmSync(tmpRoot, { recursive: true, force: true }); } };

await tryFinally(async () => {
  const startedAt = new Date();
  console.log(`[verify-artifacts] target=${cliName}@${version} registry=${registry} tmp=${tmpRoot}`);

  // ---- 1. registry 元数据层:cli 的版本与一方依赖集合(闭包判定的真源) ----
  const cliMeta = npmJson(`${cliName}@${version}`);
  const metaDeps = hmharnessDeps({ dependencies: cliMeta.dependencies });
  // 验证集合 = cli 闭包 ∪ scope 已知全集(16);闭包内出现 KNOWN 之外的 @hmharness/*
  // 新包时自动并入(集合并集),scope 收缩(KNOWN 名下架)则由 G1 汇报 extra/missing。
  const packageSet = [...new Set([cliName, ...Object.keys(metaDeps), ...KNOWN_SCOPE_PACKAGES])];
  console.log(`[verify-artifacts] cli metadata deps: ${Object.keys(metaDeps).length} first-party -> verifying ${packageSet.length} packages`);
  const metaChecks = Object.entries(metaDeps).map(([dep, spec]) => ({
    id: `M0-meta-pin:${dep}`, ok: spec === version, detail: `registry metadata ${dep}="${spec}" vs ${version}`,
  }));

  // ---- 2. 逐包:下载 exact tarball -> integrity -> 解包 -> 断言 ----
  const records = [];
  const perPackage = [];
  for (const name of packageSet) {
    const meta = npmJson(`${name}@${version}`);
    const integrity = meta?.dist?.integrity ?? null;

    // npm pack:exact 版本下载,stdout 最后一行 .tgz 是生成的文件名;独立 cache + prefer-online
    const packOut = npm(['pack', `${name}@${version}`, '--pack-destination', tmpRoot,
      '--registry', registry, '--cache', tmpRoot, '--prefer-online', '--no-audit', '--no-fund']);
    const tgzName = packOut.trim().split(/\r?\n/).filter((l) => l.endsWith('.tgz')).at(-1);
    const tgz = isAbsolute(tgzName) ? tgzName : join(tmpRoot, tgzName);
    const tgzBuf = readFileSync(tgz);
    const sha256 = createHash('sha256').update(tgzBuf).digest('hex');
    const integrityOk = integrity ? tarballSha512s(tgzBuf) === integrity : null;

    // 解包(tarball 根固定 package/,剥前缀由断言层处理)
    const exDir = join(tmpRoot, 'extract', name.replace('/', '__'));
    mkdirSync(exDir, { recursive: true });
    const tarR = spawnSync(tarBinary(), ['-xzf', tgz, '-C', exDir], { encoding: 'utf8' });
    if (tarR.status !== 0) throw new Error(`tar extract failed for ${name}: ${tarR.stderr}`);
    const pkgDir = join(exDir, 'package');
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const files = listFiles(pkgDir).map((f) => relative(pkgDir, f).replace(/\\/g, '/'));

    // node --check:bin 与入口(ESM/CJS 按 package.json type 由 node 自判,Node>=22 实测通过)
    const binSyntax = [];
    const binVals = typeof pkgJson.bin === 'string' ? [pkgJson.bin]
      : pkgJson.bin ? Object.values(pkgJson.bin).map(String) : [];
    for (const b of [...new Set(binVals)]) binSyntax.push(syntaxCheck(join(pkgDir, b)));
    const dot = pkgJson.exports?.['.'];
    const entry = typeof dot === 'string' ? dot : (dot?.default ?? pkgJson.main ?? null);
    const entrySyntax = entry ? syntaxCheck(join(pkgDir, entry)) : null;

    const result = checkPackageRecord({
      name, target: version, pkgJson, files, binSyntax,
      entrySyntax: entrySyntax?.file === entry ? entrySyntax : null,
      sha256, integrityOk,
    });
    perPackage.push(result);
    records.push({
      name,
      version: pkgJson.version,
      registryIntegrity: integrity,
      tarballUrl: meta?.dist?.tarball ?? `${registry}/${name}/-/${basename(String(meta?.dist?.tarball ?? ''))}`,
      tarballSha256: sha256,
      tarballIntegrityOk: integrityOk,
      hmharnessDeps: hmharnessDeps(pkgJson),
      entry, bins: [...new Set(binVals)],
      distFileCount: files.filter((f) => f.startsWith('dist/') && !f.endsWith('/')).length,
      boardFiles: files.filter((f) => f.startsWith('board/')).map((f) => f),
      result: result.ok ? 'PASS' : 'FAIL',
      checks: result.checks,
    });
    console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${name}@${pkgJson.version} (${records.at(-1).distFileCount} dist files, sha256=${sha256.slice(0, 12)}…)`);
  }

  // ---- 3. 全局闭包 + 汇总 ----
  const closure = checkSetClosure(new Set(packageSet), { name: cliName, dependencies: cliMeta.dependencies }, KNOWN_SCOPE_PACKAGES);
  const summary = summarize(perPackage, [...metaChecks, ...closure.checks]);

  const manifest = {
    schema: 'hmh-desktop/artifact-manifest@1',
    generatedAtUtc: startedAt.toISOString(),
    target: { package: cliName, version, registry },
    tool: 'scripts/verify-artifacts.mjs',
    totals: { packages: packageSet.length, checks: perPackage.reduce((n, p) => n + p.checks.length, 0) + metaChecks.length + closure.checks.length },
    registryMetadataChecks: metaChecks,
    closureCheck: closure.checks[0],
    ...summary,
    packages: records,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[verify-artifacts] ${summary.result} (${summary.failureCount} failures) -> ${relative(root, outPath)}`);
  for (const f of summary.failures) console.log(`  FAIL ${f}`);
  process.exitCode = summary.result === 'PASS' ? 0 : 1;
});

// ---- helpers ----
function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function syntaxCheck(file) {
  const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  return { file, ok: r.status === 0, error: r.status === 0 ? undefined : (r.stderr || '').split(/\r?\n/).find((l) => l.includes('Error')) ?? 'syntax check failed' };
}

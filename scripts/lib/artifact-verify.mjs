/**
 * npm 发布工件断言核心(纯逻辑,零 IO)——scripts/verify-artifacts.mjs 的可测内核。
 *
 * 背景:0.23.40/0.23.41 是钉版事故版本(cli@0.23.40 携 kernel@0.23.39 等旧件,
 * 44 根跨包依赖钉不同步),0.23.42 起修复。本模块对"已下载解包的包记录"逐项断言,
 * 让 0.23.40 必然被抓,而不依赖运气。
 *
 * 记录(rec)由外层 IO 构造:tarball 解包读 package.json、列文件、跑 node --check;
 * fixture 测试注入假记录/假 tarball 即可全链验证断言行为,不碰网络。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const HMH_SCOPE = '@hmharness';

/**
 * 选 tar 二进制:Windows 优先 System32 原生 bsdtar(libarchive 内置 gzip,
 * 无子进程;Git 的 GNU tar 脱离 MSYS 环境 spawn gzip 会挂 status 128)。
 */
export function tarBinary() {
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const win = join(process.env.SystemRoot, 'System32', 'tar.exe');
    if (existsSync(win)) return win;
  }
  return 'tar';
}

/** 从 package.json 提取 @hmharness/* 一方包依赖钉(name -> version spec)。 */
export function hmharnessDeps(pkgJson) {
  const out = {};
  for (const [name, spec] of Object.entries(pkgJson?.dependencies ?? {})) {
    if (name.startsWith(HMH_SCOPE + '/')) out[name] = String(spec);
  }
  return out;
}

/** npm pack 的 tarball 根目录固定为 package/,解包后统一剥掉该前缀。 */
export function stripPackageRoot(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const stripped = norm === 'package' || norm.startsWith('package/')
    ? norm.slice('package/'.length)
    : norm;
  // exports/main/bin 字段惯例带 ./ 前缀("./dist/main.js"),文件清单是裸相对路径
  return stripped.startsWith('./') ? stripped.slice(2) : stripped;
}

/**
 * 解析一个包的入口与 bin 清单(供存在性/语法检查)。
 * bin: string | {name: file}; 入口优先级 exports['.'] > main。
 */
export function entryAndBins(pkgJson) {
  const bins = [];
  if (typeof pkgJson?.bin === 'string') bins.push(pkgJson.bin);
  else if (pkgJson?.bin && typeof pkgJson.bin === 'object') {
    for (const f of Object.values(pkgJson.bin)) bins.push(String(f));
  }
  const dot = pkgJson?.exports?.['.'];
  const entry = typeof dot === 'string' ? dot : (dot?.default ?? pkgJson?.main ?? null);
  return { entry, bins: [...new Set(bins)] };
}

/**
 * 单包断言。返回 {name, ok, checks:[{id, ok, detail}]}。
 *
 * rec: {
 *   name,            包名,如 '@hmharness/cli'
 *   target,          目标版本字符串
 *   pkgJson,         解包出的 package.json 对象
 *   files,           解包目录相对路径数组(已剥 package/ 前缀)
 *   binSyntax,       [{file, ok, error?}] 外层对每个 bin 跑 node --check 的结果
 *   entrySyntax,     {file, ok, error?} | null  入口文件语法检查结果(可省)
 *   sha256,          tarball SHA256 hex(记录用,不判定)
 *   integrityOk,     boolean | null  tarball sha512 与 registry dist.integrity 比对
 * }
 */
export function checkPackageRecord(rec) {
  const { name, target, pkgJson, files } = rec;
  const fileSet = new Set((files ?? []).map(stripPackageRoot));
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  // V1 自身版本:tarball 里 package.json 的 version 必须 === 目标
  const selfVer = pkgJson?.version ?? '(missing)';
  add('V1-self-version', selfVer === target, `package.json version=${selfVer}, target=${target}`);

  // V2 一方包依赖钉:每个 @hmharness/* 依赖必须 exact 钉 = 目标版本
  for (const [dep, spec] of Object.entries(hmharnessDeps(pkgJson))) {
    add(`V2-pin:${dep}`, spec === target,
      `dependency ${dep}="${spec}"${spec === target ? '' : ` (expected exact ${target})`}`);
  }

  // V3 载荷非空 + 声明的 files 条目存在(workspace 包 files:["dist"];codexhost-bridge
  // 是 bin-only 形态:files:["bin"] 且无 dist/main/exports——按声明核对,不做 dist 死板要求)
  const payload = [...fileSet].filter((f) => f !== 'package.json');
  add('V3-payload-nonempty', payload.length > 0, `${payload.length} payload files`);
  for (const decl of pkgJson?.files ?? []) {
    const n = stripPackageRoot(String(decl));
    const hit = fileSet.has(n) || [...fileSet].some((f) => f.startsWith(`${n}/`));
    add(`V3-declared-files:${decl}`, hit, hit ? '' : `declared files entry "${decl}" absent from tarball`);
  }

  // V4 入口文件存在(exports['.'] > main;字段惯例带 ./ 前缀,统一归一化后比对;
  // bin-only 包(codexhost-bridge)不声明入口 → 有 bin 时豁免;入口与 bin 全无 = 空壳包必须 FAIL)
  const { entry, bins } = entryAndBins(pkgJson);
  if (entry === null) {
    const binOnly = bins.length > 0;
    add('V4-entry-exists', binOnly,
      binOnly ? 'no exports["."]/main declared (bin-only package; bin 已在 V5 核对)' : 'no exports["."]/main and no bin declared — empty-shell package');
  } else add('V4-entry-exists', fileSet.has(stripPackageRoot(entry)),
    fileSet.has(stripPackageRoot(entry)) ? `entry ${entry} present` : `entry ${entry} missing from tarball`);

  // V5 bin 存在 + node --check 语法通过(任务书:CLI 入口可 node --check)
  for (const b of bins) {
    const nb = stripPackageRoot(b);
    add(`V5-bin-exists:${b}`, fileSet.has(nb), fileSet.has(nb) ? '' : `bin ${b} missing from tarball`);
  }
  for (const r of rec.binSyntax ?? []) {
    add(`V5-bin-syntax:${r.file}`, r.ok, r.ok ? '' : `node --check failed: ${r.error ?? 'syntax error'}`);
  }
  if (rec.entrySyntax && !rec.entrySyntax.ok && rec.entrySyntax.file === entry) {
    add(`V5-entry-syntax:${entry}`, false, `node --check failed: ${rec.entrySyntax.error ?? 'syntax error'}`);
  }

  // V6 tarball 完整性:sha512 与 registry dist.integrity 比对(null = 未提供,跳过)
  if (rec.integrityOk !== null && rec.integrityOk !== undefined) {
    add('V6-tarball-integrity', rec.integrityOk,
      rec.integrityOk ? 'sha512 matches registry dist.integrity' : 'sha512 MISMATCH vs registry dist.integrity');
  }

  return { name, ok: checks.every((c) => c.ok), checks };
}

/**
 * 全局断言:期望包集合必须全部被验证覆盖(覆盖语义:missing=FAIL;
 * extra 记录在 detail 供人工研判——scope 出现新包/闭包并集会合法产生 extra)。
 * expectedNames: 期望包名清单(cli 闭包或 scope 全集);setNames: 实际验证的集合。
 */
export function checkCoverage(expectedNames, setNames, id) {
  const expected = [...new Set(expectedNames)];
  const missing = expected.filter((n) => !setNames.has(n));
  const extra = [...setNames].filter((n) => !expected.includes(n));
  return {
    id,
    ok: missing.length === 0,
    detail: `expected ${expected.length}, verified ${setNames.size}` +
      (missing.length ? `; missing: ${missing.join(', ')}` : '') +
      (extra.length ? `; note: extra verified (not in this expected set): ${extra.join(', ')}` : ''),
  };
}

/**
 * 全局断言:cli 依赖闭包与 scope 全集两层覆盖(16 包口径)。
 * setNames: 实际下载验证的包名集合; rootPkgJson: cli 元数据; scopeAll: scope 已知全集。
 */
export function checkSetClosure(setNames, rootPkgJson, scopeAll) {
  const closure = [rootPkgJson?.name ?? `${HMH_SCOPE}/cli`, ...Object.keys(hmharnessDeps(rootPkgJson))];
  const checks = [checkCoverage(closure, setNames, 'G1-cli-closure')];
  if (scopeAll) checks.push(checkCoverage(scopeAll, setNames, 'G2-scope-coverage'));
  return { ok: checks.every((c) => c.ok), checks };
}

/** 汇总:任何一项 FAIL 则整体 FAIL。返回 manifest 的 result/failures 段。 */
export function summarize(perPackage, globals) {
  const failures = [];
  for (const p of perPackage) {
    for (const c of p.checks) if (!c.ok) failures.push(`${p.name}: ${c.id} — ${c.detail}`);
  }
  for (const c of globals) if (!c.ok) failures.push(`(global): ${c.id} — ${c.detail}`);
  return { result: failures.length === 0 ? 'PASS' : 'FAIL', failureCount: failures.length, failures };
}

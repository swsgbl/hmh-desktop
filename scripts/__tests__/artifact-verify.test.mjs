/**
 * verify-artifacts 断言逻辑单测——本地 fixture(假 tarball),零网络依赖。
 *
 * 关键用例:钉版事故复现——cli 钉 kernel=旧版(0.23.40 出厂形态)必须被抓(V2)。
 * fixture 用系统 tar 造与 npm pack 同构的 tgz(根目录 package/),走完整
 * "下载(读文件)→解包→断言"链路,只是网络层换成读本地 fixture。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkPackageRecord, checkSetClosure, entryAndBins, hmharnessDeps, stripPackageRoot, summarize, tarBinary,
} from '../lib/artifact-verify.mjs';

const TARGET = '9.9.9';

/** 造一个与 npm tarball 同构的包 fixture:root/package/{package.json,dist/main.js,...} → tar → 解包 → 记录。 */
function buildFixturePackage(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hmh-av-fx-'));
  const pkgDir = join(dir, 'package');
  mkdirSync(pkgDir, { recursive: true });
  const {
    name = '@hmharness/kernel', version = TARGET, deps = {}, bins = null,
    distFiles = ['dist/main.js'], badSyntax = false, omitEntry = false, filesExtra = [],
  } = overrides;
  const pkgJson = {
    name, version, type: 'module',
    main: 'dist/main.js',
    dependencies: deps,
    ...(bins ? { bin: bins } : {}),
  };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson));
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  const syntax = badSyntax ? 'import { join } from "node:path"; const broken = (' : 'import { join } from "node:path";\nexport const x = join("a", "b");\n';
  const put = (f) => { mkdirSync(dirname(join(pkgDir, f)), { recursive: true }); writeFileSync(join(pkgDir, f), syntax); };
  for (const f of distFiles) put(f);
  if (omitEntry) rmSync(join(pkgDir, 'dist/main.js'), { force: true });
  for (const f of filesExtra) put(f);

  // tar 打包(与 npm pack 同构:根 = package/)再解包,走真实解包路径
  const tgz = join(dir, 'fixture.tgz');
  const t = spawnSync(tarBinary(), ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' });
  assert.equal(t.status, 0, `tar fixture pack failed: ${t.stderr}`);
  const exDir = join(dir, 'extract');
  mkdirSync(exDir, { recursive: true });
  const x = spawnSync(tarBinary(), ['-xzf', tgz, '-C', exDir], { encoding: 'utf8' });
  assert.equal(x.status, 0, `tar fixture extract failed: ${x.stderr}`);

  const extracted = join(exDir, 'package');
  const files = listFiles(extracted).map((f) => f.slice(extracted.length + 1).replace(/\\/g, '/'));
  const extractedPkgJson = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'));
  const tgzBuf = readFileSync(tgz);
  const sha512 = `sha512-${createHash('sha512').update(tgzBuf).digest('base64')}`;
  return { dir, extracted, pkgJson: extractedPkgJson, files, sha512 };
}

/** 把 fixture 变成 verify-artifacts 的包记录(等价于脚本网络+解包层产出的 rec)。 */
function recordFromFixture(fx, opts = {}) {
  const { entry, bins } = entryAndBins(fx.pkgJson);
  const binSyntax = bins.map((b) => syntaxCheck(join(fx.extracted, b)));
  const entrySyntax = entry ? syntaxCheck(join(fx.extracted, entry)) : null;
  return {
    name: fx.pkgJson.name, target: opts.target ?? TARGET, pkgJson: fx.pkgJson,
    files: fx.files, binSyntax,
    entrySyntax: entrySyntax?.file === entry ? entrySyntax : null,
    sha256: 'fixture', integrityOk: opts.integrityOk ?? (fx.sha512 === opts.integrity ? true : null),
  };
}

function listFiles(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}
function syntaxCheck(file) {
  const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  return { file, ok: r.status === 0, error: r.status === 0 ? undefined : 'syntax check failed' };
}

// ---- 纯函数 ----
test('hmharnessDeps 只取 @hmharness/* 一方包依赖', () => {
  const deps = hmharnessDeps({ dependencies: { qrcode: '^1.5.4', '@hmharness/kernel': '0.23.42', lodash: '4.0.0' } });
  assert.deepEqual(deps, { '@hmharness/kernel': '0.23.42' });
});

test('stripPackageRoot 剥 npm tarball 的 package/ 前缀(容忍反斜杠)', () => {
  assert.equal(stripPackageRoot('package/dist/main.js'), 'dist/main.js');
  assert.equal(stripPackageRoot('package\\dist\\main.js'), 'dist/main.js');
  assert.equal(stripPackageRoot('package'), '');
  assert.equal(stripPackageRoot('dist/main.js'), 'dist/main.js');
});

test('entryAndBins 处理 string/object bin 与 exports', () => {
  assert.deepEqual(entryAndBins({ bin: 'dist/cli.js', main: 'dist/main.js' }), { entry: 'dist/main.js', bins: ['dist/cli.js'] });
  assert.deepEqual(entryAndBins({ bin: { hmh: 'dist/main.js', hmh2: 'dist/main.js' } }), { entry: null, bins: ['dist/main.js'] });
  assert.deepEqual(entryAndBins({ exports: { '.': { default: 'dist/index.js' } } }), { entry: 'dist/index.js', bins: [] });
});

// ---- 全链 fixture:干净集合 PASS ----
test('干净 fixture 包:全部断言通过(全链:造 tarball→解包→断言)', () => {
  const fx = buildFixturePackage({ name: '@hmharness/kernel', deps: {} });
  const r = checkPackageRecord(recordFromFixture(fx, { integrity: fx.sha512 }));
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(r.checks.some((c) => c.id === 'V1-self-version' && c.ok));
  assert.ok(r.checks.some((c) => c.id === 'V3-payload-nonempty' && c.ok));
  assert.ok(r.checks.some((c) => c.id === 'V4-entry-exists' && c.ok));
});

// ---- 钉版事故复现(核心):cli 钉 kernel=旧版必须被抓 ----
test('钉版事故形态(cli 钉 kernel=TARGET-1,即 0.23.40 出厂形态)必须 FAIL', () => {
  const fx = buildFixturePackage({
    name: '@hmharness/cli',
    deps: { '@hmharness/kernel': '9.9.8', '@hmharness/web': '9.9.9' }, // kernel 钉旧 = 事故
  });
  const r = checkPackageRecord(recordFromFixture(fx));
  assert.equal(r.ok, false);
  const pinFail = r.checks.find((c) => c.id === 'V2-pin:@hmharness/kernel');
  assert.ok(pinFail && !pinFail.ok, 'V2 must catch the stale kernel pin');
  assert.match(pinFail.detail, /9\.9\.8/);
  assert.ok(r.checks.find((c) => c.id === 'V2-pin:@hmharness/web')?.ok, 'correct pin passes');
});

test('包自身 version 与目标不符必须 FAIL(V1)', () => {
  const fx = buildFixturePackage({ version: '9.9.8' });
  const r = checkPackageRecord(recordFromFixture(fx));
  assert.ok(!r.checks.find((c) => c.id === 'V1-self-version').ok);
});

test('声明的 dist 目录在 tarball 缺失必须 FAIL(V3-declared-files + V4)', () => {
  const fx = buildFixturePackage({ distFiles: ['README.md' /* dist 无文件 */] });
  const pkgJson = { ...fx.pkgJson, files: ['dist'] }; // 声明 dist 但 tarball 内为空
  const r = checkPackageRecord({ ...recordFromFixture(fx), pkgJson });
  assert.ok(!r.checks.find((c) => c.id === 'V3-declared-files:dist')?.ok);
  // main 指向 dist/main.js 不存在 → V4 同时抓
  assert.ok(!r.checks.find((c) => c.id === 'V4-entry-exists').ok);
});

test('bin 语法错误必须 FAIL(V5,node --check 真跑)', () => {
  const fx = buildFixturePackage({ name: '@hmharness/cli', bins: { hmh: 'dist/main.js' }, badSyntax: true });
  const r = checkPackageRecord(recordFromFixture(fx));
  assert.ok(!r.ok);
  assert.ok(r.checks.some((c) => c.id.startsWith('V5-bin-syntax') && !c.ok));
});

test('tarball sha512 与 registry integrity 不符必须 FAIL(V6)', () => {
  const fx = buildFixturePackage({});
  const r = checkPackageRecord(recordFromFixture(fx, { integrityOk: false }));
  assert.ok(!r.checks.find((c) => c.id === 'V6-tarball-integrity').ok);
});

test('bin-only 包(codexhost-bridge 形态:无 main/exports,有 bin+files)全断言通过', () => {
  const fx = buildFixturePackage({
    name: '@hmharness/codexhost-bridge',
    distFiles: ['bin/hmh-codexhost.mjs'], filesExtra: ['README.md'],
    bins: { 'hmh-codexhost': 'bin/hmh-codexhost.mjs' },
  });
  const pkgJson = { ...fx.pkgJson, files: ['bin', 'README.md'] };
  delete pkgJson.main;
  const r = checkPackageRecord({ ...recordFromFixture(fx), pkgJson });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.match(r.checks.find((c) => c.id === 'V4-entry-exists').detail, /bin-only/);
  assert.ok(r.checks.find((c) => c.id === 'V3-declared-files:bin')?.ok);
  assert.ok(r.checks.find((c) => c.id.startsWith('V5-bin-exists'))?.ok);
});

test('空壳包(无 main/exports 且无 bin)必须 FAIL(V4)', () => {
  const fx = buildFixturePackage({});
  const pkgJson = { ...fx.pkgJson };
  delete pkgJson.main;
  const r = checkPackageRecord({ ...recordFromFixture(fx), pkgJson });
  assert.ok(!r.checks.find((c) => c.id === 'V4-entry-exists').ok);
});

test('declared files 条目在 tarball 缺失必须 FAIL(V3-declared-files)', () => {
  const fx = buildFixturePackage({});
  const pkgJson = { ...fx.pkgJson, files: ['dist', 'board'] }; // board 不存在
  const r = checkPackageRecord({ ...recordFromFixture(fx), pkgJson });
  assert.ok(!r.checks.find((c) => c.id === 'V3-declared-files:board')?.ok);
  assert.ok(r.checks.find((c) => c.id === 'V3-declared-files:dist')?.ok);
});

test('integrityOk=null(未提供)时跳过 V6 而非误报', () => {
  const fx = buildFixturePackage({});
  const r = checkPackageRecord(recordFromFixture(fx, { integrityOk: null }));
  assert.equal(r.checks.find((c) => c.id === 'V6-tarball-integrity'), undefined);
  assert.equal(r.ok, true);
});

// ---- 全局闭包与汇总 ----
test('checkSetClosure:集合缺包/多包都被抓', () => {
  const root = { name: '@hmharness/cli', dependencies: { '@hmharness/kernel': TARGET, '@hmharness/web': TARGET } };
  assert.equal(checkSetClosure(new Set(['@hmharness/cli', '@hmharness/kernel', '@hmharness/web']), root).ok, true);
  const missing = checkSetClosure(new Set(['@hmharness/cli', '@hmharness/kernel']), root);
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0].detail, /@hmharness\/web/);
});

test('summarize:任一失败 → FAIL + failures 明细', () => {
  const bad = checkPackageRecord(recordFromFixture(buildFixturePackage({ deps: { '@hmharness/kernel': '0.0.1' } })));
  const good = checkPackageRecord(recordFromFixture(buildFixturePackage({})));
  const s = summarize([good, bad], []);
  assert.equal(s.result, 'FAIL');
  assert.ok(s.failures.some((f) => f.includes('V2-pin')));
});

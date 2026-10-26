/**
 * cli-installer 核心纯逻辑单测:semver 范围匹配 / packument 选版 /
 * 依赖闭包解析(钻石去重、环安全、无匹配报错)/ 镜像地址派生 /
 * node_modules 布局 / integrity 校验。IO(fetch/解压)由主进程负责,不在此测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bytesLabel, cmpSemver, integrityOk, moduleDir, pickVersion, resolveClosure, satisfies, tarballMirrors, type Packument } from '../index.ts';

/* ---- 测试用 packument 构造器 ---- */
const doc = (versions: Record<string, { deps?: Record<string, string>; integrity?: string }>, latest?: string): Packument => ({
  'dist-tags': { latest: latest ?? Object.keys(versions).at(-1) ?? '' },
  versions: Object.fromEntries(
    Object.entries(versions).map(([v, m]) => [v, { dependencies: m.deps, dist: { tarball: `https://registry.npmjs.org/x/-/x-${v}.tgz`, integrity: m.integrity } }]),
  ),
});

test('cmpSemver:主/次/修订比较与 v 前缀', () => {
  assert.equal(cmpSemver('0.23.39', '0.23.38'), 1);
  assert.equal(cmpSemver('0.23.39', '0.24.0'), -1);
  assert.equal(cmpSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(cmpSemver('1.2.3-rc.1', '1.2.2'), 1);
});

test('satisfies:精确 / latest / * / ^ / ~ / >='  , () => {
  assert.ok(satisfies('1.5.4', '1.5.4'));
  assert.ok(satisfies('latest', '1.5.4'));
  assert.ok(satisfies('*', '0.0.1'));
  assert.ok(satisfies('^1.5.4', '1.9.0'));
  assert.ok(!satisfies('^1.5.4', '2.0.0'));
  assert.ok(!satisfies('^1.5.4', '1.5.3'));
  assert.ok(satisfies('^0.2.3', '0.2.9'));
  assert.ok(!satisfies('^0.2.3', '0.3.0'));
  assert.ok(satisfies('~15.3.1', '15.3.9'));
  assert.ok(!satisfies('~15.3.1', '15.4.0'));
  assert.ok(satisfies('>=4.2.0', '4.2.3'));
});

test('pickVersion:latest tag / 精确命中 / 范围取最大 / 无匹配空串', () => {
  const d = doc({ '1.5.0': {}, '1.5.4': {}, '1.6.0': {}, '2.0.0': {} }, '1.5.4');
  assert.equal(pickVersion(d, 'latest'), '1.5.4');
  assert.equal(pickVersion(d, '1.6.0'), '1.6.0');
  assert.equal(pickVersion(d, '^1.5.0'), '1.6.0');
  assert.equal(pickVersion(d, '^3.0.0'), '');
});

test('resolveClosure:传递依赖全解析 + 钻石依赖去重(按名一份)', async () => {
  const docs: Record<string, Packument> = {
    '@hmharness/cli': doc({ '0.23.39': { deps: { '@hmharness/web': '0.23.39', '@hmharness/kernel': '0.23.39', qrcode: '^1.5.4' } } }),
    '@hmharness/web': doc({ '0.23.39': { deps: { '@hmharness/kernel': '0.23.39', '@hmharness/agent': '0.23.39', qrcode: '^1.5.4' } } }),
    '@hmharness/agent': doc({ '0.23.39': { deps: { '@hmharness/kernel': '0.23.39' } } }),
    '@hmharness/kernel': doc({ '0.23.39': {} }),
    qrcode: doc({ '1.5.0': {}, '1.5.4': { deps: { pngjs: '^5.0.0' } } }),
    pngjs: doc({ '5.0.0': {}, '5.3.2': {} }),
  };
  const got = await resolveClosure({ name: '@hmharness/cli', spec: 'latest' }, (n) => Promise.resolve(docs[n]!));
  assert.deepEqual(
    got.map((p) => `${p.name}@${p.version}`).sort(),
    ['@hmharness/agent@0.23.39', '@hmharness/cli@0.23.39', '@hmharness/kernel@0.23.39', '@hmharness/web@0.23.39', 'pngjs@5.3.2', 'qrcode@1.5.4'],
  );
  // 钻石:web 与 cli 都要 qrcode/^1.5.4 —— 只解析一次,取同版
  assert.equal(got.filter((p) => p.name === 'qrcode').length, 1);
});

test('resolveClosure:依赖环安全(A→B→A)', async () => {
  const docs: Record<string, Packument> = {
    a: doc({ '1.0.0': { deps: { b: '^1.0.0' } } }),
    b: doc({ '1.0.0': { deps: { a: '^1.0.0' } } }),
  };
  const got = await resolveClosure({ name: 'a', spec: 'latest' }, (n) => Promise.resolve(docs[n]!));
  assert.equal(got.length, 2);
});

test('resolveClosure:无满足版本时抛错并带包名与范围', async () => {
  const docs: Record<string, Packument> = {
    a: doc({ '1.0.0': { deps: { b: '^9.0.0' } } }),
    b: doc({ '1.0.0': {} }),
  };
  await assert.rejects(
    () => resolveClosure({ name: 'a', spec: 'latest' }, (n) => Promise.resolve(docs[n]!)),
    /b.*\^9\.0\.0/,
  );
});

test('tarballMirrors:原始地址优先,镜像同路径改写 host,不重复', () => {
  const urls = tarballMirrors('https://registry.npmjs.org/@hmharness/cli/-/cli-0.23.39.tgz', [
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ]);
  assert.deepEqual(urls, [
    'https://registry.npmjs.org/@hmharness/cli/-/cli-0.23.39.tgz',
    'https://registry.npmmirror.com/@hmharness/cli/-/cli-0.23.39.tgz',
  ]);
});

test('moduleDir:scoped 与普通包的 node_modules 布局;非法名抛错', () => {
  assert.equal(moduleDir('C:\\Users\\u\\.hmharness-global', '@hmharness/cli'), 'C:\\Users\\u\\.hmharness-global\\node_modules\\@hmharness\\cli');
  assert.equal(moduleDir('C:\\p', 'qrcode'), 'C:\\p\\node_modules\\qrcode');
  assert.throws(() => moduleDir('C:\\p', '@bad'), /invalid package name/);
  assert.throws(() => moduleDir('C:\\p', 'a/b'), /invalid package name/);
});

test('integrityOk:sha512 匹配/不匹配/缺失放行/未知算法放行', () => {
  const data = Buffer.from('hmh');
  const good = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  assert.ok(integrityOk(data, good));
  assert.ok(!integrityOk(Buffer.from('x'), good));
  assert.ok(integrityOk(data));
  assert.ok(integrityOk(data, 'md5-AAAA'));
});

test('bytesLabel:KB/MB 档位', () => {
  assert.equal(bytesLabel(512), '512 B');
  assert.equal(bytesLabel(4096), '4 KB');
  assert.equal(bytesLabel(5 * 1024 * 1024), '5.0 MB');
});

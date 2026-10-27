/**
 * 桌面内置 runtime 打包链差异审计(任务 E,2026-10-27)。
 *
 *   node scripts/desktop-runtime-audit.mjs [--from v0.23.40] [--to main] [--json out.json]
 *
 * 机制:复刻 scripts/bundle-runtime.mjs 的 esbuild 配置(write:false)拿 metafile.inputs
 * ——即"桌面 runtime.cjs/task-runner.js 实际打进哪些 hmharness 源文件",再与
 * `git diff --name-only <from>..<to>` 的改动文件求交,输出「源码差异中影响桌面
 * 打包路径」的精确清单(逐文件 + 逐 commit 归属)。桌面内置 runtime 是 esbuild
 * 打平产物、零 npm 运行时依赖,因此只有源码文件级交集才构成"桌面受影响"。
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = process.env.HMHARNESS_ROOT ?? join(root, '..', 'hmharness');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const fromRef = flag('from', 'v0.23.40');
const toRef = flag('to', 'main');
const jsonOut = flag('json', join(root, 'evidence', 'artifacts', 'desktop-runtime-diff.json'));

// ---- 1. 与 bundle-runtime.mjs 同构的打包(仅要 metafile,不写盘) ----
// 入口与 define/banner 均照抄 bundle-runtime.mjs;任何漂移都会在 review 时显形。
const RUNTIME_BANNER = `
const __hmhMeta = globalThis.__HMH_BUNDLED_META__;
const __hmhBundledMetaUrl = __hmhMeta.url;
const __hmhBundledMetaDirname = __hmhMeta.dirname;
const __hmhBundledMetaFilename = __hmhMeta.filename;
`.trim();
const esm = await build({
  entryPoints: [join(harnessRoot, 'packages', 'web', 'src', 'desktop-host.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['node:*'],
  define: {
    'import.meta.url': '__hmhBundledMetaUrl',
    'import.meta.dirname': '__hmhBundledMetaDirname',
    'import.meta.filename': '__hmhBundledMetaFilename',
  },
  banner: { js: RUNTIME_BANNER },
  write: false, metafile: true, logLevel: 'silent',
  absWorkingDir: harnessRoot,
});
const runner = await build({
  entryPoints: [join(harnessRoot, 'packages', 'web', 'src', 'task-runner.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['node:*'], write: false, metafile: true, logLevel: 'silent',
  absWorkingDir: harnessRoot,
});
const inputs = new Set([...Object.keys(esm.metafile.inputs), ...Object.keys(runner.metafile.inputs)]);
console.log(`[runtime-audit] 桌面打包链源文件:${inputs.size} 个(runtime.cjs ${Object.keys(esm.metafile.inputs).length} + task-runner.js ${Object.keys(runner.metafile.inputs).length})`);

// metafile inputs 相对 absWorkingDir(harnessRoot);统计打进包的 hmharness 包名
const pkgsInBundle = new Set();
for (const i of inputs) if (i.startsWith('packages/')) pkgsInBundle.add(i.split('/')[1]);

// ---- 2. hmharness 源码差异(from..to 的改动文件) ----
const git = (args) => execFileSync('git', ['-C', harnessRoot, ...args], { encoding: 'utf8' }).trim();
const changed = new Set(git(['diff', '--name-only', `${fromRef}..${toRef}`]).split(/\r?\n/).filter(Boolean));
const commitsRaw = git(['log', `${fromRef}..${toRef}`, '--format=%h%x09%s', '--no-merges']);
const commits = commitsRaw.split(/\r?\n/).filter(Boolean).map((l) => {
  const [h, ...rest] = l.split('\t');
  return { hash: h, subject: rest.join(' ') };
});

// ---- 3. 交集:改动且在桌面打包链内 ----
const hit = [...changed].filter((f) => inputs.has(f));
const hitByCommit = commits.map((c) => {
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', c.hash])
    .split(/\r?\n/).filter((f) => inputs.has(f));
  return { ...c, desktopFiles: files, affectsDesktop: files.length > 0 };
});

// ---- 4. 输出 ----
const report = {
  schema: 'hmh-desktop/desktop-runtime-diff@1',
  generatedAtUtc: new Date().toISOString(),
  harnessRoot, fromRef, toRef,
  bundleInputs: { total: inputs.size, packages: [...pkgsInBundle].sort() },
  changedFilesTotal: changed.size,
  changedFilesInDesktopBundle: hit.sort(),
  commits: hitByCommit,
  npmDependenciesBundled: [...new Set([...inputs]
    .map((i) => i.match(/node_modules[/\\]((@[^/\\]+[/\\])?[^\\/_@][^\\/]*)/)?.[1])
    .filter(Boolean))],
};
mkdirSync(dirname(jsonOut), { recursive: true });
writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

console.log(`[runtime-audit] ${fromRef}..${toRef} 改动 ${changed.size} 文件,其中 ${hit.length} 个在桌面打包链内:`);
for (const f of hit.sort()) console.log(`  ${f}`);
console.log(`[runtime-audit] 打进的 hmharness 包:[${[...pkgsInBundle].sort().join(', ')}]`);
console.log(`[runtime-audit] commit 视角:`);
for (const c of hitByCommit) console.log(`  ${c.affectsDesktop ? 'HIT ' : '----'} ${c.hash} ${c.subject.slice(0, 60)}${c.desktopFiles.length ? ` [${c.desktopFiles.length} files]` : ''}`);
console.log(`[runtime-audit] json -> ${relative(root, jsonOut)}`);

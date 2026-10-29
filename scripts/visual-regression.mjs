/**
 * 视觉回归驱动 —— 纯 node、零第三方依赖。
 *
 * 用法:node scripts/visual-regression.mjs [--dev|--packaged] [--update-baseline]
 *        [--mutate main|settings|dock]   (管线自检:注入色块,应 FAIL)
 *        [--out <dir>]                   (默认 evidence/visual-regression)
 * 挂载:npm run verify:visual
 *
 * 流程:spawn Electron(HMH_DESKTOP_VISREG=1,electron/main/visualregression.ts 输出确定性
 * 三视口截图)→ current/<name>.png + meta.json;baseline 不存在或 --update-baseline 时
 * 复制 current → baseline 退出;否则逐视口像素 diff:
 *   - 容差:单通道差 ≤ floor(255×2%) = 5 视为相同(抗锯齿/亚像素抖动)
 *   - 阈值:差异像素 / 可比像素(扣除 mask) > 0.5% 判 FAIL
 *   - mask:meta.json 中动态区(host 端口/时间戳/计数)bounding box,像素级跳过
 *   - 产出:diff-<name>.png(差异标红,其余淡化)+ report.json
 * exit code:0 = 全过 / 1 = 有 FAIL(可直接进 CI 门禁)。
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './lib/png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const usePackaged = argv.includes('--packaged');
const updateBaseline = argv.includes('--update-baseline');
const mutate = argOf('--mutate') ?? '';
const outDir = argOf('--out') ?? join(root, 'evidence', 'visual-regression');
const baselineDir = join(outDir, 'baseline');
const currentDir = join(outDir, 'current');

const TOLERANCE = Math.floor(255 * 0.02); // 单通道小色差容差:2% → 5
const RATIO_FAIL = 0.005; // 差异像素占比阈值:0.5%

const exe = usePackaged
  ? join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'HMH Desktop.exe')
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const exeArgs = usePackaged ? [] : [join(root, 'apps', 'desktop', 'dist-electron', 'main', 'index.js')];

console.log(`VISREG driver layout=${usePackaged ? 'packaged' : 'dev'} out=${outDir}${mutate !== '' ? ` mutate=${mutate}` : ''}${updateBaseline ? ' update-baseline' : ''}`);

/* ---- 1) 截图:复用 Electron 管线,输出确定性三视口 ---- */
rmSync(currentDir, { recursive: true, force: true });
mkdirSync(currentDir, { recursive: true });
const exitCode = await new Promise((resolve) => {
  const child = spawn(exe, exeArgs, {
    cwd: join(root, 'apps', 'desktop'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HMH_DESKTOP_VISREG: '1',
      HMH_DESKTOP_VISREG_OUT: currentDir,
      ...(mutate !== '' ? { HMH_DESKTOP_VISREG_MUTATE: mutate } : {}),
    },
  });
  let tail = '';
  child.stdout.on('data', (d) => {
    const s = d.toString();
    tail = (tail + s).slice(-8000);
    for (const line of s.split(/\r?\n/)) if (line.includes('VISREG')) console.log(line.slice(0, 300));
  });
  child.stderr.on('data', (d) => { tail += d.toString(); });
  child.on('exit', (code) => {
    if (code !== 0) console.error(tail.slice(-1500));
    resolve(code ?? 1);
  });
  setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 180_000);
});
if (exitCode !== 0) {
  console.error(`VISREG FAIL | capture exited ${exitCode}`);
  process.exit(1);
}
const metaPath = join(currentDir, 'meta.json');
if (!existsSync(metaPath)) {
  console.error('VISREG FAIL | capture produced no meta.json');
  process.exit(1);
}
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const viewportNames = meta.viewports.map((v) => v.name);

/* ---- 2) baseline:首次生成 / 显式更新 ---- */
const baselineMetaPath = join(baselineDir, 'meta.json');
if (updateBaseline || !existsSync(baselineMetaPath)) {
  rmSync(baselineDir, { recursive: true, force: true });
  mkdirSync(baselineDir, { recursive: true });
  for (const f of readdirSync(currentDir)) cpSync(join(currentDir, f), join(baselineDir, f));
  console.log(`VISREG BASELINE | ${updateBaseline ? 'updated' : 'created'} ${viewportNames.length} viewports: ${viewportNames.join(', ')} → ${baselineDir}`);
  process.exit(0);
}

/* ---- 3) 像素 diff(容差 + mask + 阈值) ---- */
const baseMeta = JSON.parse(readFileSync(baselineMetaPath, 'utf8'));
const report = {
  timestamp: new Date().toISOString(),
  thresholds: { tolerance: TOLERANCE, ratioFail: RATIO_FAIL, toleranceNote: 'per-channel |Δ| ≤ 5 (=2% of 255) treated as equal', ratioNote: 'diffPixels / comparablePixels (masked excluded) > 0.5% → FAIL' },
  mutate: mutate || null,
  viewports: [],
};
let anyFail = false;
for (const v of meta.viewports) {
  const base = baseMeta.viewports.find((x) => x.name === v.name) ?? null;
  const entry = { name: v.name, pass: false, width: v.width, height: v.height, masks: v.masks.length };
  if (base === null) {
    entry.reason = 'no baseline viewport';
    report.viewports.push(entry);
    anyFail = true;
    console.log(`VISREG FAIL | ${v.name} | no baseline`);
    continue;
  }
  let a, b;
  try {
    a = decodePng(readFileSync(join(baselineDir, base.file)));
    b = decodePng(readFileSync(join(currentDir, v.file)));
  } catch (err) {
    entry.reason = `decode: ${err instanceof Error ? err.message : String(err)}`;
    report.viewports.push(entry);
    anyFail = true;
    console.log(`VISREG FAIL | ${v.name} | ${entry.reason}`);
    continue;
  }
  if (a.width !== b.width || a.height !== b.height) {
    entry.reason = `size mismatch baseline ${a.width}x${a.height} vs current ${b.width}x${b.height}`;
    report.viewports.push(entry);
    anyFail = true;
    console.log(`VISREG FAIL | ${v.name} | ${entry.reason}`);
    continue;
  }
  const { width, height } = a;
  // mask 位图:baseline 与 current 的 masks 取并集(结构变化本身就该被看见,但动态区永远豁免)
  const masked = new Uint8Array(width * height);
  let maskedPixels = 0;
  for (const m of [...base.masks, ...v.masks]) {
    const x1 = Math.max(0, m.x), y1 = Math.max(0, m.y);
    const x2 = Math.min(width, m.x + m.w), y2 = Math.min(height, m.y + m.h);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) {
      if (masked[y * width + x] === 0) { masked[y * width + x] = 1; maskedPixels++; }
    }
  }
  // 逐像素 diff + diff 图(差异纯红,其余淡化向白,masked 区蓝框底色不染)
  const diffImg = new Uint8Array(width * height * 4);
  let diffPixels = 0, comparable = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const isMasked = masked[y * width + x] === 1;
      if (!isMasked) comparable++;
      let isDiff = false;
      if (!isMasked) {
        isDiff = Math.abs(a.data[i] - b.data[i]) > TOLERANCE
          || Math.abs(a.data[i + 1] - b.data[i + 1]) > TOLERANCE
          || Math.abs(a.data[i + 2] - b.data[i + 2]) > TOLERANCE;
        if (isDiff) diffPixels++;
      }
      if (isDiff) {
        diffImg[i] = 255; diffImg[i + 1] = 0; diffImg[i + 2] = 0; diffImg[i + 3] = 255;
      } else if (isMasked) {
        diffImg[i] = b.data[i]; diffImg[i + 1] = b.data[i + 1]; diffImg[i + 2] = b.data[i + 2]; diffImg[i + 3] = 255; // mask 区原样
      } else {
        diffImg[i] = Math.round(b.data[i] * 0.35 + 165); // 未变像素淡化,凸显差异
        diffImg[i + 1] = Math.round(b.data[i + 1] * 0.35 + 165);
        diffImg[i + 2] = Math.round(b.data[i + 2] * 0.35 + 165);
        diffImg[i + 3] = 255;
      }
    }
  }
  const ratio = comparable > 0 ? diffPixels / comparable : 1;
  entry.pass = ratio <= RATIO_FAIL;
  entry.diffPixels = diffPixels;
  entry.comparablePixels = comparable;
  entry.maskedPixels = maskedPixels;
  entry.diffRatio = Math.round(ratio * 10000) / 10000;
  if (!entry.pass) anyFail = true;
  if (diffPixels > 0 || !entry.pass) {
    writeFileSync(join(outDir, `diff-${v.name}.png`), encodePng(width, height, diffImg));
    entry.diffImage = `diff-${v.name}.png`;
  }
  report.viewports.push(entry);
  const pct = (ratio * 100).toFixed(4);
  console.log(`VISREG ${entry.pass ? 'PASS' : 'FAIL'} | ${v.name} | ${width}x${height} diff=${diffPixels}/${comparable}=${pct}% masked=${maskedPixels}px${v.mutate ? ' [mutated]' : ''}${entry.pass ? '' : ` (threshold ${(RATIO_FAIL * 100).toFixed(2)}%)`}`);
}

writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const passed = report.viewports.filter((v) => v.pass).length;
console.log(`VISREG SUMMARY ${anyFail ? 'FAIL' : 'PASS'} ${passed}/${report.viewports.length} viewports, tolerance=${TOLERANCE}/255ch, ratioFail=${RATIO_FAIL * 100}% → ${join(outDir, 'report.json')}`);
process.exit(anyFail ? 1 : 0);

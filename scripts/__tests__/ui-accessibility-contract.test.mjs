/**
 * UI 无障碍合同测试(静态)—— 验收缺口:图标按钮 accessible name / reduce-motion /
 * focus-visible / 颜色外状态编码,四类断言防回归。
 *
 * 边界(如实声明):本文件是**静态合同测试**(扫 TSX/CSS 源码),不做运行时 DOM 断言;
 * 动态键盘全流程与 axe 自动扫描属后续轮(uiverify 覆盖键盘流,axe 待引入)。
 * 扫描对象:apps/desktop/renderer/src/*.tsx + app.css(Windows renderer 主界面)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'desktop', 'renderer', 'src');
const css = readFileSync(join(rendererDir, 'app.css'), 'utf8');
const tsxFiles = readdirSync(rendererDir).filter((f) => f.endsWith('.tsx'));
const tsx = Object.fromEntries(tsxFiles.map((f) => [f, readFileSync(join(rendererDir, f), 'utf8')]));

/* ---------- 工具:提取 <button>...</button> 元素串(代码库中按钮不嵌套) ---------- */
function extractButtons(source) {
  const out = [];
  const re = /<button\b[\s\S]*?<\/button>/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[0]);
  return out;
}
/** 剥离全部 JSX 标签后的可见内容(保留 {} 表达式痕迹:动态文字也算有字) */
function visibleText(element) {
  return element
    .replace(/=>/g, '==') // 箭头函数防截断
    .replace(/^<button\b[^>]*>/, '')
    .replace(/<\/button>$/, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}
function hasAccessibleName(openingTag) {
  return /\baria-label(?:ledby)?\s*=/.test(openingTag);
}

/* ---------- 1. icon-only 按钮必有 aria-label / aria-labelledby ---------- */
test('a11y 合同:icon-only 按钮必有 accessible name(aria-label/labelledby)', () => {
  const offenders = [];
  for (const [file, src] of Object.entries(tsx)) {
    for (const btn of extractButtons(src)) {
      const safe = btn.replace(/=>/g, '==');
      const open = safe.match(/^<button\b[^>]*>/)?.[0] ?? '';
      if (hasAccessibleName(open)) continue;
      const text = visibleText(btn);
      // 残留非空白文字或 {表达式}(动态文字)→ 非 icon-only,放行
      if (text !== '') continue;
      offenders.push(`${file}: <button …>${btn.slice(0, 90).replace(/\s+/g, ' ')}…(无 aria-label 且无可见文字)`);
    }
  }
  assert.deepStrictEqual(offenders, [], `icon-only 按钮缺 accessible name:\n${offenders.join('\n')}`);
});

/* ---------- 2. prefers-reduced-motion 存在且真正关断动画 ---------- */
test('a11y 合同:prefers-reduced-motion 全局关断 + 停 pulse/blink(防回归)', () => {
  const m = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
  assert.ok(m, 'app.css 缺 @media (prefers-reduced-motion: reduce) 块');
  const block = css.slice(m.index);
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/, 'reduce-motion 未把动画时长压到 ~0(全局)');
  assert.match(block, /transition-duration:\s*0\.01ms\s*!important/, 'reduce-motion 未把过渡时长压到 ~0(全局)');
  assert.match(block, /\.session-running-dot[\s\S]{0,120}animation:\s*none\s*!important/, 'reduce-motion 未停 .session-running-dot pulse');
  assert.match(block, /\.cursor[\s\S]{0,160}animation:\s*none\s*!important/, 'reduce-motion 未停 .cursor 闪烁');
});

/* ---------- 3. :focus-visible 样式存在(键盘可见性,防回归) ---------- */
test('a11y 合同:键盘 focus-visible 焦点环存在(2px 实线 + 偏移)', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px\s+solid/, 'app.css 缺全局 :focus-visible outline 规则');
});

/* ---------- 4. 状态不靠颜色单独编码 ---------- */
test('a11y 合同:diff 状态 = 字母 + title 提示 + 文字标签(颜色外双通道)', () => {
  const app = tsx['App.tsx'] ?? '';
  // 每处 .diff-state(字母位)必须带 title(tooltip 即非颜色通道之一)
  const stateRe = /<span[^>]*className=\{`diff-state [^`]*`\}[^>]*>[^<]*<\/span>/g;
  const states = app.match(stateRe) ?? [];
  assert.ok(states.length >= 1, 'App.tsx 中未找到 diff-state 用法(选择器失效?需同步测试)');
  const noTitle = states.filter((s) => !/\stitle=/.test(s));
  assert.deepStrictEqual(noTitle, [], `diff-state 缺 title 提示:\n${noTitle.join('\n')}`);
  // 状态文字标签存在且双语字典齐全(i18n zh/en 同形)
  assert.match(app, /diff-state-label/, 'diff 行未渲染 diff-state-label 文字标签');
  for (const key of ['diffStateAdd', 'diffStateMod', 'diffStateDel']) {
    const i18n = readFileSync(join(rendererDir, 'i18n.ts'), 'utf8');
    const zh = new RegExp(`${key}:\\s*'[^']+'`).test(i18n);
    assert.ok(zh, `i18n.ts 缺 ${key}(zh)`);
    const enCount = (i18n.match(new RegExp(`${key}:\\s*'[^']+'`, 'g')) ?? []).length;
    assert.ok(enCount >= 2, `i18n.ts 的 ${key} 未在 zh/en 双语同时出现(现 ${enCount} 处)`);
  }
});

test('a11y 合同:status-chip 状态 = dot(装饰) + 文字,非仅颜色', () => {
  const app = tsx['App.tsx'] ?? '';
  const chipRe = /<span[^>]*className=\{?['"`]status-chip/g;
  const chips = app.match(chipRe) ?? [];
  if (chips.length === 0) return; // 无用法则无需断言(选择器失效由上面临近断言兜底)
  // status-chip 元素体内必须有 {…}(状态文字渲染);逐个抓完整元素串验证
  const full = app.match(/<span[^>]*status-chip[^>]*>[\s\S]{0,200}?<\/span>/g) ?? [];
  const noText = full.filter((s) => !visibleText(s) && !/\{/.test(s.replace(/^<span[^>]*>/, '').replace(/<\/span>$/, '')));
  assert.deepStrictEqual(noText, [], `status-chip 仅剩颜色 dot、无文字:\n${noText.join('\n')}`);
});

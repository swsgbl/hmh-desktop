#!/usr/bin/env node
/**
 * Guard critical desktop UX invariants that should survive CSS refactors.
 * This is a source-level contract check; real UIVERIFY remains necessary.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push(name);
  if (!ok) failures.push(`FAIL ${name}: ${detail}`);
  else console.log(`PASS ${name}`);
}
const theme = read('apps/desktop/renderer/src/theme.ts');
const css = read('apps/desktop/renderer/src/app.css');
const tokens = read('packages/ui-tokens/src/tokens.css');
const app = read('apps/desktop/renderer/src/App.tsx');

check('system theme is default', /return\s+'system'/.test(theme), 'getTheme() should default to system, not hard-code light/dark');
check('dark-mode media query is the source of truth', /prefers-color-scheme:\s*dark/.test(theme), 'system resolution/listener must observe prefers-color-scheme: dark');
check('keyboard focus is visible', /:focus-visible/.test(css) && /outline:\s*2px solid var\(--hmh-brand-primary\)/.test(css), 'interactive controls need a visible focus ring');
check('reduced motion supported', /prefers-reduced-motion:\s*reduce/.test(css) && /animation-duration:\s*0\.01ms/.test(css), 'honor the OS Reduce Motion preference');
check('infinite indicators quiet under reduced motion', /\.cursor\s*\{[^}]*animation:\s*none/s.test(css) && /\.wizard-progress\.indeterminate[^}]*animation:\s*none/s.test(css), 'typing cursor and indeterminate wizard need non-animated alternatives');
check('native-style control geometry', /\.btn\s*\{[^}]*border-radius:\s*var\(--hmh-radius-sm\)/s.test(css), 'regular buttons should not use the global pill radius');
check('sidebar hierarchy token exists in both themes', /--hmh-sidebar-bg:\s*#f2f3f5/.test(tokens) && /--hmh-sidebar-bg:\s*#17191f/.test(tokens), 'provide distinct light/dark sidebar surface tokens');
check('renderer keeps external output as text', !/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(app), 'do not inject user/model/runtime data as raw HTML');

if (failures.length) {
  failures.forEach((x) => console.error(x));
  console.error(`UI foundation guard FAILED: ${failures.length}/${checks.length} checks`);
  process.exitCode = 1;
} else {
  console.log(`UI foundation guard PASS: ${checks.length} critical UX/security invariants`);
}

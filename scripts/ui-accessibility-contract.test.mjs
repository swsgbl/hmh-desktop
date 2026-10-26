import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'apps/desktop/renderer/src/app.css'), 'utf8');
const tokens = readFileSync(join(root, 'packages/ui-tokens/src/tokens.css'), 'utf8');

test('semantic desktop surface, selection and focus tokens exist for both themes', () => {
  for (const token of [
    '--hmh-sidebar-bg',
    '--hmh-toolbar-bg',
    '--hmh-selection-bg',
    '--hmh-focus-ring',
    '--hmh-radius-control',
  ]) assert.match(tokens, new RegExp(token));
  assert.match(tokens, /:root\[data-theme='dark'\]/);
});

test('session row actions are discoverable without mouse hover', () => {
  assert.match(css, /\.session-row:focus-within\s+\.session-export/);
  assert.match(css, /\.session-export:focus-visible/);
  assert.match(css, /@media\s*\(hover:\s*none\)/);
});

test('reduced-motion removes persistent session pulse and minimizes motion', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.session-running-dot\s*\{\s*animation:\s*none\s*!important;/);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
});

test('forced-colors keeps visible focus and selected boundaries', () => {
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /outline:\s*2px solid Highlight/);
  assert.match(css, /outline:\s*1px solid Highlight/);
});

test('high contrast tokens increase boundary visibility', () => {
  assert.match(tokens, /@media\s*\(prefers-contrast:\s*more\)/);
  assert.match(tokens, /--hmh-focus-ring:\s*#003fc7/);
});

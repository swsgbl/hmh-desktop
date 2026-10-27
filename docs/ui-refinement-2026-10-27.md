# HMH Desktop — Accessibility Refinement (2026-10-27)

## Scope
This first UI-quality change is intentionally narrow. It does not alter runtime behavior, permission checks, shell execution, provider configuration, or Agent loops.

Changes:
1. Session-row actions are visible while a descendant has keyboard focus (:focus-within), not only when the pointer hovers.
2. Compact icon actions and title-bar menu gain an explicit visible focus outline.
3. The icon-button base declares a 36×36 CSS-pixel minimum target.
4. prefers-reduced-motion: reduce minimizes global transitions/animations and disables the session status pulse / streaming cursor animation.

## Why
Apple HIG-inspired polish is not just color and round corners. Predictable focus, reversible interaction, input-mode parity, and respect for reduced-motion settings are foundational. The user should not have to discover an action by moving the pointer over a row.

## Required verification before merge
Run in a clean Windows build environment:
- npm run typecheck
- npm test
- npm run build
- node scripts/ui-verify.mjs --dev --fake
- node scripts/ui-verify.mjs --packaged --fake
- keyboard-only pass: Tab/Shift+Tab into session action buttons; verify actions appear without hover and focus is visible.
- OS Reduce Motion pass: enable reduce-motion preference and confirm no persistent pulsing or cursor blink.
- screenshot compare at 1440×900, 1366×768, 1024×768 and 820px app width, both light and dark themes.

## Evidence
This PR is a code-level refinement proposal. The GitHub checks and packaged UI verification must pass before merge. Static CSS alone is not evidence that the full Apple HIG redesign is complete.

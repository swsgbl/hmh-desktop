# ADR-006: Apple HIG-inspired interaction layer

- Status: Accepted for incremental rollout
- Date: 2026-10-27
- Scope: HMH Desktop Electron/React renderer; shared semantic tokens; OpenHarmony keeps ArkUI-native interaction patterns
- Supersedes: interaction and control-shape portions of docs/prompts/design-language-dsh.md where they conflict with this ADR. Existing color aliases and evidence-derived palette remain the baseline until contrast testing supports a change.

## Context

The current renderer has a mature three-pane workbench, 8-state run lifecycle, command palette, setup wizard, settings, approval cards, and an Overview/Files/Diff/Evidence/Logs/Remote context dock. The 2026-10-27 audit identified an experience gap: repeated pill-shaped controls and DSH-derived visual primitives create a generic SaaS feel, while the product asks to feel at home on desktop. Accessibility behavior also needs explicit reduced-motion and forced-colors treatment.

## Decision

Adopt the principles of macOS Human Interface Guidelines without copying Apple's proprietary assets or claiming platform-native implementation:

1. Quiet hierarchy: window title/toolbar, sidebar navigation, primary workspace, optional context dock; put the task result above execution details.
2. Restrained controls: use compact 8px control radii and 32px toolbar targets; reserve brand blue for primary actions, focus, and meaningful state.
3. Standard placement: group navigation at the leading edge, context controls near the content they affect, and infrequent commands in overflow/command palette.
4. Discoverability: keyboard focus must reveal row actions even when hover is unavailable; destructive actions must be named and confirmed where appropriate.
5. Accessibility: visible focus, reduced-motion support, forced-colors behavior, status text/icons in addition to color, readable contrast, complete keyboard flows.
6. Platform separation: Windows gets a desktop-oriented cross-platform implementation; OpenHarmony uses ArkUI interaction conventions with shared semantic meaning, not a pixel-copy of macOS.

## Deliberate non-goals

- Do not rewrite the app or split the 1,400-line component just to pursue code aesthetics in this visual pass.
- Do not change runtime/Host APIs, session semantics, approvals, or task execution.
- Do not introduce a new UI component dependency.
- Do not mimic exact Apple icons, system controls, wallpapers, trademarks, or Liquid Glass implementation.

## Implementation

- Introduce semantic tokens for sidebar surface, toolbar surface, selected state, focus ring and control radius.
- Apply subtle toolbar translucency where supported; plain surface remains usable when unsupported.
- Keep existing HMH brand blue and semantic state colors.
- Reveal session row actions on keyboard focus and touch devices.
- Respect prefers-reduced-motion and Windows forced-colors.
- Validate screenshot diffs, focus order, contrast, reduced motion and core E2E flows before promoting to main.

## Acceptance

- No behavior or API changes from the CSS/token commit.
- Existing app layout remains usable at 1280×800, 1440×900 and 1920×1080.
- Keyboard-only users can locate session export/archive/delete actions without a mouse.
- Reduced-motion setting disables the session pulse and minimizes transitions.
- Forced-colors mode retains focus and selection boundaries.
- Light/dark/system themes stay readable; no color-only state.
- Setup, send, stop, approval, session switch, dock tabs, file preview, diff and log flows pass E2E.
- If visual testing is unavailable, report the commit as unverified and do not claim acceptance.

## Primary reference

Apple Human Interface Guidelines, especially macOS sidebars and toolbars:
- https://developer.apple.com/design/human-interface-guidelines
- https://developer.apple.com/design/human-interface-guidelines/sidebars
- https://developer.apple.com/design/human-interface-guidelines/toolbars

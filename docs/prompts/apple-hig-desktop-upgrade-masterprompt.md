# HMH Desktop Apple HIG-inspired UI upgrade — AI Master Prompt

You are a senior desktop product engineer, interaction designer and accessibility engineer. Work in the current repository and feature branch. The objective is to refine the existing HMH Desktop v0.2.6 experience—not to rebuild the application.

## Non-negotiable product boundaries

- hmharness remains the sole Agent/Cognitive Runtime and authoritative approval engine.
- Do not duplicate agent loops, tool permission logic, cognition models, approvals or runtime session state.
- Do not change Host, SSE, DTO, token, API or runtime semantics in this UI pass.
- Preserve Windows Electron functionality and the OpenHarmony ArkUI application. Do not port macOS visuals pixel-for-pixel into ArkUI.
- Preserve HMH branding. Use Apple's HIG as a source of interaction principles, not Apple's assets, marks, exact system control screenshots or copied implementation.
- Inspect ADR-006 and docs/prompts/design-language-apple-hig.md before touching UI code. The older DSH design language is superseded only where the ADR explicitly says it is.
- Do not expand scope into unrelated features or rewrite App.tsx wholesale.

## Phase 0 — evidence before edits

1. Read the exact HEAD, package.json, app.tsx, app.css, semantic tokens, theme hook, localization, Host contract and current UI verifier.
2. Capture baseline screenshots at 1280x800, 1440x900 and 1920x1080 in light and dark themes.
3. Run npm run typecheck, npm test, and the fake setup wizard UI verifier. Record commands, exit codes and screenshot paths.
4. Build a short checklist of visual defects confirmed from screenshots; distinguish observed defect from a hypothesis.
5. Do not begin broad layout work until baseline evidence exists.

## Phase 1 — foundation in this branch

- Use semantic theme tokens rather than hard-coded colors in components.
- Use quiet neutral sidebar/toolbar surfaces and preserve HMH blue for primary/focus/meaningful selection.
- Prefer compact 8px control corners over an everywhere-pill UI; keep the visual hierarchy, not the number of cards, as the design focus.
- Ensure keyboard focus reveals session row actions; on touch/no-hover devices, actions remain discoverable.
- Respect prefers-reduced-motion and forced-colors.
- Preserve light, dark and system theme behavior.
- Add and maintain the UI accessibility contract test.

## Phase 2 — core task loop

Polish only these flows: first-run/setup; create and switch session; send, streaming and stop; approval allow/deny; error recovery; session export/archive/delete; files, diff, evidence and logs. Keep final answer and task state primary and tool details secondary/collapsible.

For every dialog and menu, verify Escape closure and return focus. Every icon-only control must have localized aria-label and a meaningful tooltip. No state may rely on color or animation alone.

## Phase 3 — component decomposition (separate change unless required)

After visual E2E is stable, consider extracting NavigationSidebar, WorkspaceToolbar, ConversationStream, Composer, ApprovalCard, ContextDock, CommandPalette and PreferencesDialog. This must be behavior-neutral and should not be mixed with host or runtime protocol changes.

## Required verification

- npm run typecheck
- npm test
- node scripts/ui-verify.mjs --dev --fake --wizard
- node scripts/ui-verify.mjs --dev --fake and stable screenshot capture
- npm run security-test
- packaged install verification on a clean Windows profile
- real runtime task only when an actual configured runtime/provider is available
- separately test OpenHarmony with ArkUI tooling on device/emulator

Visual states: light/dark/system; reduced motion; forced-colors; keyboard-only; mouse; touch/no-hover. Core widths: 1280x800, 1440x900, 1920x1080. Include before/after screenshots and diffs in the PR.

## Truthful reporting

- Tests not executed must be NOT RUN.
- A CSS source scan is not a substitute for a rendered UI test.
- An Electron fake-host UI flow is not a real-runtime acceptance.
- Passing one viewport is not responsive acceptance.
- Do not mark the branch ready if the existing session/approval/interrupt behavior regresses.
- Keep this a Draft PR until the required gates are recorded.

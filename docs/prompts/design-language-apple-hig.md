# HMH Desktop design language: Apple HIG-inspired, HMH-owned

Date: 2026-10-27. This document is an incremental interaction contract for HMH Desktop. See ADR-006 for precedence against the older DSH-derived control language.

## Product feeling

Calm, precise, native-feeling desktop software. HMH should look like a focused workbench, not a dashboard of cards. The interface may learn from macOS hierarchy and interaction principles, but must retain HMH identity and avoid copying Apple artwork or proprietary native-control appearances.

## Information architecture

- Sidebar: workspace selector, New Session, search/status filters, sessions grouped by workspace. No critical action should be hidden at the very bottom.
- Toolbar: sidebar toggle, concise workspace/task context, model selector when relevant, task controls, settings, context-dock toggle. Group into at most three visual clusters.
- Main: conversation and final answer are primary; tool details are collapsed by default; approvals and errors remain prominent and actionable.
- Context Dock: Overview, Files, Diff, Evidence, Logs, Remote; optional and resizable/compact on narrower windows.
- Composer: always reachable, focused on prompt + attachments + send/stop; don't bury current run state or approval request.

## Token rules

- Use semantic --hmh-* tokens; no new hard-coded colors in feature components.
- Keep 4px spacing rhythm: 4, 8, 12, 16, 24, 32.
- UI type: system stack then Segoe UI/PingFang SC/Microsoft YaHei fallback; code uses monospace.
- Compact controls: 32px minimum toolbar targets; 8px corner radius for common controls; 12px for surfaces and menus.
- Blue is an interaction accent, not a paint bucket. Use it for focus/primary/selected semantics; use neutral toolbar/sidebar surfaces.
- Cards are structural only; prefer whitespace and grouping over nested borders.
- The context dock is supplementary, not visually equal to the conversation.

## Interaction rules

- Every icon-only button needs a localized accessible name and useful tooltip.
- All core actions support keyboard operation and visible focus.
- Session action icons become visible on keyboard focus and touch devices.
- Escape closes transient command/settings/attachment surfaces; focus returns to invoking control.
- Toolbar commands must also be reachable through menu/command palette when appropriate.
- Active/running/approval/failed/completed states use icon/text plus color.
- Do not use perpetual animation as the only signal; obey prefers-reduced-motion and Windows forced-colors.
- Destructive actions are reversible or explicitly confirmed.
- Menus/dialogs expose role, name, expanded/selected state and sensible focus order.

## Motion

- Hover/pressed: 100–160ms.
- Pane/dialog state: 140–200ms.
- Completion: restrained, 180–240ms maximum.
- No bounce or spring choreography in the default workbench.
- When reduced motion is requested, transitions become nearly immediate and the running pulse is removed.

## Responsive behavior

- 1440×900: 260px sidebar, flexible conversation area, optional 340–380px context dock.
- 1280×800: protect the composer and conversation width; collapse dock to a toggleable panel rather than squeezing content into narrow columns.
- 1920×1080: cap reading content width instead of stretching messages across the display.
- Touch/no-hover: session actions must remain visible.
- OpenHarmony UI: follow ArkUI conventions, reuse semantics/tokens where possible, and run device screenshots separately.

## Required visual QA matrix

Themes: light, dark, system. Input modes: keyboard-only, mouse, touch/no-hover. Motion: normal/reduced. Display modes: standard/forced-colors where available. Viewports: 1280×800, 1440×900, 1920×1080, and OpenHarmony device viewport.

Core flows: first run/setup, create/switch session, send, stream, stop, approval allow/deny, error recovery, session export/archive/delete, file preview, diff, evidence/logs, settings/provider validation.

Reference: https://developer.apple.com/design/human-interface-guidelines

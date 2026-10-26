# Apple-HIG UI upgrade acceptance checklist

Use this as a test plan; checking boxes without observed evidence is not acceptance.

## Functional invariants
- [ ] Existing Host bridge/runtime/session/approval APIs unchanged.
- [ ] First-run setup and runtime auto-detection unchanged.
- [ ] Sending, streaming, interruption, cancellation and error recovery work.
- [ ] Approval allow/deny remains runtime-authoritative.
- [ ] Session switch and SSE reconnect do not duplicate or cross-contaminate events.
- [ ] Files/diff/evidence/logs/remote tabs still load and show empty/error states honestly.

## Visual matrix
- [ ] 1280x800, 1440x900, 1920x1080 screenshot capture.
- [ ] Light, dark and system themes.
- [ ] Keyboard focus ring visible on all actionable controls.
- [ ] Focus enters and exits dialogs/menus in logical order; Escape closes transient surfaces.
- [ ] Session export/archive/delete controls appear on focus and on no-hover devices.
- [ ] Reduced motion removes session pulse and suppresses longer transitions.
- [ ] Forced-colors mode shows focus and selection boundaries.
- [ ] Selected state uses icon/text or accessible selected semantics as well as color.
- [ ] Text contrast is measured for normal/large text and disabled controls.
- [ ] No clipped composer, unscrollable session list, horizontal overflow or dock overlap.
- [ ] Screenshots reviewed; before/after diff and test artifacts attached to PR.

## How to run
1. npm run typecheck
2. npm test
3. node scripts/ui-verify.mjs --dev --fake --wizard
4. node scripts/ui-verify.mjs --dev --real --real-task when a real runtime/provider is available.
5. Package with npm run package, then run node scripts/install-verify.mjs on a clean Windows profile.
6. Record any unavailable real-host or device checks as NOT RUN, not PASS.

## Evidence template
- Commit:
- OS / Electron:
- Runtime version:
- Theme / viewport / motion mode:
- Scripts and exit codes:
- Screenshot artifact paths:
- Manual keyboard test:
- Known gaps:

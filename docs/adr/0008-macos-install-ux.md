# ADR-0008: macOS install UX — DMG installer + runtime move prompt

> **Historical record, imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** `client/desktop/` there is `desktop/` here. Issue numbers, `docs/superpowers/**`, `docs/runbooks/**`, `docs/ci/**`, `.claude/rules/*.md` (now `.claude/rules/domains/`), control-plane paths and ADRs not in this folder refer to Alpha or the private ops repos.

**Date:** 2026-05-22
**Status:** Accepted — Phase 1 (DMG) shipped under issue #1159; Phase 2 (runtime gate) shipped in #1966. **DMG-shell signing + notarization + stapling** (originally deferred from Phase 1) shipped in #1164; see ADR-0019.
**Issue:** #1159
**Spec:** `docs/superpowers/specs/2026-05-22-1159-macos-install-ux-design.md`

## Context

The macOS desktop client ships as a plain `.zip` archive via Electron Forge's `MakerZIP`. Three concrete failure modes follow:

1. **No first-install ritual.** Users unzip the `.app` to `~/Downloads/` and never see a drag-to-Applications prompt.
2. **Silent auto-update failure for apps in `~/Downloads/`.** Squirrel.Mac's in-place rewrite fails when macOS Gatekeeper translocates a quarantined `.app` to a read-only DMG-image mount, and electron-updater does NOT surface the failure to the user.
3. **Downloads-cleanup data loss.** macOS and Safari eventually purge `~/Downloads/`, taking the app with it.

## Decision

**Option C** — produce both a styled DMG (Phase 1) AND a runtime `app.moveToApplicationsFolder()` prompt (Phase 2):

- **Phase 1 (this ADR's primary scope):** Add `@electron-forge/maker-dmg` to the Forge maker pipeline. Configure a 540×380 canvas with branded background, app-icon position at `(130, 200)`, Applications-shortcut at `(410, 200)`. Render the background PNG from a checked-in HTML mockup via Playwright. Update CI to upload `.dmg` artifacts and verify their structural production (file existence + size). **DMG-shell signing + notarization + stapling shipped in #1164** — Forge's `osxNotarize` only notarizes the inner `.app`, not the outer `.dmg` container, so the .dmg notarization runs as a separate post-make notarytool submission flow in `build-desktop.yml` (adds ~5 min CI wall-clock per macOS matrix leg). First-time `.dmg` downloads now mount with no Gatekeeper prompt; launches from `/Applications/` remain clean via the inner `.app`'s independent staple. See ADR-0019.
- **Phase 2 (#1966):** `applicationsFolderGate.ts` detects packaged macOS launches from outside `/Applications/` before `BrowserWindow` creation and offers to move via `app.moveToApplicationsFolder()`. The gate skips dev, non-macOS, already-in-Applications, and `CONCORD_DEV_SKIP_MOVE_PROMPT` launches; dismissed prompts persist by app version in `install-preferences.json` under pinned `userData`, so a desktop version bump re-prompts.

The update chain stays on ZIP — `latest-mac.yml` references `.zip` files and electron-updater consumes them. The DMG is install-only.

## Alternatives considered

- **Option A — DMG only.** Rejected: misses users on the ZIP path (CI artifacts, direct-download fallback).
- **Option B — Runtime gate only.** Rejected: ships a generic system dialog as user's first sight of Concord Voice.

## Consequences

**Positive:**
- First-install ritual aligns with macOS user expectations (the pattern used by major desktop apps).
- Defense-in-depth: Phase 2 runtime gate catches ZIP-path users + any DMG user who manually copies to a non-`/Applications/` path.
- Update reliability compounds: with Phase 2 shipped, electron-updater's known Squirrel.Mac translocation failure is no longer reachable for the typical user.

**Negative:**
- Two artifacts published per macOS architecture (~120MB ZIP + ~120MB DMG = ~240MB per arch × 2 archs = ~480MB total uploaded per release).
- Maker-dmg requires macOS host with `hdiutil` for building — already met by CI's macos-latest runner.
- Per-arch DMG (not universal) — same size tradeoff as existing per-arch ZIP. Universal binary remains a future consolidation option.

**Future revisits:**
- Sparkle migration would change the install/update boundary; DMG might wrap a `.pkg` instead of a `.app`.
- Universal binary doubles install size for one-asset UX; deferred until app size grows enough to make the tradeoff matter.
- Mac App Store distribution would bypass the DMG entirely for that channel.

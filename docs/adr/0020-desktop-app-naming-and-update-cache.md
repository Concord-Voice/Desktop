# 0020 — Desktop App Naming: Decouple Path-Identity from Display Name

**Status:** Accepted
**Date:** 2026-06-02
**Decided:** 2026-06-02 — D2 (explicit `userData` pin) and D4-a (implement blockmap differential downloads now), per repo-admin direction.
**Issue:** #1291 (D1+D2+D3 + boy-scout log fix) · #1292 (D4-a differential downloads, separate). Surfaced by the macOS update-log investigation.
**Predecessors:** d9895603 (#385/#392 — the intended spaceless convention), 72b98f1a (v0.1.38 — the regression)
**Related:** ADR-0003 (E2EE always), ADR-0004 (desktop release contract, kept in the private Release-Ops repo), [ADR-0008 (macOS install UX)](0008-macos-install-ux.md)

> **The Windows rows in both tables below are superseded by [ADR-0034](0034-windows-nsis-migration.md) (#2402, 2026-07-25).** Squirrel.Windows was replaced by NSIS; `MakerSquirrel` is no longer imported by `forge.config.ts`. ADR-0034 supersedes the end-state row's **sufficiency** claim ("none (already correct)") — on Windows the install root and the updater cache must not be the same pinned directory. The path-identity principle and the macOS / Linux rows are unchanged.

## Context

Debugging the macOS auto-update logs (`~/Library/Logs/ConcordVoice/update-2026-05-*.log`) surfaced three interlocking faults, all rooted in a single design flaw: **Electron's `app.getName()` (which resolves to `package.json` `productName` in the packaged app) is overloaded to drive three semantically distinct things at once** —

1. **Display name** — UI, the macOS `.app` bundle name, window title, Activity Monitor / Task Manager entry. Wants the human-facing `"Concord Voice"` (with space).
2. **Path identity** — `app.getPath('userData')` (`~/Library/Application Support/<name>`), the electron-updater cache dir (`~/Library/Caches/<name>`), and (by default) the logs dir. Wants a **stable, spaceless, immutable** token that never changes across releases.
3. **OS-package identity** — Windows install dir / registry (`ConcordVoice`), Linux executable (`concord-voice`).

When path-identity is sourced from the same string as the display name, any edit to that string for *display* reasons silently moves *data* directories.

### What happened

#385/#392 (commit `d9895603`, v0.1.12, 2026-03-26) deliberately set `productName: "ConcordVoice"` (spaceless) "so Electron's `app.getPath('userData')` returns spaceless paths," keeping the display name `"Concord Voice"` via `packagerConfig.name`. It shipped `userDataMigration.ts` to rename the old spaced dir forward.

Commit `72b98f1a` (v0.1.38, 2026-05-20, "Update product name and version in package.json") reverted `productName` to `"Concord Voice"` — touching **only** `package.json`, not the migration. This silently undid #385's convention. HEAD (v0.1.55) still carries the spaced form.

### The three findings

**Finding 1 — `userData` split on update (severity: MEDIUM, recoverable).**
Because `productName` drives `app.getPath('userData')`, every user updating across the v0.1.37→v0.1.38 boundary had their userData path move from `…/Application Support/ConcordVoice` back to `…/Concord Voice`. `userDataMigration.ts` only migrates the *forward* direction (`Concord Voice`→`ConcordVoice`); after the revert its `oldPath` and `newPath` collapse to the same dir (lines 42–43) → structural no-op. Empirically confirmed on a developer machine 2026-06-02: two parallel userData trees, the spaceless one frozen at the update minute, the spaced one live since, each holding `secure-token.dat` / `secure-e2ee.dat` / `machine-id.json`.

Blast radius was traced to be **recoverable, not data-loss**: the RSA keypair is per-account and **server-escrowed** (`user_keys.wrapped_private_key`, wrapped under a password-derived Argon2id key). `secure-e2ee.dat` is only a local cache. On the empty new tree the client fails **closed** (`e2eeService.isInitialized === false` → blank message content, send blocked — per the #918 startup-race guard), forcing a re-login; the normal login path re-fetches the server blob and unwraps the **same** RSA key. Consequences are therefore: a forced re-login (session loss), a regenerated `machine-id` (the server sees a **new device** → client-attestation #1264 / device-binding re-trigger), and orphaned secret material left at rest in the old tree. No message-history loss in the normal case.

**Finding 2 — recurring `updaterCacheDirName is not specified` + cache churn (severity: MEDIUM).**
`scripts/generate-app-update.mts` hand-generates `app-update.yml` with only `provider` + `url`. Because `updaterCacheDirName` is absent, electron-updater derives its cache dir from `app.getName()` — so the cache dir churned `ConcordVoice`→`Concord Voice` across the revert (logged as "Unable to locate previous update.zip … is this first install?"), orphaning the prior cache. The ERROR is logged on every download.

**Finding 3 — no differential downloads; every update is a full ~122 MB download (severity: MEDIUM, efficiency).**
The build uses **electron-forge + `@electron-forge/maker-zip`** (`forge.config.ts:160`), **not** electron-builder. `.blockmap` files are an electron-builder-only artifact, so they are never produced. electron-updater requests `<zip-url>.blockmap`, gets 404, and falls back to a full download every time. The release-upload glob ([`build-desktop.yml:1177`](../../.github/workflows/build-desktop.yml)) and the manifest generator also do not handle blockmaps. The Go server (`internal/updates/handler.go`) is already correct — it would serve blockmaps if they existed.

### The naming surfaces today (fragmented across three forms)

| Surface | Current value | Source |
|---|---|---|
| Display name (`.app`, UI, taskbar) | `Concord Voice` | `productName` + `packagerConfig.name` (forge.config.ts:101) |
| `userData` dir | `Concord Voice` (spaced) | `app.getName()` ← `productName` |
| Updater cache dir | `Concord Voice` (spaced) | `app.getName()` (no `updaterCacheDirName`) |
| Logs dir | `ConcordVoice` (spaceless) | **hardcoded** (updateLogger.ts:38,41) |
| Windows install/registry | `ConcordVoice` | `MakerSquirrel` name in `forge.config.ts` — **as of 2026-06-02; replaced by NSIS under ADR-0034** |
| Linux executable / package | `concord-voice` | maker options |

`updateLogger.ts` already proves the pattern: a path surface **pinned independently of `productName`**. The fix generalizes that precedent.

## Decision

**Principle: path-identity MUST be pinned independently of the display name, and MUST be immutable across releases.** A display-name edit must never be able to move a data directory again.

Canonical target end-state:

| Surface | Target value | Mechanism | Change |
|---|---|---|---|
| Display name | `Concord Voice` | `productName` / `packagerConfig.name` | **none** (keep) |
| `userData` dir | `ConcordVoice` | `app.setPath('userData', join(app.getPath('appData'), 'ConcordVoice'))` before `app.whenReady()` | **NEW pin** |
| Updater cache dir | `ConcordVoice` | `updaterCacheDirName: ConcordVoice` in generated `app-update.yml` | **NEW pin** |
| Logs dir | `ConcordVoice` | hardcoded (`updateLogger.ts`) | none (already pinned) |
| Windows / Linux | `ConcordVoice` / `concord-voice` | maker options | none (already correct) — *Windows half superseded by [ADR-0034](0034-windows-nsis-migration.md)* |

Concrete decisions:

**D1 — Pin the updater cache dir.** Add `updaterCacheDirName: ConcordVoice` to `renderAppUpdateYaml()` output in `generate-app-update.mts` (and update the test that asserts exactly two keys). This decouples the updater cache from `productName` permanently and removes the recurring ERROR. *Low cost, low risk; resolves Finding 2 and is safe to ship independently.*

**D2 — Explicitly pin `userData` (do NOT rely on `productName`).** A dedicated `src/main/pinUserDataPath.ts` calls `app.setPath('userData', join(app.getPath('appData'), 'ConcordVoice'))` as an import-time side effect and is imported **FIRST** in `main.ts`. It cannot be a statement in `main.ts`'s body: `tokenManager.ts`, `machineId.ts`, and `updater.ts` compute their `userData`-derived path constants at module-load time, and in ESM those imports fully evaluate before `main.ts`'s body runs — so a body-level `setPath` would be too late (the consumers would capture the unpinned path). `migrateUserData()` (D3) then runs after the pin. This severs the userData↔`productName` coupling that caused Finding 1, making the path immune to any future display-name change.

> **Decided (2026-06-02): D2.** Pin `userData` explicitly via `app.setPath`; the display name stays `Concord Voice`. Rejected D2-alt (revert `productName`) because it leaves path-identity coupled to a mutable display string — the same bug class would recur on any future `productName` edit.

**D3 — Harden the one-time migration to consolidate into the pinned dir.** The current migration cannot handle the post-revert reality (two divergent trees coexist). Redesign `migrateUserData()` to:
1. Resolve the canonical target = the pinned `ConcordVoice` dir.
2. Enumerate legacy candidates: the spaced `Concord Voice` dir, plus whatever `app.getName()` would currently resolve to if different.
3. Pick the **live** candidate by a liveness heuristic — the dir with the newest `secure-token.dat` (fallback `token-meta.json`) mtime.
4. If the live candidate is already the target → done. Otherwise, move the live candidate's contents into the target, **archiving** (never deleting) any pre-existing target content with a timestamp suffix (mirrors the existing `Cache.bak-<ts>` pattern already seen on disk).
5. Because keys are server-escrowed (Finding 1 blast-radius), the migration is **best-effort UX**, not correctness-critical: a wrong guess costs at most one extra re-login, never data. Favor conservative, non-destructive moves.

**D4 — Differential downloads (blockmap): track, don't rush.** Two options:
- **D4-a (recommended fix):** generate electron-builder-format `.blockmap` files for the macOS `.zip` as a CI post-`make` step (via the `app-builder` blockmap tool), add `blockMapSize` to the generated `latest-mac.yml`, and add `*.blockmap` to the release-upload glob + sync. Keeps electron-forge. Differential downloads begin once two consecutive releases both carry blockmaps.
- **D4-b:** migrate the updater artifact to electron-builder (large toolchain change — rejected for now).
- **D4-c (interim):** accept full downloads; document the egress cost.

> **Decided (2026-06-02): D4-a (implement now).** Wire up electron-builder-format `.blockmap` generation in CI now rather than deferring — the per-update egress saving (~122 MB → changed-block delta, multiplied across users × release cadence) is worth the build-pipeline work. Differential downloads begin once two consecutive releases both carry blockmaps.

> **Implemented by #1292 (2026-06-15).** Blockmaps are generated in the **release job** of `build-desktop.yml` (not the build job, as originally sketched) via the `app-builder-bin` devDependency, run against the *normalized* macOS `.zip` after `Normalize artifact filenames` and before manifest generation — so the `.blockmap` is correctly named (`ConcordVoice-<v>-macos-<arch>.zip.blockmap`) with no build-job changes. `latest-mac.yml` advertises `blockMapSize` via an optional field in `schemas/update-manifest.json`; `*.blockmap` is attached to the GitHub Release and rides `sync-releases.yml` unchanged to `/opt/concord/releases/`. `internal/updates/handler.go` serves it as `application/octet-stream` (unchanged — default branch). **Bootstrap (verified against electron-updater 6.x):** the macOS differential downloader only attempts a diff when the client already holds a cached `update.zip`, and it needs the *previous* version's blockmap — read from the client-local `current.blockmap` cache, or (fallback) fetched from the server. Because `current.blockmap` is empty until the first post-blockmap update completes, AND `sync-releases.yml`'s `rsync --delete-after` retains only the latest release's blockmap (so the server-fetch fallback 404s), differential downloads engage from the **second** consecutive update a client receives after this feature ships — the first populates the local cache. The fallback is always a safe full download — not a regression. Realized byte-savings are unmeasured and not guaranteed positive (post-hoc blockmap over a forge-built zip — see #1292 spec §7). Server-side N-1 blockmap retention (to engage the diff one hop earlier) lands in the lockstep companion PR #1564.

## Consequences

**Positive.** The three path surfaces (userData, updater cache, logs) converge on a single immutable `ConcordVoice` identity, decoupled from the freely-editable display name. The recurring updater ERROR disappears. Future display-name changes become safe. Differential downloads become possible (under D4-a), cutting per-update egress from ~122 MB to the changed-block delta.

**Negative / cost.** D2 + D3 require a careful, tested migration (the both-trees-exist conflict is the hard case). There is a **one-time, acceptable re-login** for users still split across two trees as they consolidate onto the pinned dir. Orphaned legacy trees are archived, not deleted, so disk usage temporarily grows (a later grace-period cleanup, with secure-wipe of `secure-*.dat`, is a follow-up).

**Verification requirements.** Migration unit tests must cover: only-spaced, only-spaceless, **both-exist (pick newest)**, neither, and archive-on-conflict. Manual cross-update test from a v0.1.37 build to a build carrying this change, asserting no second logout after the consolidating launch.

**Revisit when:** a future feature needs a new path surface (it must adopt the pinned identity, not `app.getName()`). (D4-a — differential downloads — is now implemented per #1292; the remaining egress-efficiency question is measuring realized byte-savings and the server-side N-1 blockmap retention companion PR #1564, not whether to do D4-a.)

## Out of scope (tracked separately)

- **`ReplaceMyKeys` / `public_keys` silent E2EE break (recommend a dedicated security issue + e2ee-reviewer).** During the Finding 1 blast-radius trace, the login key-recovery path (`Login.tsx:295-328`) was found to generate a fresh RSA keypair on unwrap failure and call `ReplaceMyKeys` (`users/handlers.go:235-240`), which updates `user_keys` but **never `public_keys`** and never clears stale wrapped `channel_keys`/`dm_channel_keys`. Peers then re-wrap channel keys to the orphaned old public key (`GetPublicKey`, `handlers.go:859-863`), producing **permanently-undecryptable** messages with 200 OKs throughout. Low trigger probability (unwrap-failure path only), high impact when hit. Contrast the correct `RecoveryResetAccount` (`auth/handlers.go:2179`) which atomically rotates `public_keys` AND clears stale wrapped keys behind an explicit data-loss acknowledgment. **Not** a naming/update concern — handle on its own track.
- **Misleading "Safety backup created" log on macOS** (`updater.ts:356` — no backup exists on macOS; Squirrel.Mac handles atomicity). Trivial reword (`Safety sentinel written`); boy-scout fix.
- **Transient `net::ERR_NAME_NOT_RESOLVED`** on scheduled checks (2026-05-30) — environmental, already handled gracefully; no action.

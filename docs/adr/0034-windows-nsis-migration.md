# 0034 — Windows packaging: migrate from Squirrel.Windows to NSIS

**Status:** Accepted
**Date:** 2026-07-25
**Decided:** 2026-07-25 — migrate to NSIS with the install directory pinned to `%LOCALAPPDATA%\ConcordVoice\app`, built by a locally-owned Forge 7 maker over `app-builder-lib` (exact-version-pinned), per repo-admin direction.
**Issue:** #2402 · parent epic #1323 (desktop auto-update delivery hardening) · public report [Concord-Voice/Concord-Voice#80](https://github.com/Concord-Voice/Concord-Voice/issues/80)
**Supersedes:** the Windows half of [ADR-0020](0020-desktop-app-naming-and-update-cache.md)'s end-state table — the row recording Windows OS-package identity as **"none (already correct)"**. It was correct as an *identity* claim and wrong as a *sufficiency* claim; see Context.
**Related:** [ADR-0020](0020-desktop-app-naming-and-update-cache.md) (path-identity pinning), ADR-0026 (Linux update signing), ADR-0032 (desktop release signing trust isolation), [ADR-0004](0004-desktop-release-contract.md) (desktop release contract)
**Spec:** `2026-07-25-2402-windows-nsis-migration-design.md`

> **Addendum (PR #3794, 2026-10-14):** the local maker now runs under Forge 8 (`@electron-forge/maker-base` ^8.0.1), and the published wrapper still throws under Forge 8 for the same reason. "Forge 7" below is the version this decision was made against.

## Context

Selecting **Restart** after a downloaded Windows update closed the client and never relaunched. The installer left in `%LOCALAPPDATA%\ConcordVoice\pending\` also failed when the user double-clicked it directly — and the same file succeeded when moved to `Downloads\`.

### Root cause — established by three controlled trials, not inferred

Three trials on a live Windows install (2026-07-24), each capturing `%LOCALAPPDATA%\SquirrelTemp\SquirrelSetup.log`:

| Trial | Installer location | App state | Result |
|---|---|---|---|
| 1 | `ConcordVoice\pending\` | running | **fail** |
| 2 | `ConcordVoice\pending\` | fully exited (`Stop-Process -Force`) | **fail**, byte-identical to Trial 1 |
| 3 | `Downloads\` | fully exited | **success** — installs and relaunches |

Trials 1 and 2 die on the same sequence:

```text
info:  About to install to: C:\Users\<user>\AppData\Local\ConcordVoice
warn:  Install path C:\Users\<user>\AppData\Local\ConcordVoice already exists, burning it to the ground
error: Failed to remove existing directory on full install, is the app still running???:
       System.UnauthorizedAccessException: Access to the path
       'C:\Users\<user>\AppData\Local\ConcordVoice\pending\ConcordVoice-0.2.32-windows-x64-Setup.exe'
       is denied.
fatal: Finished with unhandled exception: System.AggregateException ...
```

**The installer could not delete itself.** Squirrel's `Setup.exe` unconditionally recursive-deletes its install root before writing. That root contained `pending\<the installer>.exe` — the running process's own image, which Windows locks. The delete threw `UnauthorizedAccessException`, the exception was unhandled, and the process died. That is the "hidden window flashes and disappears" the reporter described.

Two things the trials settle that inference would have gotten wrong:

- **App liveness is irrelevant.** Trial 2 failed byte-identically with the app fully exited, so Squirrel's own `is the app still running???` diagnostic is misleading. The locked file is the installer, not the app.
- **The location is the whole variable.** Trial 3 succeeded from `Downloads\` with no other change.

### Why the collision existed

Two individually-correct decisions, made in different files:

- `scripts/generate-app-update.mts` pins `updaterCacheDirName: 'ConcordVoice'` — **ADR-0020 D1**, adopted precisely so a mutable `productName` could not churn the update cache (the v0.1.38 regression).
- `forge.config.ts` set `MakerSquirrel({ name: 'ConcordVoice' })`, which made `%LOCALAPPDATA%\ConcordVoice` Squirrel's `rootAppDir`.

electron-updater composes its cache as `baseCachePath` + `updaterCacheDirName` + `pending`, and `baseCachePath` is `%LOCALAPPDATA%` on win32. Both surfaces therefore claimed the same identity string, and the cache landed *inside* the install root. On macOS and Linux this is harmless — no installer wipes its own root — which is why it passed review and why ADR-0020's table row is the specific line this ADR supersedes: Windows OS-package identity was indeed `ConcordVoice` and required no *renaming*, but "already correct, no change required" also read as a sufficiency claim about the Windows packaging target, and that claim was false. **ADR-0020's principle is not being reversed; it is being completed.** Pinning path-identity was right; what was missing is that on Windows the install root and the updater cache must not be the *same* pinned directory.

### The deeper mismatch

electron-builder documents auto-update as supported with the NSIS target but **not** with Squirrel.Windows, and recommends migrating. Concord was running exactly the unsupported pairing: Forge/Squirrel packaging behind electron-updater, which instantiates `NsisUpdater` on win32 and spawns the setup with NSIS lifecycle arguments (`--updated`, plus `/S`, `--force-run`, and `/D=` conditionally).

Trial 3 additionally revealed that a *successful* Squirrel update was a full wipe-and-reinstall (`burning it to the ground` → `CheckForUpdateImpl: First run, starting from scratch`), not an in-place upgrade. Consequence: **every** successful Windows update destroyed the electron-updater cache, including `current.blockmap`. Differential downloads were therefore **structurally impossible on Windows**, independent of #1292 — every Windows update was a full ~122 MB download, permanently. That had been invisible because #1292's design work reasoned about the macOS artifact chain.

## Decision

**Replace Squirrel.Windows with NSIS, and place the install directory in a subdirectory of the pinned identity so the updater cache is structurally outside it.**

```text
BEFORE                                    AFTER
%LOCALAPPDATA%\ConcordVoice\              %LOCALAPPDATA%\ConcordVoice\
├── app-0.2.32\        ← Squirrel wipes   ├── app\            ← NSIS $INSTDIR
├── Update.exe            this whole      │   └── Concord Voice.exe
├── packages\             tree, incl.     ├── pending\        ← updater cache
└── pending\           ← ...itself        └── (Squirrel residue, cleaned on next launch)
    └── Setup.exe      ← locked, delete throws
```

**D1 — NSIS as the Windows packaging target.** NSIS does not wipe its install root; it runs `uninstallOldVersion`, which looks up a registered electron-builder uninstaller in the registry and is scoped to `$INSTDIR`. It cannot reach a sibling directory. Install and cache become *structurally incapable* of colliding, rather than merely configured not to — which is the property worth having, because a configuration can be edited back.

**D2 — `$INSTDIR` pinned at build time, in the artifact.** `client/desktop/build/installer.nsh` defines a `customInit` macro setting `$INSTDIR` to `$LOCALAPPDATA\ConcordVoice\app`. It must be baked into the artifact rather than passed as a runtime `/D=`, because `installDirectory` is a property the *running* client sets on `NsisUpdater` and the migration hop is executed by the OLD Squirrel client, which sets none. A runtime `/D=` would take effect only from the second NSIS update onward — relocating an app already installed elsewhere, which is worse than either endpoint. NSIS's own default is not viable either: with `oneClick: true` + `perMachine: false`, `getWindowsInstallationDirName` takes the `sanitizedName` branch and derives a directory from `@concordvoice/desktop` rather than `Concord Voice`.

**D3 — A locally-owned Forge 7 maker, not the published wrapper.** `electron-forge-maker-nsis` is Forge-5-era: it exports a module-level `isSupportedOnCurrentPlatform` and a default-export *function*. Forge 7 discriminates class makers on `__isElectronForgeMaker` and otherwise falls to `new MakerClass(config, platforms)`; applying `new` to a function that returns a Promise yields that Promise, leaving `maker.platforms` undefined and throwing `TypeError` on the next line. electron-builder never updated the wrapper for the Forge 6 `MakerBase` migration. `client/desktop/build/makerNsis.ts` is therefore a local `MakerBase` subclass calling `app-builder-lib`'s `build()` **directly** — not its `buildForge()` helper, which spreads caller options *after* setting `config.directories.output` and would scatter artifacts outside `out/make`, breaking the CI signing glob and artifact normalization.

> **Rejected: adopt the published wrapper.** Verified unusable against Forge 7.11 before implementation, not assumed.

**D4 — `app-builder-lib` accepted as a signing-pipeline build dependency, exact-pinned.** It pulls a 214-package tree of which 48 are net-new (measured 2026-07-25), including targets Concord does not use (`dmg-builder`, `electron-builder-squirrel-windows`) that arrive as declared dependencies and cannot be pruned selectively. These are `devDependencies` with no runtime exposure in the shipped app — but the desktop build *is* the signing path (`desktop-release`, Azure Trusted Signing, Apple notarization; ADR-0032), so a compromised build-time dependency is a supply-chain concern, not a developer-convenience one.

> **Decided (2026-07-25, repo admin): accept, with two binding obligations.** (1) Declared with an **exact version, no caret**, so it cannot float onto `npm ci` and every change arrives as a reviewable dependabot PR through `/weekly-deps`. (2) Recorded in `.claude/rules/electron.md` §"Supply-chain hardening" as a signing-pipeline build dependency — the same governance shape already applied to the digest-pinned `node-buildtools` base image, so a reviewer touching it finds the rule before they find the surprise.

**D5 — Squirrel residue is cleaned from the installed app, never from the installer.** `src/main/squirrelCleanup.ts` runs on win32 from the `createWindow().then(...)` callback, `app.isPackaged`-gated and deferred one further tick via `setTimeout(…, 0)`. All three qualifiers are load-bearing: the sweep is *synchronous* recursive `rmSync` over `app-*` directories that can total hundreds of MB, so running it during `whenReady` would block the main-process event loop before first paint; and without the packaged gate a developer running `npm start` on a real Windows machine would have their genuine profile swept as a side effect of local development. An *installer* invoking `Update.exe --uninstall` would recursive-delete `ConcordVoice\` while itself executing from `ConcordVoice\pending\` — reproducing the exact fault this ADR exists to fix. Cleanup is an explicit allowlist (`Update.exe`, `packages\`, the `Concord Voice.exe` execution stub, `app-N.N.N\` version dirs, `SquirrelTemp\`, the `Concord Voice LLC` Start Menu company folder, and one exact `HKCU` uninstall key via `execFileSync('reg', …)` — never `shell: true`), never a wipe of `ConcordVoice\`. It skips `app` and `pending` unconditionally, is idempotent by existence check, and never throws or blocks startup. The Desktop shortcut is deliberately left alone: both installers write `$DESKTOP\Concord Voice.lnk`, so NSIS overwrites it in place and it self-heals; deleting it would race that overwrite.

**Explicitly unchanged:** `updaterCacheDirName: 'ConcordVoice'` (ADR-0020 D1) is untouched — the cache never moves, so macOS retains `current.blockmap` and its differential downloads are unaffected. macOS and Linux packaging and update paths are unchanged. `electron-squirrel-startup` remains a runtime dependency in `main.ts`; only the Forge *maker* was replaced. Windows update trust anchors are unchanged (Authenticode via `verifyUpdateCodeSignature` + `ALLOWED_WINDOWS_PUBLISHERS`, `publisherName` in `app-update.yml`, and the static public update feed).

## Consequences

**Positive.** The Windows restart-to-install path works on a packaging/updater pairing upstream actually supports. The install/cache collision is closed structurally rather than by configuration. The permanent-full-download finding is now documented rather than latent, and Windows differential downloads move from *impossible* to *not yet implemented*.

**Negative / cost.**

- **Concord now maintains a Forge↔electron-builder adapter.** Small (~40 lines) and fully owned, but real ongoing cost — accepted as preferable to depending on a wrapper abandoned two Forge majors ago.
- **48 net-new build-time dependencies in the signing pipeline**, mitigated by the exact pin, the `npm audit` gate, and the Shai-Hulud IOC scan (D4).
- **`*.nupkg` leaves the Windows release asset contract** — removed from `build-desktop.yml` (normalization, `required_assets`, attach/verify globs) and the public-mirror allowlist.
- **The NSIS-embedded uninstaller is unsigned**, because signing is a post-build step globbing `out/make`, so UAC shows "Unknown publisher" on uninstall. Not a regression — Squirrel's `Update.exe` was equally unsigned — but recorded rather than discovered later.
- **`artifactName` must end in `Setup.exe`** or the release signature-verification glob misses it; electron-builder's default does not.
- **Windows keeps full downloads.** This change does not restore differential updates, only unblocks them.

**`publisherName` nests under `win.signtoolOptions`.** Not at the config root, and not directly
on `win` — `WindowsConfiguration` is `additionalProperties: false`, so either wrong level makes
electron-builder's schema validator reject the *entire* config and the make dies before writing a
byte, failing every Windows release leg. Both wrong levels shipped in review and were caught only
by running a real build, because the maker's unit test mocks `build()` and a mock accepts any
shape. The schema error also misleads: `configuration.win should be one of these: null` is an
`anyOf` collapse reporting the surviving branch, not an instruction to remove `win`. The value is
inert here anyway — signing is a post-build step over `out/make` via Azure Trusted Signing
(ADR-0032), so electron-builder never runs signtool; the #2020 lockstep is enforced by
`generate-app-update.mts` and the certificate subject, not by this maker.

**Verification requirements.** There is **no pre-merge Windows CI**: `pr-smoke-build` is fixed macOS-arm64 by the ADR-0032 / #2274 trust split, and adding a Windows PR leg would cross that boundary. The packaging change first executes in a privileged `desktop-release` dispatch on `main`, and the migration hop first executes on users' machines. No CI leg produces a branch artifact to test with — `build-desktop.yml` is dispatch-only on `main` and `pr-smoke-build` uploads nothing — so the installer is built locally (plan Task 8 Step 1 carries the exact sequence, including the Node 24.18.0 pin that #1258/P17 makes load-bearing). The manual acceptance test is therefore the only real signal and is a **pre-merge** gate: on a Windows machine with the Squirrel-installed client, place the new NSIS installer in `%LOCALAPPDATA%\ConcordVoice\pending\`, run it with the arguments electron-updater actually passes (`--updated --force-run`), and confirm it installs to `…\ConcordVoice\app`, throws no `UnauthorizedAccessException`, and relaunches; then relaunch once more and confirm Squirrel residue is gone and `pending\` survives. If the hop misbehaves, every Windows user is stranded on a manual reinstall — which is why this is gated before merge, not verified after.

**Revisit when:**

- Windows differential downloads are wanted — that needs blockmap generation for the NSIS artifact, under epic #1323.
- The uninstaller-signing question is reopened (a build step that signs the uninstaller before NSIS embeds it).
- A future packaging change touches `$INSTDIR`. Setting it back to `$LOCALAPPDATA\ConcordVoice` re-nests the cache inside the install root and re-opens this exact failure class from a new installer.

## Out of scope (tracked separately)

- **Cached-update verification bypass** — #2455 (`risk: security`). Touches the same file, so sequence to avoid conflict.
- **Windows differential updates** — belongs under epic #1323, now that the permanent-full-download finding is documented.

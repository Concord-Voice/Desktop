---
description: Electron main process, preload, and desktop packaging rules
paths:
  - "desktop/src/main/**/*.ts"
  - "desktop/src/preload/**/*.ts"
  # The § app.asar payload boundary below governs these; without them the rule
  # would not attach when the files it constrains are edited.
  - "desktop/forge.config.ts"
  - "desktop/build/makerDmg.ts"
  - "desktop/scripts/verify-asar-payload.sh"
  - "desktop/scripts/verify-dmg-artifact.sh"
  - "desktop/scripts/verify-packaged-app.mts"
  - "desktop/scripts/verify-packaged-app.lib.mts"
  - "desktop/scripts/verify-packaged-app.test.ts"
  - "desktop/tests/unit/main/packagingIdentity.test.ts"
  - ".github/workflows/build-desktop.yml"
---

> **Imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** `client/desktop/` there is `desktop/` here. References to `services/control-plane/**`, `services/media-plane/**`, `docs/superpowers/**`, `docs/runbooks/**`, `docs/ci/quality-gate-definition.md`, the public-mirror overlay and its workflows, Alpha's org rulesets, and ADRs not under `docs/adr/` in this repo point at Alpha or the private ops repos. Use them for context; they are not files or CI in this repo.

# Electron Rules

## Security (Non-Negotiable)
- NEVER disable `contextIsolation` or `sandbox` — in any build, dev included. Do not gate `sandbox` on `app.isPackaged`: it controls the preload's Node access and the renderer's OS sandbox, not CORS or `file://` loads (that is `webSecurity`). Dev ran unsandboxed from #567 until this was measured unnecessary; the preload bundle requires only `electron` (`desktop/tests/integration/preload-sandbox-contract.test.ts`)
- NEVER enable `nodeIntegration`
- NEVER use `@electron/remote` — it was removed as a security anti-pattern
- Validate all IPC senders via `event.senderFrame.url` in main process handlers
- Expose minimal API surface via `contextBridge` — only what the renderer strictly needs

## Package and capture hardening

- Packaged builds use Electron Forge's `FusesPlugin` with `FuseVersion.V1` and
  exactly these five fuse values: `RunAsNode: false`,
  `EnableNodeCliInspectArguments: false`,
  `EnableEmbeddedAsarIntegrityValidation: true`, `OnlyLoadAppFromAsar: true`,
  and `EnableCookieEncryption: true`. Keep the two ASAR fuses paired. The
  Forge build dependencies `@electron-forge/plugin-fuses` and `@electron/fuses`
  are direct, exact-pinned development dependencies; do not mutate fuses after
  packaging or add additional fuses.
- Forge 8 (PR #3794) packages with `@electron/packager` 20, which changes two
  things in the signed macOS output while leaving the fuse bits and the
  fail-closed identity search unchanged. It writes an asar integrity digest
  into `Electron Framework` before signing (Electron 41+ enforces it at launch,
  and fails open while the slot is empty), so nothing may rewrite `app.asar`
  or `ElectronAsarIntegrity` after packaging. And `osxSign: {}` now takes
  `@electron/osx-sign` 2.x default entitlements, which add
  `personal-information.photos-library` to the main app and `cs.allow-jit` to
  the plugin helper. The helper already holds
  `cs.allow-unsigned-executable-memory`, which covers JIT. The Photos
  entitlement stays inert while `extendInfo` declares no
  `NSPhotoLibraryUsageDescription`. Do not add that key without deciding the
  entitlement on purpose.
- **CI reads the fuses and the asar integrity digest back from the PRODUCED
  app.** Both layers that set them fail open, so `forge.config.ts` and
  `packagingIdentity.test.ts` prove only what we asked for. After packaging,
  `pr-smoke-build` and all six `release-build` legs run
  `desktop/scripts/verify-packaged-app.mts` (change the two workflow
  copies together; the checks live in `verify-packaged-app.lib.mts`, which has
  its own unit test, and both files are in the `desktop-shell` paths-filter and
  in `classify-release.sh`):
  - `fuses` reads the wire from the packaged binary with `@electron/fuses`' own
    reader and asserts exactly the fuses `FusesPlugin` configures, **derived at
    run time from the plugin's `fusesConfig`** rather than from a second list,
    so a fuse added or flipped in `forge.config.ts` changes the expectation
    with it. It also scans the file for every fuse wire and requires them all to
    be identical, because `@electron/fuses` returns only the first. Fuses the
    config leaves unset are printed in the log but not
    asserted; they keep Electron's default, and the step log prints each one's
    actual state (`EnableNodeOptionsEnvironmentVariable` and
    `GrantFileProtocolExtraPrivileges` read ENABLE today), so changing one is a
    deliberate edit to the config and to this section.
  - `asar-digest` (macOS legs only) recomputes the SHA-256 over the sorted
    `ElectronAsarIntegrity` entries of the app's `Info.plist`, which is the
    packager's own algorithm, and requires **every** digest slot after the
    sentinel in `Electron Framework` to hold it. It fails closed on a missing
    sentinel, an unused slot (`used=0`, which Electron treats as nothing to
    enforce), a mismatch, or a plist with no entry. `@electron/packager` 20 and
    later write the digest; 18.x never does. The packager only warns when it
    cannot write it (no sentinel, unreadable plist, non-darwin host), which is why
    the artifact is checked.
  - Exit `1` means the artifact is wrong, including a binary whose fuse wire
    cannot be read; exit `2` means the check could not run (no or several
    packaged apps, a universal build or a fat Mach-O binary, an unusable config,
    `plutil` missing or not runnable, called off macOS). Both fail the job, and a
    check that cannot run never passes.
  - **Keep the entry file guard-less.** `verify-packaged-app.mts` is only
    `await main(...)`. The generator scripts gate their CLI on
    `import.meta.url === process.argv[1]`; on a verifier that comparison is a
    fail-open, because a path mismatch (a symlinked directory, drive-letter case,
    a tsx change to `argv`) skips `main()` and the step exits 0 having checked
    nothing. The unit test runs the entry for real, directly and through a symlink.
  - Scope: it reads the packaged app directory (`out/<name>-<platform>-<arch>`)
    that the installers and archives are built from, not the finished DMG, ZIP,
    NSIS, deb, rpm or AppImage. A universal macOS build is refused by directory
    name, and a fat (universal) Mach-O binary is refused whatever its directory
    is called (exit `2`, in `scanMarker`, so both scans): they find markers, not
    slices, so a slice with no fuse wire or no digest sentinel would pass unseen
    while Apple Silicon runs it. That was reproduced on a real lipo-built
    framework with one slice's sentinel destroyed. No leg builds one; supporting
    one means parsing the fat header and requiring a wire and a digest slot in
    every slice. Not read back: the integrity resource `@electron/packager`
    also embeds in the Windows executable, and Linux has no asar integrity
    support to check. The `asar-digest` mode covers the macOS framework digest
    only.
  - **The wiring tests skip only in the public mirror.** The mirror publishes
    `client/` but not the two workflows `verify-packaged-app.test.ts` parses, so
    that block skips where the overlay's `public-ci-frontend.yml` sits beside
    `.github/workflows/`. Anywhere else a missing workflow must fail; a test
    pins that the skip never applies where `build-desktop.yml` exists.
- The effective screen-capture protection preference is an exact boolean owned
  by the main process and defaults to `false`. Renderer settings are only a
  draft mirror: do not persist the value in renderer storage or create a second
  authority. Main reads its value before constructing main or PiP windows and
  calls `setContentProtection` before loading renderer content. Successful
  Apply persists first, then updates every live non-destroyed main and PiP
  window; future windows use the same main-owned value.
- Expose only narrow `get` and `set` preload methods. Both handlers require a
  trusted sender; the setter accepts only `typeof enabled === 'boolean'`.
  Invalid or untrusted requests have no side effects. Persistence or native
  window failures return failure and must leave the renderer draft pending.
  The setting is opt-in and never live-previews before Apply.
- `setContentProtection` is best-effort on macOS and Windows, not an absolute
  anti-screenshot or anti-recording guarantee. Current macOS ScreenCaptureKit
  clients can still capture protected windows, and Windows behavior depends on
  the Windows version and capture path. Do not expose this control on Linux or
  in older shells whose preload bridge lacks `getContentProtection`, and do not
  document stronger guarantees.

## app.asar payload boundary

Five entries are REQUIRED at the top level of the packaged `app.asar`: `dist/`
(built main, preload and renderer — everything resolves relative to `__dirname`
inside it), the dev-pruned `node_modules/`, `package.json`, `build/`
carrying **exactly two icons**, and `native/` carrying **exactly one file** —
the concord-audiocap loader (`native/concord-audiocap/index.js`). The addon's
own `.node` binary deliberately does NOT ship here; it reaches `<Resources>/`
via `extraResource`, because `dlopen`/`LoadLibrary` need a real path on disk and
everything inside the archive is virtual (ADR-0043 PR 5, #3194).

Three more are PERMITTED but not required, and only ever appear in CI:
`app-update.yml`, `buildtag.json` and `googleClientSecret.json` are generated
into the packager's dir root by `build-desktop.yml` immediately before Forge
runs, so a release archive legitimately has eight top-level entries where a
local `npm run package` has five. They also reach `<Resources>/` via
`extraResource`, which does not go through the ignore array, so the archive
copies are redundant rather than load-bearing — listed in the verifier's
`OPTIONAL_TOP` so their presence is a reviewed decision rather than unnoticed
residue. Nothing else may appear: everything else in `desktop` is
source, test, build-time or report-output material and is excluded by
`packagerConfig.ignore`. Established by #3156;
before it the archive carried the whole working tree, including `src/`, the test
suite, and the `.env` that `build-desktop.yml` writes one step before packaging.

Four properties are load-bearing, and each of them was got wrong once during
that PR's review — treat them as the checklist before editing the ignore array.

- **`@electron/packager`'s `DEFAULT_IGNORES` does not cover an app's own source
  tree.** It covers lockfiles, `.git`, `node_modules/.bin`, `.o`/`.obj` and
  `node_gyp_bins` — nothing else. An empty-ish `ignore` therefore ships
  everything. (The `out/` directory is excluded separately, by
  `userPathFilter`'s `ignoredOutDirs` check, which runs before and independently
  of the ignore array — supplying an array does not disable it.)
- **Every path pattern must be `^`-anchored.** The copy filter applies the same
  array to files under `/node_modules/` using `String.prototype.match`, which is
  unanchored. An unanchored `/tests/` or `/build/` would strip files out of
  production dependencies — a node-gyp addon's `build/Release/*.node` above all.
  There are exactly TWO deliberate exceptions, `/\.map$/` and `/\.d\.[cm]?ts$/`, and
  both are suffix rules on purpose: they name file kinds that are compile-time-only
  wherever they appear, so reaching into dependencies is the point rather than the
  hazard. The declaration rule matters more than it looks — `tsconfig.main.json`
  inherits `declaration` + `declarationMap`, so `build:main` writes `dist/**/*.d.ts`
  beside the `.js` it runs, and `/\.map$/` took only their `.d.ts.map` companions.
  957 of the 1035 declarations that had been shipping came from production
  dependencies, not from `dist/`. Before widening it there, confirm no shipped
  package resolves a RUNTIME entry point to a `.d.ts`; the one apparent
  counter-example is upstream mediasoup-client, whose `"./enhancedEvents"` export
  map reads `"ortc": "./lib/enhancedEvents.d.ts"` where it means `"types"`, and
  `ortc` is not a Node export condition, so resolution skips it and lands on the
  sibling `.js`. The `[cm]?` is load-bearing rather than defensive: a `.d.ts`-only
  draft still shipped 127 `.d.cts` / `.d.mts` files (~4.96 MiB) from dual-published
  dependencies. Match only the `.d.` form — a bare `.cts` / `.mts` is TypeScript
  SOURCE, and although the packaged tree happens to contain none (every one of the
  108 `.cts` and 19 `.mts` entries was a declaration), a rule that could strike
  source is a rule that will eventually strike something that matters.

  **Exempt these two by exact source string, never by regex shape.** The anchoring
  test keeps an allowlist for exactly this reason: a "no slash, ends in `$`"
  heuristic reads as robust — it survives a rewrite of either rule — but it also
  waves through a future `/\.node$/`, which would strip native addons out of
  production dependencies. Nothing downstream would catch that: the archive
  verifier's depth check knows only these same two suffixes, and its runtime probe
  opens three files under `dist/`. Under an allowlist a rewritten rule reds a test,
  which is a prompt to re-review an unanchored pattern rather than a silent hazard.
  A companion test asserts both rules are still PRESENT, so deleting one cannot
  make the anchoring test vacuously green.
- **`build/` is a PARTIAL exclusion and must stay one.** `src/main/main.ts` reads
  `build/icon.png` and `src/main/applicationsFolderGate.ts` reads
  `build/icon.icns` from *inside* the archive via `app.getAppPath()`. Both go
  through `nativeImage.createFromPath`, which never throws — a missing file
  yields an empty image, so an over-broad rule loses the branding silently in
  release builds and in no test. The rule is a negative lookahead, and it must
  **not** match the bare `/build` directory entry: the filter is consulted on a
  directory before it descends, so excluding the directory would stop the icons
  from ever being copied while every path-level assertion still passed.
- **`native/` is a PARTIAL exclusion for the same reason, and it is the more
  fragile of the two.** `build/` admits two leaf files under one directory
  level; `native/` admits one leaf under *two*, so BOTH `/native` and
  `/native/concord-audiocap` must stay admissible — by two DIFFERENT mechanisms, and
  conflating them hides what a future edit may safely change. The pattern's anchor
  `^\/native\/` requires a trailing slash, so it structurally cannot match the bare
  `/native` entry and the lookahead is never consulted there; only the SECOND level is
  admitted by the lookahead actually declining. (`forge.config.ts`'s inline comment
  states this correctly and is the authority; this sentence was the looser paraphrase.)
  Excluding either directory stops the descent and `index.js` is never copied, with every path-level
  assertion still green. The split is deliberate and not arbitrary: the opaque
  `.node` leaves the archive because `dlopen` needs a real path, while the loader
  JS stays inside it so executable code entering a Node-privileged process
  remains under `EnableEmbeddedAsarIntegrityValidation`. Do not "simplify" by
  shipping both via `extraResource` — that puts executable JS outside integrity
  validation on macOS and Windows. **Linux is not a third case where the split helps:
  Electron supports asar integrity on macOS (>=16) and Windows (>=30) and on Linux not
  at all**, so there the loader inside `app.asar` is already unvalidated and the split
  buys nothing. That is one more reason the addon is out of scope on Linux, not a gap
  to close. An earlier revision of this sentence read "Windows and Linux", which
  asserted a platform guarantee that does not exist. Do not widen the lookahead past
  `index.js` either; `verify-asar-payload.sh` asserts the exact `/native/` set,
  in both directions, exactly as it does for `/build/`.
- **`extraResource` does not go through the ignore array at all.** The packager
  copies those entries with a plain `fs.copy`, so `assets/tray`,
  `app-update.yml`, `buildtag.json`, `googleClientSecret.json` and
  `concord_audiocap.node` reach `<Resources>/` regardless of what the ignore
  patterns say. Excluding one of them from the archive does not remove it from
  the app; conversely, an ignore pattern can never be the reason a Resources file
  went missing. This asymmetry is what lets `native/` be split across the
  boundary at all — the `.node` and the loader are governed by two different
  mechanisms, so each can be placed independently.

**Assert the boundary on the produced archive, not on the config.** Unit
assertions over the regexes prove the config holds a value; they cannot prove
Forge honours it through path normalization, directory traversal and archive
construction. `build-desktop.yml`'s `Verify asar integrity` step does the real
check, and it exists in **both** `pr-smoke-build` and `release-build` — change
the two together. It asserts the top-level set AND, separately, that no file
matching either suffix rule survives anywhere in the archive (use `grep -E` there
— `[cm]?` is a literal `?` in a basic regex, so a BRE spelling matches nothing and
the check passes vacuously). Since #3194 the same step also asserts
`concord_audiocap.node` is a REGULAR, NON-SYMLINK, non-empty file in `<Resources>/`,
derived as `$(dirname "$ASAR")`. All three predicates are load-bearing: `[ -s ]` alone
is TRUE for a DIRECTORY, and a directory named `concord_audiocap.node` is precisely the
object `require()` resolves as a CommonJS package — the #3194 VULN-1 execution primitive
— so an `-s`-only assertion green-lights the exploit it is meant to exclude; `-f` alone
still admits a symlink to a regular file — `extraResource` lands it in the same directory as
`app.asar` on every platform, so that needs no path branching, and it is skipped
on Linux where ADR-0043 puts the addon out of scope. That assertion is the
`extraResource` half of this same principle, and it is not redundant with the
archive checks: the two mechanisms are independent (see the `extraResource`
bullet above), so the loader can ship inside `app.asar` with every asar assertion
green while the binary it loads is absent from the package. `existsSync` guards
the push in `forge.config.ts`, so a false guard or a deleted entry fails exactly
that way — silently, and only at runtime. That second,
DEPTH assertion is not redundant: the top-level set treats everything beneath
`/dist` and `/node_modules` as valid by construction, which is exactly how 1035
declaration files shipped through a green unit suite and a green archive check
at the same time. Two traps live in that step: `asar list` builds entries with
Node's platform-dependent `path.join`, so the Windows legs emit backslashes and
the listing must be normalized before matching; and `pr-smoke-build` is
macOS-only, so nothing in PR CI exercises the `release-build` copy on Windows or
Linux.

A third trap sits one level up, and extracting the check into
`desktop/scripts/verify-asar-payload.sh` is what opened it: the
`desktop-shell` paths-filter in the same workflow enumerates
`desktop/scripts/*` **file by file**, so a script that did not exist when
that list was written is not on it. A PR touching only the verifier then sets
`desktop-shell=false`, skips `pr-smoke-build` through the sentinel and goes
green — and a wrong expected-entry set or a broken normalization first runs in a
release build, on the Windows legs no PR job covers. The filter is the CANONICAL
source; `.github/scripts/classify-release.sh`'s `SHELL_FILES` is a hand-copied
mirror whose only sanctioned difference is `desktop/package.json`, and
`.github/scripts/tests/classify-release.test.sh` asserts exactly that symmetric
difference. Any new file under `desktop/scripts/` that CI depends on goes
in both lists, in the same commit.

## Linux packaging and Wayland launch

Linux DEB/RPM/AppImage builds must preserve Electron's sandbox. The packaged
`chrome-sandbox` helper is expected to be SUID-root (`4755`); fix packaging if
that bit is missing. Do NOT add `--no-sandbox` as a blanket Linux workaround.

Linux desktop entries rely on themed hicolor icons. Keep Linux maker `icon`
config resolution-keyed so package installers emit
`/usr/share/icons/hicolor/<size>/apps/concord-voice.png`; a single string icon
falls back to `/usr/share/pixmaps/` only and can disappear from Cinnamon/MATE
menus.

On Linux Wayland, avoid custom `titleBarOverlay` / hidden-titlebar CSD for the
main window. Fedora-family desktops have shown GTK assertion failures on that
path; use standard framed chrome on Wayland and keep the custom overlay for X11
and Windows.

## Video hardware-acceleration startup contract

Electron/Chromium's encoder factory is process-startup state. `main.ts` MUST read
the persisted `hw-accel.json` preference and apply it before `app.whenReady()`:
enabled requests `AcceleratedVideoEncoder`, `AcceleratedVideoDecodeLinuxGL`, and
`WebRtcAV1HWEncode`; disabled calls `app.disableHardwareAcceleration()`. A hardware
preference change therefore persists and relaunches the whole app. Codec/profile
and HDR target changes are renderer state and may re-produce active camera/screen
publishers without a relaunch.

These flags are requests, not proof that Chromium selected a particular hardware
encoder or HDR profile. The renderer's exact WebCodecs probes constrain eligible
targets, while active WebRTC stats (`powerEfficientEncoder`) are authoritative at
runtime; an explicit `false` demotes matching hardware targets for the session.

## IPC Pattern
- All renderer-to-main communication goes through the preload bridge (`src/preload/`)
- Structured IPC: define channel names as constants, type all payloads
- Main process handlers validate inputs before processing

### The two contract numbers (read this before bumping anything)

`ipcContract.ts` declares **`IPC_CONTRACT_VERSION`** — what this shell implements — and
**`SPA_MIN_CONTRACT`** — the oldest shell the renderer runs on. They are not the same
question and must never be synced.

Bump `IPC_CONTRACT_VERSION` whenever channels are added, removed, or change signature. That
is free: nothing consumes it as a requirement.

`SPA_MIN_CONTRACT` is the number `deploy-spa.sh` publishes and `spaLoader.ts` compares
against, so **raising it takes every shell below it onto its bundled renderer**. Raise it only
when the renderer genuinely cannot degrade. It almost always can:

```ts
// Guarded — an old shell loses the feature, not the whole remote SPA.
const fn = globalThis.electron?.newThing;
if (typeof fn !== 'function') return;
```

Every surface added between v20 and v25 is guarded this way, which is why the demand sits at
19 against a capability of 25. That six-version headroom is the SPA's whole value — it is what
lets renderer fixes reach users who have not updated. Spending it should be a deliberate,
justified act, and `classify-release.yml` fails any PR that raises the demand without shipping
a client in the same PR. See `deployment.md` § *Capability vs demand*.

### IPC contract v18 — auth lineage and credential custody

`IPC_CONTRACT_VERSION = 18` is a load-bearing shell/renderer compatibility boundary. Its auth rules must remain true across the control-plane response, main process, preload bridge, renderer, and their contract tests:

- **Refresh lineage is S1 → S2, not an unqualified token replacement.** The control plane returns the new `session_id` (S2) together with `previous_session_id` (S1); main/preload expose those as `sessionId` and `previousSessionId`. The renderer may rotate to S2 only when its captured session is S1 **and** its captured `authGeneration` is still current. A live generation alone does not authorize an arbitrary session replacement, and dropping `previousSessionId` from either the refresh result or `auth:token-refreshed` event breaks the lineage proof.
- **Renderer and main process have distinct CAS domains.** Renderer-owned `authGeneration` identifies the active renderer login/restore lifecycle; it advances for a replacement lifecycle or clear, but not for an accepted refresh rotation. Main-owned `CredentialOwner` identifies the stored refresh-credential lifecycle and is deliberately opaque: it is a CAS tag, not an authorization token, and renderer code may retain and return it to `auth:clearTokensIfOwner` or `auth:storeE2EEKeysIfOwner` but must never infer ordering or user identity from it. Refresh rotation preserves that owner. Owner-scoped clear and E2EE-key persistence ensure a stale login continuation cannot clear or overwrite a successor's refresh credential or E2EE custody.
- **SSO credential custody stays in main.** The API base supplied to `sso:appleSignIn` or `sso:googleSignIn` is an untrusted candidate; main accepts only the production SaaS origin, its current API origin, or a self-hosted origin the user has approved in the native ceremony (durably recorded), admitted via `isValidatedSelfHostedApiBase` — a successful probe admits nothing (#2354 / ADR-0035). One shared sign-in generation across both providers prevents an older Apple/Google completion from replacing newer credentials. Main runs the provider and control-plane session exchanges, stores the refresh credential, and returns only the access token, session ID, and opaque `CredentialOwner`. Raw refresh credentials and OAuth material must never cross into the renderer.
- **Keep the whole v18 surface in lockstep.** Changes to these shapes or channels must be synchronized in `ipcContract.ts`, main handlers/`tokenManager.ts`, preload declarations and bridge methods, renderer consumers, and tests. Do not feature-detect a partial v18 path or downgrade an owner-scoped operation to a generic pre-v18 credential/E2EE writer. A remote SPA that requires the surface must advertise the corresponding minimum `spaIpcContract`; an older shell falls back to its bundled SPA and updates. Bump the IPC contract when channels are added, removed, or change signature, but not for renderer-only implementation changes.

### IPC contract v19 — SSO MFA custody + owner-bound admission (#2424)

`IPC_CONTRACT_VERSION = 19` extends the v18 SSO custody boundary to the MFA
challenge path. Before #2424 the SSO MFA branch RELEASED the reserved owner and
the renderer stored the MFA refresh token through the unrestricted
`storeRefreshToken` path — a stale MFA continuation could then mint a new global
owner and overwrite a successor credential (CWE-345 / owner-CAS gap), and the raw
refresh token transited the renderer. v19 closes both:

- **The `mfa_challenge` sign-in result carries the reserved `CredentialOwner`.** `finishSignIn`
  (`ipc/sso.ts`) PRESERVES the owner reserved at sign-in across the challenge (stores a
  `pendingMFA` state) instead of clearing it, and returns it as opaque challenge context.
  `MainSSOSignInResult` (`oauth/ssoFlowShared.ts`) deliberately OMITS the owner from its
  `mfa_challenge` variant — the flow parser (`mapSessionResponse`) runs before an owner exists,
  and `finishSignIn` mints/attaches it. Do NOT move owner minting into the flow parser.
- **`sso:completeMFA` completes the MFA exchange IN MAIN.** The handler validates the sender frame
  (`checkFrame`/`isPermittedFrameUrl`), the approved API origin (`approvedApiBase`), the reserved
  owner (must match `pendingMFA` — mismatch is a fail-closed 409 with no fetch or store), and the
  bounded payload (`isCompleteMFAPayload`); then POSTs `/api/v1/auth/mfa/verify` with the machine-id
  header, stores the resulting refresh credential under that owner via `storeRefreshTokenIfOwner`,
  and returns ONLY `{accessToken, sessionId, credentialOwner}`. **No SSO MFA refresh token crosses
  the main→renderer boundary, and the unrestricted generic writer is never used by SSO completion.**
  The verify POST carries a 30 s `AbortSignal.timeout` (#3423), and it must stay HERE, not in the
  renderer. The renderer disables the challenge's Cancel while a proof is in flight, so the call has
  to settle; but a renderer-side race cannot stop main from storing a late credential that no
  session then admits, and that a Cancel cannot release. A timeout returns
  `sso_mfa_verify_failed` and stores nothing, and a body cut mid-read parses to null and is revoked.
  The renderer's own verify POST for the other purposes carries the same bound. The best-effort
  logout that follows a failed completion (`revokeCookieBoundSession`) has its own 10 s bound, a
  recorded trade-off: a slow but live logout can be abandoned, leaving a server session whose
  cookie stays in the jar until it expires. The alternatives are worse. Fire-and-forget, or a
  longer bound, would let a late logout response land after a NEWER sign-in and clobber its
  cookie. Keep the 10 s bound awaited.
  The renderer shows readable text for a failed proof, never a bare code. It prefers the server's
  `error` text, maps main's own codes (`sso_mfa_verify_failed`, `sso_cancelled`,
  `sso_session_rejected`) to copy, and falls back to a generic message.
- **Owner-bound, gate-before-auth admission (renderer).** Both SSO admit paths arm the E2EE
  `needsSSOUnlock(true, owner)` gate BEFORE publishing authenticated state, so a synchronous
  auth-store subscriber cannot observe a non-null access token with the gate false; a lost
  currentness check rolls the gate back ONLY while it still belongs to that owner. Modal completion
  is bound to its challenge token so a stale challenge-A result cannot settle challenge B. These
  renderer invariants are detailed in [e2ee.md](e2ee.md) § "Owner-bound SSO admission".
- **Keep the whole v19 surface in lockstep** (same discipline as v18): `ipcContract.ts`, `ipc/sso.ts`,
  `oauth/ssoFlowShared.ts`, `preload.ts`, `shared/sso.ts`, `renderer/services/system/ssoService.ts`,
  `stores/auth/mfaChallengeStore.ts`, `components/Auth/MFAChallengeModal.tsx`, `hooks/ui/useSSOFlow.ts`, and
  their tests. The MFA modal is SHARED with the password / suspicious-refresh purposes; only the
  `sso_login` purpose routes through `sso:completeMFA` — the other purposes keep the renderer-side
  `/auth/mfa/verify` POST.

### IPC contract v20 — SPA fallback diagnostic classification (#2401)

`IPC_CONTRACT_VERSION = 20` made the `app:configFetchFailed` payload's `kind` field
(`'unreachable' | 'rejected' | 'contract'`, the `SpaFallbackDiagnostic` shape in
`shared/spaIpcTypes.ts:94`) available so the renderer can tell which of the six
`isUnexpectedBundled` conditions fired — only `'unreachable'` is falsified by proof of
reachability, while `'rejected'` (a refused `spaUrl`, incl. the #750 poisoned sentinel) and
`'contract'` (shell older than the deployed SPA) fire against a REACHABLE server, so retracting
them on connectivity would silence a fail-loud sentinel. The field is additive and a renderer that
receives no `kind` fails closed to non-retractable — i.e. degrades exactly to v19 — so the
server's `spaIpcContract` stayed 19 while the SHELL version bumped (the payload signature changed;
the two numbers are independent, and a 20-shell still satisfies a 19-minimum). See
`desktop/src/main/ipcContract.ts:114-130` for the authoritative per-version note — this
rules file records invariants, and the constant is the source of truth for the current value.

### IPC contract v21 — orphaned SSO reservation release (#2394)

`IPC_CONTRACT_VERSION = 21` (`ipcContract.ts:153`) adds one zero-argument channel,
`sso:abandonReservation` (`ipc/sso.ts:692`), which releases a credential reservation that has
**no live main-process continuation** so the pre-credential `auth:storeE2EEKeys` staging lane
reopens for password registration.

- **The governing invariant is reservation lifetime = continuation liveness.** A reservation exists
  to say "an SSO flow with a live continuation in main holds the exclusive right to mint the next
  credential." Liveness is main-observable: an in-flight sign-in promise, a `pendingCompletion`, or
  a `pendingMFA`. A reservation with none of those is an *orphan* — it asserts occupancy that no
  flow will ever exercise, and before #2394 nothing ever retired it. Read alongside the v19 section
  above: #2424 fixed the reservation dying too early (a released owner forced the renderer onto the
  unrestricted `auth:storeRefreshToken` path), and #2394 fixes it never dying at all. Both fall out
  of the one invariant, so the `mfa_challenge` branch in `ipc/sso.ts` and its comment are
  deliberately byte-unchanged by #2394 — that branch preserves the owner because the challenge is
  *live*, which the invariant already requires.
- **The renderer carries no authority on this channel.** It takes no owner and no target; main
  resolves everything from its own `reservedCredentialOwner` / `pendingCompletion` / `pendingMFA`,
  matching the `spa:reloadLatest` posture. What the renderer gains is strictly narrower than
  `auth:clearTokens`, which is already renderer-invokable and wipes a *published* credential
  unconditionally. It cannot wipe a published credential, steal or redirect a mint, inject keys
  into an owner-scoped publish, or forge the sender frame.
- **`clearTokensIfOwner` is disqualified as the release primitive — do not "simplify" back to it.**
  That primitive (`tokenManager.ts`) CAS-checks the generation only, and `publishRefreshToken`
  deliberately preserves the generation across a rotation. A stale abandon arriving after a
  successful SSO completion would therefore pass its CAS and wipe the just-stored live credential,
  handing the renderer a self-logout primitive. `releaseCredentialReservation`
  (`tokenManager.ts`) instead requires the same triple `storeRefreshTokenIfOwner` requires —
  reserved, current-generation, and **no published credential** — which makes that case
  structurally unreachable. Be precise about which clause does that work: `publishRefreshToken`
  nulls `reservedCredentialOwner` in the same synchronous block that sets the token, so after a
  publish the FIRST clause already short-circuits — the no-published-credential clause is
  defense-in-depth against a future writer that sets a token without clearing the reservation, a
  state no current path can reach and therefore no test can construct. The "no-op after a
  credential is published" test in `tests/unit/services/tokenManager.test.ts` asserts the outcome
  but exercises clause one; it is **not** a lock on the swap, and would not catch a rewrite to
  `clearTokensIfOwner` guarded by a null check. This paragraph is the guard against that rewrite.
- **The handler returns `false` on an untrusted sender frame instead of throwing**, unlike its
  sibling `sso:*` handlers. It is invoked from `Register.handleSubmit`
  (`renderer/components/Auth/Register.tsx:162`), where a throw would convert a fail-closed
  *release* into a fail-closed *registration*. Precedent: `auth:getCapabilities`
  (`main.ts:1525`). Do not copy this shape into a channel where a throw is required. The frame
  check is the first statement and the handler has no `await`, so `event.senderFrame` is read
  immediately — this channel fires while the renderer is transitioning between auth screens, the
  riskiest window for a null frame — and it stays ahead of the pending discard so an untrusted
  call mutates nothing. The discard itself is gated on a **successful** release: a release that
  returned `false` changed nothing and must destroy nothing, or a stale abandon sitting in the IPC
  queue could wipe a NEWER sign-in's live `pendingMFA` / `pendingCompletion`. A successful release
  bumps the credential generation, which already terminally fails every continuation bound to it,
  so clearing them there is cleanup of provably dead state.
- **The renderer helper is time-bounded.** `abandonSSOReservation` (`renderer/services/system/ssoService.ts`)
  races the invoke against a 3s timer and resolves `false` on expiry. The helper cannot reject, but
  `ipcRenderer.invoke` can fail to SETTLE if the main process is wedged — and `Register.handleSubmit`
  awaits it before anything else, so an unsettled promise would hang the submit with `isSubmitting`
  stuck true and no error surfaced. A timeout yields the same `false` an older shell gives, so
  registration proceeds either way.
- **Skew: the server's `spaIpcContract` stays 19.** The channel is additive, and `spaLoader` treats
  the server value as a hard minimum, so raising it would fall every shell below 21 back to its
  bundled build. A newer SPA calling this channel on an older shell degrades to the pre-#2394
  behavior — E2EE keys stay session-only, recoverable by unlock or re-login — and **never** to a
  weaker or unowned credential writer. That distinction is the point: the partial-path prohibition
  in the v18 section targets feature-detecting a *downgrade of a custody guarantee*, which this is
  not.
- **An SSO MFA challenge that ends not-verified releases its reservation** (#3423).
  `useSSOFlow`'s `handleSSOMfaResult` releases it on every such ending: a Cancel, another challenge
  replacing it, or an empty token. The modal's Cancel also releases it first, so a Cancel releases
  twice. The repeat is intended and harmless: the second `sso:abandonReservation` finds no
  reservation, returns `false` and discards nothing. Keep both calls. The release runs only after
  `reservationIsCurrent`. A retried sign-in bumps `authGeneration` before it clears the old
  challenge, so the old flow's continuation cannot release the retry's reservation.

### IPC contract v25 — friend-code deep links (#945) and the deep-link carry (#2363)

**v25 (#2363)** adds ONE renderer→main channel, `deeplink:forget` — zero-argument,
sender-fenced, and forget-only. It exists because forgetting and destroying
credentials had been the same act: every path that forgot deep links did so as a
side effect of `auth:clearTokens`. One teardown must do the first without the
second — a `rememberMe` refresh failure runs `gracefulReset()` and deliberately
leaves the disk tokens for the next launch to retry — and before this channel that
path left main's copy live, so a different account signing in inside the carry
window replayed the previous user's invite. The channel is the smallest thing that
separates the two acts; widening `auth:clearTokens` again could not, because its
whole contract is that it clears credentials.

**v24 (#2363)** is a SIGNATURE change, not a new channel: `auth:clearTokens`
accepts an optional `{ keepDeepLinks?: boolean }`. It bumps because this file's
own rule says a signature change bumps — the first draft added the argument
without one. The **default forgets** and login-side callers opt out, because an
older SPA on this shell sends no argument at all and must land on the safe side:
keep-by-default would replay user A's invite into user B's session through a
forced logout, where forget-by-default costs that SPA an invite the user recovers
by clicking the link again. The server's `spaIpcContract` stays 19 — nothing here
is REQUIRED of the SPA, which is exactly why the default was inverted rather than
versioned and left permissive.

**v23 (#2468)** is content protection — `app:getContentProtection` /
`app:setContentProtection`, covered in the capture-protection section above and in
`ipcContract.ts`'s History. Noted here only so the sequence does not read as a
lost version.

**v22 (#945).** `IPC_CONTRACT_VERSION` added one main→renderer channel and one
renderer→main channel for `concord://friend/CODE` deep links:
`deeplink:friend-code` (`{ code }`) and `deeplink:renderer-ready`.

- **A SECOND channel, never a widened `invite:received` payload.** `spaLoader`'s
  version gate is one-directional — it refuses an SPA *newer* than the shell but
  loads an older one indefinitely — and `SPA_IPC_CONTRACT` is an operator-set,
  hot-reloadable env var, so the skew window is unbounded by deploy. A
  `{ kind, code }` payload on `invite:received` would reach a pre-22 SPA that
  ignores the unknown field and opens the SERVER-join modal holding a friend
  code. On its own channel that SPA simply never subscribes and the deep link
  no-ops. The same reasoning gives the two kinds **independent readiness flags**:
  a shared flag would let an old SPA's invite subscription vouch for a friend
  subscription it never made.
- **Queues are PER KIND, not one tagged queue** (`Record<DeepLinkKind, string[]>`
  in `main.ts`). One shared queue let a friend-code burst spend the invite
  allowance and evict a user's real invite. Do not re-merge them.
- **The emit gate holds a bounded FIFO, released one code per one-second window**
  (`DEEP_LINK_HELD_MAX`). It replaced a single newest-wins slot that silently
  dropped every code between the first and the last of a burst. An overflow drops
  the OLDEST and logs it — kind and reason only, never the code, which is bearer
  material. A lifecycle reset clears the timer and re-queues whatever was held;
  leaving the timer live delayed a fresh renderer's first delivery by up to a
  second and could re-deliver a code the previous renderer had already consumed.
- **A held code does not outlive its session.** The renderer clears held
  deep-link state at the `accessToken → null` edge, NOT on an `authGeneration`
  change — `beginAuthLifecycle` advances the generation on LOGIN too, and keying
  on it would discard the code at the exact moment the hold-and-replay is meant
  to deliver it. Without the logout clear, a code clicked on a shared machine
  replayed into whichever account signed in next.
- **The server's `spaIpcContract` stays 19.** The channels are purely additive
  (v9/v10/v20/v21 precedent); raising it would fall every older shell back to its
  bundled build. A shell without them simply never delivers the friend deep link.
- **A DELIVERED code is carried across a main-INITIATED source swap, and only
  that** (#2363). `resetDeepLinkDelivery` re-queues `gate.held` but discards
  `gate.lastCode`. That is correct for an ordinary reload — the renderer consumed
  that code — and wrong for the two navigations main performs on its own
  initiative (`scheduleSpaSourceRetry`, `spa:reloadLatest`), where the modal is
  destroyed before the user could act and the invite vanished with no signal.
  Those two sites, and no others, wrap `applySpaDecision` in
  `applySpaDecisionCarryingDeepLink`, which raises a module-level DEPTH COUNT on
  entry and releases it in a `finally`. A count, not a flag: two main-owned swaps
  can overlap (a `spa:reloadLatest` click landing inside a background
  `scheduleSpaSourceRetry` await, and `applySpaDecision`'s own remote→cache→bundled
  fallback navigating twice), and a boolean was spent by the FIRST reset inside
  that await, so main's own navigation carried nothing and #2363 reproduced
  silently. The release tokens are EPOCH-fenced, because `forgetDeliveredDeepLinks`
  zeroes the depth while tokens from in-flight swaps are still outstanding; without
  the epoch a pre-logout token could fire later and disarm a subsequent carry
  mid-await. `loadPackagedRenderer`'s own call is deliberately NOT wrapped: it is
  the window's first load, so there is never a delivered code to carry. Making
  `resetDeepLinkDelivery` re-queue `lastCode` unconditionally instead re-opens the
  modal after every reload for a code the user already acted on.
- **The carry can outlive a session, so every LOGOUT path forgets** (#2363, and
  the reason the M4 invariant above needed extending into main). The carry
  re-delivers *from main*, after the renderer's `accessToken → null` clear has
  already run — so user A's code could reach user B via renderer-invokable
  `spa:reloadLatest`. `forgetDeliveredDeepLinks()` therefore fires from
  **`auth:logout` always, and from `auth:clearTokens` UNLESS the caller passes
  `{ keepDeepLinks: true }`**. Those are the two CREDENTIAL-ENDING callers and the
  scope of the claim in this bullet; **they are not the only callers of the
  helper.** Two more forget without ending credentials, and both came later:
  `deeplink:forget` (v25), which exists precisely to separate the two acts, and
  `fenceDeepLinksOnOwnerChange`, which discards a retained code when a different
  credential owner becomes current. The invariant is *"every logout path
  forgets"*, never *"only logout paths forget"*. **The default FORGETS and
  the login-side callers opt out**; an earlier draft had that backwards, and the
  direction is the contract. `auth:clearTokens` has exactly THREE renderer
  callers. Two are login-side and opt out: `useSSOFlow` calls it immediately
  BEFORE starting SSO, and `App.tsx` calls it when rejecting an ownerless restored
  credential at cold start. Forgetting in either destroys an invite queued while
  the app was closed — the click-invite-then-sign-in flow this change exists to
  repair. **`gracefulReset` is NOT a caller** — it deliberately leaves main's
  tokens alone so a remembered session restores next launch (see the #1768
  invariant below); an earlier draft of this paragraph listed it and was wrong. **Two different handlers have now been misread as logout edges; before
  adding a third, check its callers rather than its name.**
  The third caller, and the one that does NOT opt out, is `nuclearReset()` — a
  refresh failure with `rememberMe === false`, documented in `resetService` as
  *"ends the authenticated lifecycle"*. It never calls `auth:logout`, so it relies
  on this handler's forgetting default. **It must issue exactly ONE clear.** An
  earlier shape kept deep links there and added a second, unflagged clear to do
  the forgetting; main resolves the profile to delete as
  `inMemoryApiBase || readActiveApiBase() || DEFAULT_PROFILE_API_BASE`, and the
  first call empties the in-memory base and deletes the active-profile pointer, so
  the second falls through to the DEFAULT profile and deletes a remembered SaaS
  session's credentials the logout never touched. Doubling the call is not
  idempotent — it changes WHICH profile is cleared. Main reads the flag STRICTLY — only the literal `true` opts out —
  because it is renderer-supplied, and the strictness points at the safe side: a
  malformed opt-out fails to opt out. **The default is what an OLDER SPA gets**,
  since `spaLoader` loads one indefinitely and it predates the argument entirely;
  keep-by-default would have handed exactly those SPAs a cross-account replay.
  Lose an invite, never cross an account. No new IPC channel — the existing one
  widened — but a signature change nonetheless, so `IPC_CONTRACT_VERSION` bumps
  for it — **v24**. It briefly read v23; #2977 (content protection, #2468) landed first
  and owns that number, which is exactly the collision the earlier hedge
  anticipated. It clears everything deliverable:
  `lastCode`, `held`, the flush timer, `lastAt`, `originAt` and both pending
  queues, so the post-state is indistinguishable from a fresh process. **`auth:logout` is not
  redundant with `auth:clearTokens`:** the renderer's real logout runs
  `performLogout` and reaches `clearTokens` only via `resetService.ts`'s
  doubly-optional-chained `globalThis.electron?.clearTokens?.()`. The forget is
  placed BEFORE `await performLogout(...)` deliberately — `performLogout` wipes
  credentials on its first line and only then issues an unbounded network POST,
  so anything after the await leaves the clear open for that request's width.
- **`auth:clearTokensIfOwner` deliberately does NOT forget, and the scope of the
  claim is exactly "every LOGOUT path", never "every credential wipe".** Two
  paths end credentials without forgetting, and both are correct. (a)
  `auth:clearTokensIfOwner` — every caller is **login-side**: aborted SSO
  (`useSSOFlow`), an interrupted email verification, a cancelled account-link or
  passphrase setup, an aborted login continuation, the eager-unlock re-persist
  cleanup. Forgetting there erases a `concord://invite/CODE` that was queued
  before any window existed (main holds the only copy), so an SSO sign-in that
  aborts loses the invite and the retry lands with it silently gone — #2363's own
  symptom on a new path. (b) A `rememberMe` refresh failure runs `gracefulReset()`
  **without** `electron.clearTokens()` (`apiClient.ts`) — correctly, because the
  disk tokens must survive for the next launch to retry. It is nonetheless a
  session ending, so since v25 it forgets through `deeplink:forget` instead:
  credentials stay, deliverable codes go. Do not "complete" (a) by wiring a forget
  into it.
- **Login-side credential wipes deliberately do NOT forget.**
  `reserveCredentialOwner` (`tokenManager.ts`) also calls `clearTokens()`, driven
  from `ipc/sso.ts`'s `sso:appleSignIn` / `sso:googleSignIn` /
  `sso:abandonReservation`. Wiring the forget in there would break the primary
  invite flow — click an invite while logged out, sign in, join — because
  hold-and-replay across a login is the feature, not a leak (see the M4 bullet
  above: the clear edge is `accessToken → null`, never an `authGeneration`
  change). The claim this section supports is therefore *"every logout path
  forgets"*, NOT *"every credential wipe forgets"*. Do not "fix" the asymmetry.
- **The carry is bounded by a RECENCY fence measured from FIRST delivery, and the
  bound is DERIVED, not chosen** (#2363 adversarial pass). The carry's own
  justification is "the modal is destroyed before the user could act on it" — a
  recency condition, so a code the user read and dismissed must not return on every
  later swap. Two things make that fence real, and both were wrong on the first
  attempt. (a) The age runs off `gate.originAt`, set once per genuinely-new code
  and PRESERVED across a carry's replay — where "replay" means `code ===
  gate.carriedCode`, the code this reset actually carried, NOT merely "the same
  code as last time". `carriedCode` survives resets that carry nothing while its
  code is still in `pendingDeepLinks`, and is cleared only once that code has
  drained or been evicted: two main-owned swaps can overlap before the renderer
  signals ready, and the second sees `lastCode === null` because the first
  cleared it, so an unconditional clear there erased the marker for a code still
  queued — which then drained as a fresh delivery and restarted its own window. That distinction is load-bearing: a user who dismisses an
  invite and then deliberately re-opens the same link is making a FRESH delivery
  and must get a fresh clock, or their new modal is born stale and the next swap
  declines to carry it. `sendDeepLink` refreshes `lastAt` on every
  delivery, the replay included, so measuring off `lastAt` made the fence a SLIDING
  window a dismissed code could ride forever. (b) `DEEP_LINK_CARRY_MAX_AGE_MS` is
  computed from `spaTiming.ts` — `sum(SPA_RETRY_DELAYS_MS) + (2n+1)·CONFIG_TIMEOUT_MS`
  plus margin — because the retry delays are SEQUENTIAL, each attempt first
  awaits `resolveSpaSource`, and the chain advances only as each
  `applySpaDecision` RESOLVES: the first retry is scheduled after the initial one
  completes, and every `applySpaDecision` awaits a `captureSpaHash` bounded by
  the same timeout. So each attempt costs up to two timeouts, plus one hash
  capture before the chain starts. It is a BEST-EFFORT ceiling rather than a
  proof: `window.loadURL` has no deadline of its own, so a pathologically slow
  document load can still exceed it. Every step that CAN be bounded is counted;
  the one that cannot is named.
- **The pending queue collapses duplicate codes, and the carry's eviction
  reservation depends on that.** `queueDeepLink` drops a code already waiting: a
  second copy opens the same modal twice, and — the reason it is load-bearing
  rather than tidy — it would multiply the carried code's eviction exemption into
  one exemption per copy. A page that knows the carried code could then fill every
  slot with duplicates, leaving a later LEGITIMATE link as the only non-reserved
  entry and therefore the immediate drop-oldest victim: suppression instead of
  substitution. With duplicates collapsed, at most one entry can match, so the
  reservation is exactly one occurrence by construction. Do not "optimise" the
  dedupe away. That arithmetic is only valid because
  `CONFIG_TIMEOUT_MS` bounds the WHOLE config operation: `fetchJsonWithTimeout`
  holds its deadline open across `response.json()`, where an earlier version
  cleared it as soon as headers arrived and left the body read unbounded — which
  hung SPA resolution outright on a trickled body, quite apart from the fence.
  `hashEntryHtml` is bounded on the same budget and for the same reason: it ran
  with no timeout and no signal at all, and `captureSpaHash` awaits it inside
  `applySpaDecision` — inside the carry wrapper — so an unbounded read there held
  the carry armed indefinitely after the successor document had already loaded.
- **A held deep link does not outlive the session it belonged to, and the fence is
  RENDERER-side.** `App` replays a held code when `accessToken && emailVerified`
  next become true, and that predicate is account-BLIND — so user A's invite, held
  across a rememberMe refresh failure, would open for whoever signs in next. Main
  forgetting cannot fix it: at that point the renderer holds its own copy.
  `gracefulReset` therefore dispatches `deep-link-session-ended` and `App` drops
  what it holds — **but only when `accessToken` is non-null**, i.e. only when a
  session actually existed. That gate is not defensive tidiness: `gracefulReset`
  also runs on paths where nobody has EVER signed in — a cold start whose
  `restoreSession()` fails, and the ownerless-credential rejection, which
  explicitly preserves main's copy with `{ keepDeepLinks: true }` and would
  otherwise have had the renderer erase it. Announcing there deletes the invite the
  user launched the app to accept. `handleRefreshFailure` calls the reset BEFORE
  `clearAccessToken()`, so a genuinely ended session still has its token at dispatch
  time: **token present = a session existed; token absent = login-side.** Announced from `gracefulReset`, not `nuclearReset`, because the
  reachable path is the REMEMBERED one — `nuclearReset` already ends the lifecycle
  and forgets in main, and preserving a session so it can resume is not the same as
  preserving it for whoever signs in next. This does NOT break
  click-invite-then-sign-in: that flow has no prior session, so the reset never runs
  for it. **The renderer event alone is not sufficient** — it clears the copy `App`
  holds, and main holds its own; the same gate therefore also calls
  `electron.forgetDeepLinks()` (v25). Gating BOTH on the same condition is the
  point: a login-side `gracefulReset` must do neither.
- **The token is not the whole gate, because it answers the wrong question.** It
  says *a session existed*, not *this session is ending*, and one caller separates
  them: `softRestart()` reloads a still-valid same-account session on Recovery B,
  where preflight found `tokenValid === 'ok'` and the RENDERER unstable. Only the
  document is being replaced. Before v25 that path survived on main's copy —
  the event cleared `App`'s, `resetDeepLinkDelivery` re-queued main's for the
  successor renderer — so adding the forget removed exactly the copy recovery was
  relying on and let a transport blip eat a pending invite. `softRestart` therefore
  passes `gracefulReset({ keepDeepLinks: true })`, suppressing both halves. **The
  DEFAULT forgets**, so a future caller that ends a session lands on the safe side
  without knowing the flag exists — same reasoning that inverted `auth:clearTokens`
  in v24, and the name matches that channel on purpose. This is the third state to
  learn it: #2199
  recorded it for NSFW intent, drafts, and the outbound MessageQueue. **Anything
  a teardown clears must be checked against Recovery B before it ships.**
- **The MAIN-side half of the fence is an owner tag, and it exists because
  `deeplink:forget` needs a renderer new enough to call it.** `spaLoader` refuses
  an SPA *newer* than the shell and loads an older one **indefinitely**, so a
  pre-v25 renderer never calls the channel at all — and on those SPAs a
  `rememberMe` refresh failure still left main holding user A's code for the
  44 s carry window. `deepLinkOwner` records the credential owner that a code
  is bound to, read through `getCredentialCustodyState()`; a retained code is not
  deliverable once a DIFFERENT owner is current. It is written at TWO points and
  both are necessary: at OS **arrival**, which binds a code that will sit in the
  queue, and at **delivery**, which spends the pre-login carve-out on the account
  that actually receives the code. Writing it only at arrival left the primary
  flow — click invite, sign in, join — permanently ownerless, so the exemption
  outlived the delivery it existed for and any later account could still be
  handed that code (CODEX P2). It reads the credential store every SPA must go
  through whatever its contract version, so SPA age stops mattering.
  `credentialGeneration` is the right signal precisely because it is stable
  across a session's own refreshes and advances only when a credential is minted
  or cleared — it means *which account*, not *which token*.
  - **Two carve-outs, both load-bearing, both now pinned by a test.** A **null
    tag** is a code queued before anyone signed in: it belongs to nobody, and
    handing it to the account that signs in next IS the feature. A **null
    current owner** is credentials cleared with no successor — aborted SSO,
    cancelled account-link, interrupted email verification — which is login-side
    and must not forget, per the `auth:clearTokensIfOwner` rule above. **That
    second carve-out applies at a DRAIN or FLUSH and is inverted at an ARRIVAL**,
    which is the one place the two cases are separable without per-entry
    ownership: on a pre-v25 SPA the teardown leaves A's tag in place, a link
    clicked while logged out cannot clear it (`noteDeepLinkOwner` refuses to
    write null), so the fresh code joined A's queue under A's tag and the next
    owner change swept the link the user had just opened. At an arrival,
    everything already queued belongs to the retained tag and the arriving code
    does not — so the arrival forgets and the drain does not. Both directions are
    pinned by a test; inverting either one reds a different case.
  - **`noteDeepLinkOwner` refuses to write a null tag, and that is the
    laundering guard, not a null-check.** A logged-out arrival is exempt from the
    fence by the tag-null carve-out; if it also RESET the tag it would extend that
    exemption to user A's still-queued code, and the next owner to sign in would
    receive both. Sign out, click a link, hand over the laptop.
  - **Fenced at THREE entry points, each before it snapshots anything:** the
    arrival in `handleInviteDeepLink`, `drainPendingDeepLinks` (before its
    `queue.splice(0)`), and `flushDeepLinkGate` (which calls `sendDeepLink`
    DIRECTLY, reaching the renderer on a path neither of the others covers).
    `queueDeepLink` is deliberately NOT one: `resetDeepLinkGate` and
    `flushDeepLinkGate` both re-queue through it, so fencing there forgets
    everything *except* the entry being re-queued, and claiming ownership there
    launders a retained code into whoever is signed in now. `resetDeepLinkDelivery`
    is deliberately not one either — everything it re-queues meets the drain fence
    before delivery, and by mutation, dropping either alone left the suite green.
    One fence per delivery path, not two.
- **KNOWN CEILING: the carry is scoped to a main-owned swap by DEPTH, not by
  navigation identity.** Any reset occurring while `deepLinkCarryDepth > 0`
  carries, including an ordinary reload or a renderer crash inside the wrapper's
  tail — so within the recency window such a reset can re-present a code the user
  already dismissed. This is not an oversight and it is not free to close: main
  gets no "this reset belongs to the navigation I started" signal, and
  `applySpaDecision` legitimately navigates twice on its remote→cache→bundled
  fallback, which is precisely why a boolean (spent by the first reset) failed and
  became a count. The tail is now bounded rather than unbounded, and `originAt`
  bounds re-presentation to the recency window. Closing it properly needs
  navigation identity correlated from `did-start-navigation`/`did-finish-load`;
  that is a design change, not a review fix. A hand-picked 15 s was documented as covering the
  schedule "with margin" and covered a worst case of 24 s not at all, declining the
  carry on the exact cold-start recovery it exists to repair. `spaTiming.ts` exists
  so both consumers read the same numbers: several main tests mock `spaLoader`
  wholesale, which made a derivation from its export `NaN` under test.
- **What actually prevents the re-queued code from being swallowed is the
  READINESS clear, not the re-queue ordering.** `resetDeepLinkDelivery` sets both
  readiness flags false before it re-queues, so `emitDeepLink` returns early and
  the code lands in the pending queue rather than meeting a live 1-second window
  carrying its own value (which `emitDeepLink`'s same-code collapse would drop
  silently — no error, no log, symptom identical to the bug this fixes). It also
  zeroes `lastAt`, a second independent fence. **Neither is test-covered:**
  moving the re-queue above the `lastCode` clear leaves the suite green. Verified
  by mutation, recorded here so the next reader does not infer a guarantee the
  tests do not provide.

### IPC contract v27 — the audiocap PCM relay, and the first `MessagePort` relay primitive in `src/preload/` (#3195, ADR-0043)

`IPC_CONTRACT_VERSION` moved 26 → 27 (`ipcContract.ts:233`). `SPA_MIN_CONTRACT` stays **19** — the
renderer feature-detects `typeof window.electron?.audiocap?.getPortMessageTag !== 'function'`, so a
shell without the relay loses per-process screen-share audio and degrades to video-only, never to a
system mix (C9). Capability, not demand.

- **One main → preload channel, `audiocap:port`**, carrying `port2` of the capture child's
  `MessageChannelMain`. Everything downstream of it — the per-quantum validation, the second
  preload-created `MessageChannel`, the exactly-once handoff to the main world — is
  `src/preload/audiocapRelay.ts`, and it is the **first** `MessagePort`-handling code `src/preload/`
  has ever had. A raw `MessagePort` cannot cross `contextBridge` (C2), which is why the bridge
  exposes only `audiocap.getPortMessageTag()` — the presence of that function is the capability
  probe, its value is the discriminator on a one-shot `window` message carrying the port.
- **The `windowLoaded` ordering requirement — a new failure shape for this repo, not a restatement
  of an existing one.** The relay's `windowLoaded` promise MUST be constructed at **preload module
  scope**, registering its `load` listener before the `load` event can fire (with an additional
  `document.readyState === 'complete'` check for the case where the module evaluates after the
  document already finished loading). Deferring construction until the IPC message with the port
  arrives races app startup: on a fast machine `load` may have already fired by the time the relay
  gets around to listening for it, the `await windowLoaded` inside the handler never settles, the
  port handoff to the main world never happens, and the symptom is an intermittent, silent "screen
  share has no audio" with nothing in any log — the relay logs nothing on this path by design (every
  value crossing it is either user audio or a value an untrusted child chose). Any future preload
  primitive that must hand something to the main world over `window.postMessage` after `load` has
  the same trap; construct its readiness gate at module scope, not inside the message handler.
- **Why this hop exists at all rather than handing the child's own port to the main world.** Design
  §5 Q6 "Option B′": the port terminates in preload, and the main world receives a *second*,
  preload-minted `MessageChannel` end instead. The preload relay never forwards the main world's own
  message objects back to the child — it mints a fresh `{ c: 1 }` credit ack of its own construction
  on every ack — so a compromised main world (remote-SPA code included) cannot use this channel to
  reach the process that loaded `rt/` with an arbitrary value. See
  [ADR-0043](../../../docs/adr/0043-per-process-screen-share-audio-capture.md) § As-built addendum.

### IPC contract v28 — audiocap machine-capability push (#3198 PR 1, ADR-0043 D6)

`IPC_CONTRACT_VERSION` moved 27 → 28 (`ipcContract.ts:248`). `SPA_MIN_CONTRACT` stays **19**
(`:281`) — the renderer feature-detects `typeof globalThis.electron?.audiocap?.onCapability !==
'function'` (`globalThis`, matching the `apiClient.ts` precedent the subscriber cites and the
code as written; `window` is equivalent in a renderer but is not what the module says), so a
shell below 28 never leaves the pre-addon rungs of the capability ladder:
video-only, never a system mix (C9). Capability, not demand.

- **One main → renderer push, `audiocap:capability`**, payload `{ perProcessAudio: boolean }` —
  one bit and nothing else. `osVersion` was considered and refused: it would put an OS build
  string into a main world that may be remote-SPA code served from a CDN origin, and it would
  duplicate a floor `rt::platformBackend()` already enforces natively. The bridge method is
  `audiocap.onCapability(callback)` (`preload.ts`), returning an unsubscribe function; the
  renderer subscribes at module scope in `machineAudioCapability.ts` (the `apiClient`
  precedent), because the push can arrive on `did-finish-load` before any React tree mounts.
- **Delivered twice, deliberately.** Once from `setAudiocapCapabilityListener`, registered in
  `main.ts` *before* the capability probe is scheduled so a fast handshake cannot settle before
  a listener exists to hear it; and again on every `did-finish-load`, because a renderer created
  or reloaded after the snapshot already settled would otherwise hear nothing from the
  change-listener path (an SPA-loader swap is the concrete case). The value is a machine fact,
  identical on every `hello`, so a duplicate push is idempotent and ordering-insensitive. A
  `null` snapshot sends nothing — absence IS the fail-closed state, and the renderer's initial
  `voiceStore.machineScreenAudioCapable` value already represents it.
- **The snapshot is written ONLY from a validated `hello`** (`audiocapHost.ts`
  `handleChildMessage`), never from the app-start capability probe. The probe's `probeInFlight`
  memoization means a share that reaps the probe's child mid-handshake would otherwise publish a
  permanent false negative for a fully capable machine; routing the write through the hello
  instead makes a reaped probe leave the snapshot `null` (read as the pre-addon rungs) and lets
  the very share that reaped it set the snapshot from its own `hello` — self-healing in one
  share, with no second child and no re-probe path.
- **NO sender-frame check on this channel, deliberately.** A `webContents.send` push has no
  sender to validate, and **every** sibling push — `auth:token-refreshed` included — carries no
  target check either; adding a differently-shaped one would imply the rest are unsafe without
  fixing them. **The sender-validation criterion binds exactly one handler, and that handler
  is `audiocap:start`, added by #3198 PR 3** (this bullet said "does not exist yet: #3198 PR 2's",
  which was true until the 2026-09-16 split moved that invoke to PR 3, and until PR 3 landed it).
  Do not read the absence of a check
  here as an oversight to "fix" — it is the correct shape for a push that authorises nothing.
  What constrains the destination is navigation control (the `will-navigate` gate and
  `applySpaDecision` keep the main frame on an allowlisted origin), not a per-send test; the
  § "Sender-frame validation" section below is about INBOUND handlers and says nothing about
  pushes, so do not read it as the support for this decision.
  - **Count the sites, do not quote a number.** This bullet said "eight sibling pushes" through
    three mirrors and a design-spec cell, and #3198's Phase-8 review had three reviewers
    independently derive three different figures from it — none of them eight. The real answers
    depend on what you are counting: `webContents.send` in `main.ts` is 7 non-audiocap sites,
    across all of `desktop/src/main/` it is 10, and `ipcRenderer.on` in `preload.ts` is
    14. Following the label-taxonomy precedent, the grep is the citation:
    `grep -rn "webContents\.send(" desktop/src/main/`. A hardcoded total in a file three
    mirrors copy is a number that rots silently and invites a reader to "fix" the wrong instance.
- **The push is an AFFORDANCE input, never an authorisation.** It feeds
  `canCarryScreenAudio`'s third parameter (`utils/policy/screenAudioCapability.ts`), which
  decides what the renderer OFFERS and SAYS. Every enforcement decision main makes is re-derived
  from inputs main re-validates, so a renderer that lies to itself about this bit gains nothing —
  `handleAudiocapStart` re-parses the source id, re-checks the `window:` prefix and re-confirms
  the id against a live `desktopCapturer` enumeration regardless of what the renderer believed.
  - **`'per-process'` became REACHABLE in #3198 PR 3**, which threaded that third argument at all
    four call sites. It was unreachable through PR 1 (declared, no caller) and through PR 2 (the
    2026-09-16 split moved the capture seam out), and this bullet asserted the PR-2 wiring until
    PR 3 landed. The argument is OPTIONAL, so a call site that omits it compiles and silently
    answers with the pre-addon rungs; `grep canCarryScreenAudio(` is the check.

### IPC contract v28, additive — the audiocap control channels (#3198 PR 3)

Two renderer→main invokes were added WITHIN contract 28. `IPC_CONTRACT_VERSION` does not move and
`SPA_MIN_CONTRACT` stays **19**: the renderer feature-detects each one, so a shell without them
loses per-process audio and keeps its video — never a fall back to the system mix (C9).
Capability, not demand (#2967).

- **`audiocap:start`** → `{ sourceId }` → `AudiocapStartResult`. The ONE audiocap handler the
  sender-frame criterion binds (the `audiocap:capability` push above has no sender to validate).
  Four fences in a fixed order, and the order is the design: sender frame on the first statement;
  payload shape (one known field, extras dropped rather than rejected, so a hostile renderer
  learns nothing about which fields exist); the `window:` prefix re-parsed HERE rather than
  trusted; and liveness against a thumbnail-free `desktopCapturer` enumeration, because a
  well-formed id for a window that has since closed is stale and "a stale id must never silently
  widen a capture" (D4a). **No PID appears in that file** (I-PID): main resolves a HANDLE and
  sends that, and the capture child is the only process that ever learns a PID.
- **`audiocap:stop`** → no payload → `void`. Zero-argument BY CONSTRUCTION, matching
  `spa:reloadLatest`: the renderer triggers, main resolves which child to reap from its own
  session, so the renderer names nothing and chooses nothing. Sender-fenced on the first statement
  like `start`, because it reaches a process kill and a frame that is not ours must not be able to
  end another window's share. It exists because every `killAudiocapHost` caller is a quit or crash
  hook and the child's `handleStop` deliberately does not exit — without it, a share the user
  ended left the capture child holding its OS tap until the app quit.
- **`audiocap:start` resolves on the child's `started` ack, not on the handshake (#3394 PR 1).**
  `handleHello` used to settle `startAudiocapHost`'s promise `ok:true` in the same turn it posted
  `{kind:'start'}`, before the child had attempted `addon.start` — so a later `fault{target|start}`
  arrived at an already-settled promise and was dropped, including the `NoTarget` →
  `'target-unresolved'` fix above, which never reached the renderer as shipped. The host now enters
  a `'starting'` state and settles only on `AudiocapStarted`, bounded by `START_ACK_TIMEOUT_MS`
  (10000ms; separate from `HANDSHAKE_TIMEOUT_MS` because it bounds tap creation, not spawn). T0
  measured tap creation at 1–2 s on the dev binary. **Corrected (#3394 PR 2, 2026-09-23, TCC's
  retained log, E2):** T0's checks were credited to the launching app, not Electron — three
  allowed, three denied with reason 8 (missing usage string) — so every T0 tap was silent
  regardless of grant, and "no prompt" is explained by the credited app's missing usage
  description, not by tap creation never waiting on one. The 1–2 s figure stands only for the
  granted state. A Developer-ID-packaged build, and a denied first share with the target fixed,
  remain unmeasured (ADR-0043 § As-built addendum — #3394 PR 1, correction recorded in the same
  addendum). Cost: the renderer's `audiocap:start` invoke — and the video
  publish that waits on it in `capturePerProcessScreenAudio` — now waits for OS tap creation, not
  merely the handshake.
- **Every `killAudiocapHost` caller is still a quit or crash hook — that claim stays true.**
  `killAudiocapCapture()` (#3394 PR 1) is its renderer-loss sibling rather than an exception to it:
  it wraps `killAudiocapHost()` and is called by `wireAudiocapRendererLoss()` from a
  `render-process-gone`, a committed `did-navigate`, or a main-frame `did-fail-load` other than
  ERR_ABORTED (-3) — a failed navigation commits an error page and fires no `did-navigate` — on
  the main window, sparing the windowless app-start probe (`windowHandle === null`); a start still
  pending in `'starting'` settles `{ ok: false, reason: 'child-crash' }` like any other kill.
  `main.ts` wires it **immediately after constructing the main window, before the first load** —
  the renderer is live long before the awaited initial load resolves, so wiring it after that
  await left a loss during the load with no listener (red-team PoC, #3394 Phase 8). A renderer
  `audiocap:stop` spares the windowless probe for the same reason the kill does: reaping it
  before its `hello` memoizes `child-crash` and leaves the capability snapshot `null` for the
  session, and nothing but a per-process share could ever re-set it.
- **`audiocap:start` and `audiocap:stop` admit only the main window's main frame (#3394 PR 1).**
  An origin check alone admitted any trusted-origin frame, including a PiP window, which loads the
  same SPA with the same preload — wider than the renderer-loss watch, which covers only the main
  window's main frame. Admission is now `requireTrustedSender` AND `event.sender` is
  `getMainWindow().webContents` AND the sender frame is that webContents' main frame (by
  `frameTreeNodeId`), in one helper both handlers share, so admission scope equals watch scope.
- **`audiocap:start` re-checks after its await, because a loss there finds nothing to kill.**
  `desktopCapturer.getSources` IS the fourth fence — it runs after the first three and before a
  session exists — so a
  reload or crash inside it used to let the start fork a tap for a document that was gone. Every
  renderer-loss hook bumps `audiocapRendererLossEpoch()`; the handler refuses `target-unresolved`
  if it moved (beside `shareOperationEpoch`) and then re-runs the main-window/main-frame
  admission fence, since `senderFrame` is `null` once the requesting document has navigated.

### IPC contract v29 — UI zoom bridge, and the first bridge method with no channel (#2367 part 2)

`IPC_CONTRACT_VERSION` moved 28 → 29. `SPA_MIN_CONTRACT` stays **19**: the renderer
feature-detects `setZoomFactor` (`utils/ui/uiZoom.ts` `getZoomBridge`), and a shell without it
keeps the legacy `--ui-scale` engine at 0.85–1.3. Capability, not demand. Renderer side:
[`frontend.md`](frontend.md) § UI Scale.

- **`electron.window.setZoomFactor(factor)` calls `webFrame.setZoomFactor` for the calling
  frame.** No app-level IPC channel is involved, so there is no handler, no channel constant, and no sender to
  validate — § "Sender-frame validation" below is about inbound handlers and does not apply. It
  still bumps the contract because it is a new shell capability the renderer probes for, which is
  the question that number answers. `main.ts` is untouched.
- **The preload does not trust the renderer's clamp.** `src/preload/uiZoom.ts`
  (`sanitizeZoomFactor`, `createSetZoomFactor`) ignores any value that is not a finite number — a
  no-op, never a throw or a default — and clamps the rest to 0.5–2, because the main world may be
  remote-SPA code. The clamp also keeps `webFrame`'s own `<= 0` exception out of the main world.
  Its own module for the `audiocapRelay.ts` reason: inlined by the bundle, unit-testable without
  executing `contextBridge`.
- **What it grants, so it is neither oversold nor re-litigated:** the caller's OWN frame, inside a
  bounded range — no more than CSS `zoom` on its own document already allowed. A measured Electron
  spike found the zoom does not propagate to the same-origin PiP window or to windows opened later.

### IPC contract v30 — audiocap:interrupted push (#3394 PR 2)

`IPC_CONTRACT_VERSION` moved 29 → 30. `SPA_MIN_CONTRACT` stays **19**: the renderer
feature-detects `typeof globalThis.electron?.audiocap?.onInterrupted === 'function'`, and a
shell below 30 simply does not tell the user — the share keeps its video and its app sound
goes silent with no notice, which is the pre-30 behaviour. Capability, not demand.

- **One main → renderer push, `audiocap:interrupted`.** Payload `{ generation: number,
  reason: ScreenAudioInterruptReason }`, where `reason` is the three-member union
  `'capture-interrupted' | 'child-crash' | 'protocol-fault'` (`shared/audiocapProtocol.ts`).
  It fires when a LIVE per-process capture ends without the user asking — a fault the tap
  latched mid-share, a child crash, or a protocol break after `started`. Sent to the main
  window only (`mainWindow.webContents.send`), and the child never chooses either field: main
  re-mints the object in `audiocapHost.ts`'s `retire()` from two values it owns — the
  session's `generation` and its own mapping of the cause to one of the three reasons. The
  child's only influence is WHICH of those three mechanisms describes its own capture
  ending, which it could already end by exiting or by sending a `fault`.
- **No sender-frame check, deliberately.** It is a push, like `audiocap:capability` — see
  § "IPC contract v28" above for the reasoning; it applies unchanged here and is not
  repeated.
- **The preload bridge copies fields, it does not forward them.** `audiocap.onInterrupted`
  (`preload/preload.ts`) validates the incoming payload against `isAudiocapInterrupted`
  (non-safe-integer or negative `generation` rejected; `reason` checked with
  `Object.hasOwn` against the closed anchor) and, on a pass, calls the renderer callback with
  a NEW `{ generation, reason }` object built from those two fields alone — never the
  original `data`. `onCapability` was narrowed to the same field-copy shape in the same
  change. Both `onCapability` and `onInterrupted` also flip a local `subscribed` flag to
  `false` on unsubscribe, because `ipcRenderer` is an `EventEmitter` and `removeListener`
  issued while an emit is already in progress does not remove the listener from that emit —
  the flag is what makes "nothing after `unsubscribe()` returns" true by construction.
- **Registered before `registerAudiocapIpc`, by construction.** `main.ts` calls
  `setAudiocapInterruptListener` and `setAudiocapPortSink` ABOVE the
  `registerAudiocapIpc(...)` call that installs the `audiocap:start` handler — the only way a
  capture can begin — so no later `await` can reorder them relative to it. Both setters only
  capture the late-bound `mainWindow` getter and guard `isDestroyed()`, so registering them
  first costs nothing. `desktop/tests/unit/main/main.test.ts` pins the order with
  `invocationCallOrder` across `setAudiocapInterruptListener`, `setAudiocapPortSink`, and
  `registerAudiocapIpc`.
- **`retire()` publishes at most once per live session, as its last step.** The publish
  decision (`interrupt !== null && session === live && hostState === 'capturing'`) is taken
  at entry, before the session is forgotten; the listener itself runs LAST — after the child
  is reaped and the start promise settled — inside a `try`/`catch` so a throwing listener
  cannot skip the reap or the settle.
- **Renderer-side handling is documented in [`frontend.md`](frontend.md) § "Screen-share
  audio and source switching"** — this file's job is the wire contract, not the renderer
  response to it, which is still being written.

### IPC contract v33 — status-aware tray (tray-status spec 2026-10-29)

`IPC_CONTRACT_VERSION` moved 32 → 33. `SPA_MIN_CONTRACT` stays **19**: the renderer
feature-detects `typeof globalThis.electron?.traySetStatus === 'function'`, and a shell below 33
keeps its static Open/Quit tray. Capability, not demand.

- **One renderer → main invoke, `tray:setStatus`.** The payload is a `TrayStatusSnapshot`
  (`src/shared/trayStatus.ts`): every field is a boolean, a member of a frozen tuple, or an
  integer 0..99, so no field can carry free text that reaches a label, tooltip or `setTitle`.
  The handler (`src/main/ipc/trayStatus.ts`) refuses in this order, each refusal resolving
  `true`, except a rate-limit drop, which resolves `false` so `traySync` resends that
  snapshot after 100 ms: `requireTrustedSender`; the sender is the main window's `webContents` AND its
  main frame (a PiP shares the origin and would pass the first check alone); a 20/s token
  bucket; `firstInvalidField`, the exact-key guard (plain object, own keys exactly the expected
  set, data properties only, closed enums). A malformed snapshot is logged once per session
  with the field NAME only.
- **One main → renderer push, `tray:action`.** A closed-enum `TrayAction` (`set-muted`,
  `set-deafened`, `leave-voice`, `stop-share`, `set-presence`, `open-unread`); the preload
  re-validates it with the shared guard before the renderer sees it. Intents carry the target
  value, not a toggle. Open, Quit and the update actions stay in main and never cross the
  channel. The renderer side is `services/system/traySync.ts` (snapshot builder) and
  `trayActionDispatcher.ts`.
- **Reset on a dead renderer.** `attachTrayResetHooks` drops the tray to the neutral icon and
  the Open/Quit menu on a committed main-frame navigation (`did-navigate`, or a non-aborted
  main-frame `did-fail-load`), `render-process-gone`, `unresponsive` and `destroyed`, so voice controls never outlive their session. A hang can end with the same
  session alive, so `responsive` re-applies the last accepted snapshot; the other three
  forget it.
- **Sprites, not runtime compositing.** `main/trayVisual.ts` resolves a snapshot to one of 53
  frame keys plus a menu model; `main/trayScheduler.ts` owns the animation timers (none on
  Linux). The sprites are committed under `assets/tray/<mode>/` (`template`, `white`, `black`,
  `colour`) with `manifest.json` and `frames.json`. Regenerate them with
  `npm --prefix desktop run generate:tray-icons`, which also writes the review contact
  sheet to `assets/tray-sheet/` (deliberately outside `assets/tray`, so it is not shipped) and
  the Settings previews. The generator fails above 60 keys. `verify-packaged-app.mts
  tray-assets` reads `Resources/tray/manifest.json` back from the produced app and fails if a
  sprite the platform loads is missing or empty.
- **Dev-only forcing.** `globalThis.__concordTrayForce(snapshot)` exists only in DEV renderer
  builds and sends a synthetic snapshot through the real channel. Main adds ` [dev]` to the
  tooltip when `!app.isPackaged`.

### IPC contract v32 — billing launcher (#1305)

`IPC_CONTRACT_VERSION` moved 31 → 32. `SPA_MIN_CONTRACT` stays **19**: the renderer
feature-detects `typeof globalThis.electron?.openBilling === 'function'`, and a shell below 32
gets no paid controls; there is no OS-browser fallback (spec R41). Capability, not demand.

- **One renderer → main invoke, `billing:open`.** Request `{ kind: 'checkout' | 'portal', url }`;
  reply `{ result }`, one of `success`, `cancel`, `already_subscribed`, `returned`, `closed`,
  `load_failed` or `busy`. The handler (`src/main/ipc/billing.ts`) checks the sender frame with
  `requireTrustedSender` first, then `validateBillingUrl`: https, no userinfo, no port, and a host
  that is EXACTLY the account's Stripe custom domain `pay.concordvoice.com`, which serves both
  Checkout and the Portal. The `stripe.com` hosts are refused (Mark, 2026-10-23), so removing the
  custom domain in Stripe needs a launcher change and a shell release first. There is no path
  check, because a path would not bind the merchant.
- **The window.** `openBillingWindow` (`src/main/billing/billingWindow.ts`) opens a modal child
  `BaseWindow` with one `WebContentsView`: no preload, `sandbox`, `contextIsolation`, an
  in-memory `billing` partition cleared on close (a failed wipe moves later launches to a fresh
  partition), every permission refused, downloads and
  `window.open` sent to the OS browser (https only). The main frame may navigate only to
  `ALLOWED_NAV_HOSTS` (`pay.concordvoice.com`, and `hooks.stripe.com`, which runs 3DS);
  subframes are not gated, so an issuer's challenge page loads. A blocked host is
  logged by hostname. Widen the list only from a host that log names. Stripe's redirect to
  `https://concordvoice.com/billing/return` is cancelled before it loads and mapped to the
  result. One window at a time: a second call focuses it and resolves `busy`. Cmd/Ctrl+W closes;
  Escape is deliberately not bound.
- **The WeakSet ordering is load-bearing.** The global `web-contents-created` gate in `main.ts`
  externalizes every off-origin navigation, which would send Stripe to the system browser.
  `isBillingWebContents(contents)` is therefore the first check in its `will-navigate`
  callback, and the view joins the set before `loadURL`. Adding the view after `loadURL`, or
  moving the check below another one, hands the first navigation to the global gate.
- **Residual risk, accepted.** A compromised renderer can open any merchant's hosted Stripe page
  in the sheet, because the host check cannot bind the merchant. That is subsumed by full
  renderer control, which can already show any page it likes, and the window title shows only
  the host. See § "Accepted risk: in-renderer compromise".

### IPC contract v31 — refresh challenge carries WebAuthn options

`IPC_CONTRACT_VERSION` moved 30 → 31. `SPA_MIN_CONTRACT` stays **19**: the field is
optional, and a shell below 31 omits it, which leaves the refresh challenge without a security
key — the pre-31 behaviour. Capability, not demand.

- **`RefreshResult.mfaWebauthnOptions`.** `tokenManager.tryParseMfaChallenge` copies the
  server's `webauthn_options` from a `suspicious_session_mfa` or `mfa_upgrade_required` 403
  onto the `auth:refreshToken` result, unparsed (`unknown`). The control plane has always sent
  it (`buildMFAChallengeResponse`); main dropped it, so the challenge modal could never offer
  the security key the server had challenged for.
- **`RefreshResult.mfaApiBase`.** The API base main refreshed against, set beside the options.
  `handleMfaChallengeIfNeeded` opens the challenge only when its origin equals `getApiBase()`:
  the modal sends its proof to the renderer's server, so a challenge from any other server is
  not offered. A shell below 31 omits the field, which is the pre-31 path.
- **The renderer parses, main does not.** `apiClient.handleMfaChallengeIfNeeded` (refresh),
  `useSSOFlow` (SSO, whose result already carried `webauthnOptions`) and Login all pass the
  raw value through `webauthnOptionsOrNull` (`utils/webauthnOptions.ts`) and drop `webauthn`
  from the methods with `methodsForOptions` when no usable options are left. Missing or
  malformed options become `null`: the challenge still opens with its other methods, where a
  throw would abort the refresh or the SSO sign-in. Login alone fails the sign-in when the
  security key was the only method, rather than open on an empty pane.
- **`RefreshResult.mfaDefaultMethod`** (#3663 review). The server's advisory `default_method`,
  the factor the account used most recently, also on the SSO challenge result as
  `defaultMethod`. Both producers pass it to `showChallenge`, and the modal opens on it with
  `pickDefaultMethod` when the challenge offers it, else on the strongest method. Main keeps
  only strings in the refresh challenge's method lists, and `methodsForOptions` does the same
  in the renderer for older shells, so a malformed list cannot throw.
- **The rpId is bound to the server the proof goes to** (#3663 review). Every server shares one
  renderer origin, so the browser's own rpId check cannot tell them apart, and a server could
  name another server's relying party and relay the assertion. `rpId` is therefore required and
  must equal the receiving API host exactly (`rpIdBelongsTo`). A parent domain is not enough,
  because a delegated or compromised subdomain could claim its parent's relying party; the one
  exception is the official service, `api.concordvoice.chat` → `concordvoice.chat`, a built-in
  mapping (developer decision, 2026-10-07). A self-hosted server whose rpId is the parent of
  its API host (the `deploy.env.example` layout, `WEBAUTHN_RP_ID=${DOMAIN}` with the API on
  `api.${DOMAIN}`) therefore offers no security key at these challenges until a server can
  prove such a mapping. Each caller passes the base its proof goes to: `getApiBase()` for
  refresh, `serverSelection.apiBase` for SSO, the request's selection for Login. Options that
  fail the check are treated like malformed ones. Step-up begin applies the same check and fails
  the step-up instead (see [`frontend.md`](frontend.md) § "Begin's rpId must be the relying
  party of the server the proof goes to").
- **A refused assertion spends the ceremony.** The server consumes its stored ceremony when it
  judges an assertion, so after `/auth/mfa/verify` refuses one, `MFAChallengeModal` shows the
  server's reason and asks the user to cancel and try again, instead of leaving `WebAuthnPrompt`
  waiting on a ceremony that can no longer pass. A new challenge offers the prompt again.

### IPC contract v26 — PiP channel authentication (#3104 D6)

`pip:session` and the `pip:opened` push are the only disclosure paths for the token naming the
private `concord-pip:<token>` `BroadcastChannel` the PiP RPC protocol runs on. See §
"PiP channel authentication (#3104 D6)" in [`frontend.md`](frontend.md) for the full mechanism —
this file's job is only to record the version number and point there, not to duplicate it.

### Sender-frame validation: who validates and who doesn't

The rule "validate all IPC senders" applies primarily to handlers that reach a privileged side effect (filesystem, keychain, network, shell, OS notification, screen capture, OAuth flow). The canonical helper for these handlers is `isPermittedFrameUrl` at `desktop/src/main/ipc/frameValidation.ts`, used by `openExternal.ts`, `sso.ts`, `attestation.ts`, and `saveImage.ts` (the #1729 `image:saveAs` native Save-As — the canonical filesystem-write example). The dedicated `isValidPipOpenSender` covers the PiP-creation surface. `isPermittedFrameUrl` accepts five frame origins — `file://`, `app://concord`, `spa-cache://concord`, `http://localhost:*`, and the validated remote-SPA origin; the bundled `app://concord` origin was added after the #806 deferral, and the signed-LKG-cache origin `spa-cache://concord` by #1880 (see § "app://" below).

For `IpcMainInvokeEvent` handlers, use `requireTrustedSender(event, getRemoteSpaBaseUrl())`: it snapshots `event.senderFrame` and delegates to `isPermittedFrameUrl`, returning `null` before any side effect for a missing or untrusted frame. `main.ts` uses it for capture, clipboard, hardware/relaunch, update, and developer-mode IPC; `permissionManager.ts` uses it for every OS-permission handler. PiP creation and mutation use `isValidPipOpenSender`; each PiP ID is additionally bound to its creating `frameTreeNodeId`, so a second permitted frame cannot focus or mutate another frame's window. The PiP window's own validated main frame may close itself or change its always-on-top state. **`pip:session` (#3104 D6) is the strictest of the PiP handlers:** `resolvePipSender` performs the same checks and then requires `isPipMainFrame`, so the token that authenticates the renderer-side PiP RPC channel reaches only that PiP's own main frame — the OPENER frame is refused even though it passes the ownership test used by `pip:close`, because it already received the value on the `pip:opened` push. Every other outcome is `null`, which the renderer treats as "no PiP voice" and never as "proceed unauthenticated". The token is never logged: the private `BroadcastChannel` is NAMED from it (see [`frontend.md`](frontend.md) § "PiP channel authentication").

**Tray and badge handlers (IPC contract v33).** `tray:setStatus` admits only the main window's own main frame (`requireTrustedSender` AND `event.sender === mainWindow.webContents` AND the sender frame is that webContents' main frame), then a 20/s token bucket and the exact-shape guard; it is not a low-stakes exception. It resolves `false` only for a rate-limit drop, `true` otherwise. `app:setBadgeCount`, `app:flashFrame` and `app:focusWindow` were hardened in the same contract: each now calls `requireTrustedSender` first, and `app:setBadgeCount` rejects anything but a non-negative integer and clamps it to 9999, and `app:flashFrame` rejects anything but a boolean. Their refusals are silent no-ops, and their signatures are unchanged.

**Low-stakes UI-state IPC may legitimately omit `isPermittedFrameUrl` validation when ALL of the following hold:**

1. The handler reads from or writes to in-process memory only — no filesystem, network, keychain, shell, or OS-surface side effect.
2. The handler's worst-case misuse from a compromised renderer is DoS-via-resource-exhaustion or visual-spoofing, not privilege escalation or data exfiltration.
3. The handler's payload shape is structurally validated at the trust boundary (runtime type guard rejecting non-matching shapes), so downstream consumers can rely on the cached value.
4. The handler is documented under this exception in a comment block at its definition site.

**Current accepted-exception handlers** (added via #806):

- `window:setClientBehavior` — writes a `ClientBehavior` shape to the in-memory cache consumed by the close/minimize intercepts. Worst case: graceful fall-through to `app.quit()` on unknown values (intentional fail-safe).
- `window:setTitleBarOverlayColor` — passes a CSS color string to `BrowserWindow.setTitleBarOverlay`. Worst case: visual spoofing of titlebar chrome. CSS-color allowlist regex applied at the handler.
- `window:quit` — calls `app.quit()`. Worst case: DoS-via-quit, equivalent to existing `electron.quitApp()` accessible from the same renderer. No new attack surface.
- `window:getVersionString` + `spa:versionChanged` — reads app version + SPA hash. No mutation, no privilege.
- `gpu:getInfo` — reads local GPU metadata via `app.getGPUInfo('complete')` and returns bounded `{vendor, device, encodeProfiles}` data. The untyped `videoEncodeAcceleratorSupportedProfiles` payload is shape-checked and maps Chromium `VideoCodecProfile` integer values by exact allowlist before reaching the renderer: H.264 `0-10`, VP8 `11`, VP9 `12-15`, HEVC `16-18` and `29-36`, AV1 `24-26`; Dolby Vision and Theora values are intentionally ignored. No filesystem, network, keychain, shell, auth/RBAC/E2EE, or OS-capture surface is touched.

These handlers DO carry runtime input validators or bounded output shape checks (per condition 3 above). If a future handler needs the same exception, document it here AND match the runtime-validator pattern.

**Do NOT use this exception for any handler that:**
- Reaches `safeStorage`, `app.getPath('userData')`-write, or any FS surface beyond reads of bounded paths
- Initiates a network request, opens a browser window, or invokes `shell.openExternal`
- Mutates auth, RBAC, E2EE, or token state
- Triggers OS notifications, screen capture, or keychain access

## Window quit lifecycle — the `isQuitting` guard (#1383)

The `BrowserWindow` `'close'` handler in `src/main/main.ts` is a close-to-tray / minimize intercept that calls `event.preventDefault()` to route `[X]` per the cached `ClientBehavior`. **Electron aborts the entire `app.quit()` sequence if any window's `close` handler calls `preventDefault()`** — `app.quit()` fires `before-quit`, then tries to close every window, and a vetoed `close` cancels the quit.

**Invariant:** the `'close'` handler MUST early-return (no `preventDefault`) when a genuine quit is underway. A module-scope `isQuitting` flag is set to `true` in both `before-quit` and `before-quit-for-update`; the latter is required because `autoUpdater.quitAndInstall()` closes windows before the normal `before-quit` path (#1897). The `'close'` handler checks `if (isQuitting) return;` before any routing. Without it, every quit path (`⌘Q`/`Ctrl+Q` via the default menu, Dock/taskbar → Quit, `window:quit`/`app:quit` IPC, the hardware-accel relaunch, update install restart) deadlocks and the app is force-quit-only on **all** platforms — the close handler has no `process.platform` gate (the only platform branch, `window-all-closed`'s darwin check, is unreachable because the window never closes).

**PiP quit exception (#2207):** ordinary PiP-only closure is guarded in the renderer so it can await
acknowledged remote media cleanup before allowing a retried `BrowserWindow.close()`. The first
`beforeunload` must call `preventDefault()` **and** set Electron's legacy `returnValue = false` veto
signal via `Reflect.set`; `preventDefault()` alone does not reliably cancel native window closure. Full
app quit and update install MUST NOT enter that guard: immediately after setting `isQuitting = true`,
both `before-quit` and `before-quit-for-update` call `destroyPipWindowsForQuit()`.
`BrowserWindow.destroy()` skips renderer `beforeunload`, so a PiP cannot veto or strand the enclosing
quit; the closing main media socket is the server cleanup backstop. Do not replace this force-destroy
with `close()`, and keep the regressions for both hooks in
`desktop/tests/unit/main/main.test.ts`.

**Do NOT** reintroduce an unconditional `event.preventDefault()` in the `'close'` handler, and do NOT remove either `isQuitting = true` assignment from `before-quit` or `before-quit-for-update`. The `'quit'` branch's own `preventDefault(); app.quit();` is only safe because the re-entrant `close` it triggers hits the `isQuitting` guard and then proceeds to destroy the window.

**Default `ClientBehavior`** (`src/shared/clientBehavior.ts`): `DEFAULT_CLIENT_BEHAVIOR.toTray` is `'close'` — first-run `[X]` hides to the system tray shipped by #1099 (`src/main/tray.ts`; since IPC contract v33 it is status-aware, see § "IPC contract v33": on macOS and Windows a left click pops the live menu up, on Linux a click opens/focuses the window, and the menu always carries Open and Quit, with status, voice and unread rows added from the renderer snapshot). The #1383-era interim default (`toTray: 'none'`) is retired; persisted snapshots of the exact interim combo are migrated by `settingsStore`'s persist `version: 1` migration. Tray composition with this section's invariant: the tray's Quit item calls bare `app.quit()` (no new `preventDefault` path), `destroyTray()` runs in `before-quit` after `isQuitting = true`, `window-all-closed` quits only when the tray is NOT active (`!isTrayActive()`), and the BrowserWindow `close` and `minimize` handlers also gate their hide-to-tray path on `isTrayActive()`: when tray init fails, `[X]` quits instead of hiding (close calls `preventDefault()` then `app.quit()`), and the minimize redirect is skipped so the native taskbar entry remains. The `window-all-closed` guard alone is not sufficient here because `preventDefault()` + `hide()` means the window never actually closes and `window-all-closed` never fires. A failed tray init therefore degrades to a recoverable state instead of stranding an invisible resident process on Windows/Linux.

**Founding incident:** #1383 — the close intercept from #1108 shipped without the `isQuitting` guard; v0.1.56 / v0.1.57 were unquittable except via Force Quit on every platform. Regression-locked by `desktop/tests/unit/main/quitLifecycle.deadlock.test.ts`, which re-imports `main.ts` under `process.platform ∈ {darwin, win32, linux}` and covers the macOS update-install restart path.

## Token Storage
- Use Electron `safeStorage` API for credential storage (OS keychain integration)
- Never store tokens in plaintext files or localStorage
- `tokenManager.ts` handles the secure storage lifecycle
- **Disk persistence goes through `src/main/secureStorage.ts`, and Linux's hardcoded-key fallback counts as unavailable.** `tokenManager` uses the async `safeStorage` API (`encryptStringAsync` / `decryptStringAsync`); the sync methods are deprecated in Electron 45 and removed in 46. Electron 44's async encryptor resolves `isAsyncEncryptionAvailable()` to `true` even when its only key is Chromium's `PosixKeyProvider`: a hardcoded PBKDF2("peanuts") key tagged `v10`, used under `--password-store=basic` (`basic_text`) and whenever the Linux keyring provider fails to return a key. `encryptForDisk` refuses `getSelectedStorageBackend() === 'basic_text'` AND, on Linux, any ciphertext whose tag is not a keyring provider's: `v11` (Freedesktop Secret) or `v12` (Secret Portal). That allowlist refuses the hardcoded `v10`, and it fails closed on any tag a future Chromium adds, until someone verifies that provider at source. The tag test is Linux-only: Electron registers only the Keychain provider on macOS and only DPAPI on Windows (`browser_process_impl.cc` `CreateOSCryptAsync`), so neither has a hardcoded fallback, and both tag `v10` with real keys. Refused storage behaves like `rememberMe=false` for custody: the credential and E2EE keys stay in main-process memory (a Remember-Me publish still writes the non-secret active-profile pointer, and a restart reports `'unavailable'`, not `'no_session'`), and `permission:check('secureStorage')` reports `'unavailable'`, which the renderer's #197 fail-closed check turns into a blocked login or registration. That user-visible outcome is unchanged: the sync `isEncryptionAvailable()` was already `false` under `basic_text`, because nothing calls `setUsePlainTextEncryption(true)`. Do NOT call it, and do NOT gate persistence on `isAsyncEncryptionAvailable()` alone. Verified at source against Electron 44.4.3 / Chromium 152.0.7977.130; re-verify the tag scheme (`posix_key_provider.cc`, `freedesktop_secret_key_provider.cc`, `secret_portal_key_provider.h`, `os_crypt_async.cc`) on every Electron bump — see the `safeStorage` row of the Platform-behavior register in [`frontend.md`](frontend.md).
- **In-memory publish stays synchronous; disk writes are queued and fenced.** `storeRefreshToken` mints the owner (`storeRefreshTokenIfOwner` publishes under the one already reserved), and both publish memory state in one synchronous block (the CAS reasoning in § IPC contract v21 depends on it), delete every predecessor profile file before the first `await`, and queue the encrypt-and-write. `enqueueDiskWrite` is FIFO, so a credential's meta file lands before its E2EE blob, and every queued write re-checks the owner and API base after its own `await`, plus the value it writes: a token write re-checks the token, and an E2EE write re-checks the key set and the meta file's owner. Each write also checks before its encrypt, so a burst of logins or key writes queued behind one encrypt encrypts only the newest; an identical repeat is not superseded and still writes (the #1288 contract below). The `auth:storeRefreshToken` and E2EE-key IPC handlers cap every token and key field before anything is queued (`isStoreRefreshTokenPayload` / `isStoreE2EEKeysPayload` in `main.ts`), so a renderer cannot queue an unbounded encrypt. A publish writes its meta file before it re-checks the token, so a rotation during the encrypt still has a meta file to land against; a superseded write writes no credential. Owner numbers are not unique (restore adopts a profile's persisted owner, and two profiles can persist the same number), so those value checks are load-bearing: never reduce a fence to an owner-only check. Token, E2EE, meta and pointer files are written through a `0o600` temp file and a same-directory rename (`writeFileAtomic`), so a crash leaves the old file or the new one, never a torn one. A `decryptStringAsync` rejection whose message says "temporarily unavailable" restores as `'unavailable'`, never `'tampered'`, so an intact token is not deleted. `shouldReEncrypt` re-persists through the same queue. Restore refuses a Linux file not under a keyring key BEFORE decrypting (`isUnprotectedCiphertext`): anyone who can write the file can forge it, and decrypting it would let `shouldReEncrypt` re-save the forgery under the real keyring key. A token file is treated as tampered and deleted; an E2EE blob restores as absent, and the next unlock overwrites it. A Remember-Me publish writes the active-profile pointer before its first `await`, and `readActiveMeta` never falls back past a pointer whose meta is missing, so a login interrupted mid-write restores no session. If the pointer itself cannot be written (a full or read-only disk), a restart restores the default profile's own remembered credential, if one exists, exactly as after a logout or a login without Remember Me on that profile, and as `main` did whenever this write failed before the async migration. Closing that would mean deleting another profile's credential, which per-origin isolation (#1618) rules out. An API base read from the pointer or a meta file must parse as a URL: a pointer file that exists but names none also restores no session, and a malformed value can no longer throw out of restore, logout or `getPersistedApiBase`. A restore also abandons itself when registration stages E2EE keys during its awaits, so `storeE2EEKeys` never reports success for keys that restore then discards. **Queued writes are not drained at quit, deliberately.** A quit before a write lands loses it. For a rotated token, the revoked predecessor stays on disk, and a restart more than 30 seconds later hits the server's out-of-window replay branch (`services/control-plane/internal/auth/handlers.go`): a sign-in prompt plus a SeverityHigh `ReasonRefreshReplay` security event, with no other session revoked. A quit while the refresh fetch is in flight has the same outcome, so the async write widens an existing window by the encrypt time rather than opening a new one. Do not close it by awaiting the write inside the refresh, because Electron's quit does not wait for pending promises. Do not close it by draining in `before-quit` either, because an await on the quit path re-enters the #1383 deadlock window.
- **Session-only (`rememberMe=false`) auth survives a renderer *soft reload* via main-process memory, never disk (#1870).** `tokenManager` keeps the refresh token (`inMemoryRefreshToken`), API base (`inMemoryApiBase`), and E2EE key material (`inMemoryE2EEKeys`) in main-process memory; `restoreRefreshToken`/`restoreE2EEKeys`/`getPersistedApiBase` are memory-first, so a soft reload (renderer reload — main process persists) restores the session without disk persistence. A full app *restart* (main process gone) still requires login for `rememberMe=false`. The renderer's `App.tsx` session-restore runs `hydratePostLogin()` on EVERY successful restore (not only when E2EE keys are present) so a session-only soft reload reloads servers/profile/preferences instead of landing authenticated-but-empty. The in-memory E2EE keys are wiped in `clearTokens()` — see E2EE rules § Key Material.
- **A keychain/disk write failure during E2EE-key persistence is surfaced to the renderer, not swallowed (#1288).** `tokenManager.storeE2EEKeysIfOwner` resolves a `boolean` — `false` on a genuine `safeStorage`/`fs.writeFileSync` failure or a write superseded by a newer owner or key set, `true` on success or an intentional session-only / no-OS-protected-storage skip — and the E2EE IPC handlers return that result (their preload contracts also admit the untrusted-sender / invalid-payload `{ status: 'rejected' }` sentinel). The renderer routes ALL E2EE-key persistence (Register / SSOPassphraseSetup / Login / SSOEagerUnlock) through the single `persistE2EESessionKeys` helper (`src/renderer/utils/crypto/persistE2EESessionKeys.ts`), which treats `false`, the reject sentinel, or any other non-boolean result as failure and emits a non-blocking `console.warn`, but NEVER clears the valid in-memory session — a persistence failure costs only restart-survival, recoverable via re-login (the #1278 invariant). When a `CredentialOwner` exists, the helper MUST use `storeE2EEKeysIfOwner`; an unavailable owner-scoped method fails closed and must never fall back to the generic writer, which could let a stale continuation overwrite a successor's keys. Do NOT reintroduce a per-call-site inline persist/catch; the warn-and-never-clear policy lives in the helper.
- **Continuation adoption is a NEW auth lifecycle, not a refresh rotation (#2415).** `POST /users/me/password` and `PUT /users/me/keys` advance the credential epoch, so the credentials that authorized the request are dead the moment it commits; both may return a best-effort continuation pair (`access_token`, `refresh_token`, `session_id`) minted under the new epoch. Adopting it **bumps `authGeneration`** via `beginAuthLifecycleIfCurrent` (`src/renderer/stores/auth/authStore.ts`) on BOTH paths — a brand-new server session IS a new lifecycle, so that one primitive covers it and a second near-identical action would be duplication — and republishes through `storeRefreshToken`, which mints a **new `CredentialOwner`**. `applyRefreshedCredentials` (`src/renderer/services/system/apiClient.ts:271-287`) and its `previous_session_id` lineage proof are NEVER on the adoption path: the server issues a brand-new session with no predecessor edge, so adoption gets past that guard by not going near it. Do NOT re-route adoption through the refresh rotation to "reuse" the S1 → S2 CAS — it would reject every adoption, and a live generation alone was never authorization for an arbitrary session replacement. On this path `persistE2EESessionKeys` MUST follow `storeRefreshToken`, never precede it: `publishRefreshToken` (`src/main/tokenManager.ts`) wipes predecessor E2EE custody (`inMemoryE2EEKeys = null`, state `'pending'`) as it mints the owner, so a re-persist written first is discarded and the keychain keeps the pre-change keyset — see [e2ee.md](e2ee.md) § "Password-derived preference ciphertext lifecycle". **Absence of the three fields is a security outcome, not a transport error:** fail closed to re-auth, never retry. The 401 that follows carries no distinguishing signal — `ErrBlocked`, `ErrEpochMismatch` and `ErrUnavailable` all collapse into one generic body (`services/control-plane/internal/middleware/auth.go:70-74`, `abortUnauthorized` `:125-128`) deliberately, to deny an attacker an epoch oracle, so classifying after the fact is **impossible**, not merely inferior. Nor is "fields present" a liveness guarantee: `Op.Commit` retries the owner-scoped CAS once then gives up (`services/control-plane/internal/credepoch/credepoch.go:315-329`), so a Redis outage can leave the blocked marker live for up to `blockedTTL` = 5 min (`:41`) while the handler still returns 200 **with** a valid pair. That is fail-closed and acceptable; the ordinary 401 → `handleRefreshFailure` path is the backstop. Renderer-side handling is in [frontend.md](frontend.md) § "Continuation-token adoption".
- **A transient/connection 401 MUST NOT delete persisted refresh tokens when "Remember Me" is set (#1768).** `apiClient.handleRefreshFailure` (in `src/renderer/services/system/apiClient.ts`) is the SINGLE authority for the disk-token decision: `rememberMe` → `gracefulReset()` ("DO NOT clear disk tokens — session restores next launch"); `!rememberMe` → `nuclearReset()` → `clearTokens()`. Do NOT add a second, rememberMe-blind `electron.clearTokens()` call to any 401 handler — the renderer 401 paths in `userStore.ts` may clear the in-memory access token, but MUST NOT wipe disk tokens. The regression that motivated this: `fetchUser`/`updateProfile`/`changePassword` each called `clearTokens()` after `handleRefreshFailure` had already preserved the session, so a single server-deploy 401 deleted `secure-token.dat` and forced a re-login despite "Remember Me." `clearTokens()` itself stays unconditional (logout wants a full wipe); the discipline is about *who calls it*. **`handleRefreshFailure` is reached only on an _authoritative_ 401 (#1957/#1956).** `apiFetch(path, init, { authoritative: false })` still attempts one refresh+retry but, on failure or inside the refresh cooldown, returns the raw 401 with **no** teardown. Use it only for surfaces whose 401 is not proof the Concord session is dead: third-party content/media proxies (KLIPY GIF proxy, #1957) and best-effort first-party background sync (encrypted preferences, #1956). A preferences-sync-only 401 may leave the renderer locally logged in until the next authoritative API call, but the server still rejects protected actions. User-action Concord API calls default to `authoritative: true`, so genuine expiry is still caught by the next authoritative call. Do NOT route a new content/media proxy or best-effort background sync through plain `apiFetch` when its 401 is non-authoritative — pass `{ authoritative: false }` — and do NOT gate the two `handleRefreshFailure()` teardown sites in `handle401Recovery` on anything other than the `authoritative` flag.
- **The renderer-supplied `apiBase` is origin-pinned in packaged builds (#1872/#1618/#1981 review hardening).** `isValidApiBase` (the `auth:storeRefreshToken` payload guard in `src/main/main.ts`) validates scheme / no-credentials / non-`null`-origin AND, when `app.isPackaged`, accepts only the SaaS control-plane origin (`PRODUCTION_API_BASE`) or a self-hosted origin the user has approved in the main-owned native ceremony. **A successful probe no longer validates an origin (#2354 / ADR-0035).** A self-hosted origin becomes valid only after the user grants it credential custody in the native `dialog.showMessageBox` approval ceremony fired from the `selfHosted:probeServer` handler; the grant is recorded durably in `<pinned userData>/self-hosted-approvals.json` (mode `0o600`, atomic write + re-read-verify, fail-to-**empty** on any read defect) and `commitSelfHostedApproval` is the sole writer of both that file and the in-memory `validatedSelfHostedOrigins` set. A failed write does NOT optimistically update the set and the probe does not proceed. **The grant is durable and there is NO in-app revocation until PR-2** — it never expires, survives SPA rollback / self-heal / restart, and outlives any renderer compromise that obtained it; the dialog is honest about this (*"Concord Voice will remember this choice on this device"*), and a coarse "Forget all" was rejected because it would neither delete `profiles/<sha256(origin)>/secure-token.dat` nor sign the user out. Because the ceremony's moment and displayed origin are attacker-controlled under renderer compromise (ADR-0035 § "Non-property #14b" — `IpcMainInvokeEvent` carries no user-activation signal on Electron 43), revocation is the **compensating control** that bounds the grant's permanence, and PR-2 blocks promoting self-hosting past beta. The ceremony is rationed by a rejecting single-flight on `selfHosted:probeServer` and an in-memory ceremony token bucket (`selfHostedCeremonyBudget.ts`); the single-flight is required, not hardening, because `resolveForDisplay`'s uncancellable `dns.lookup` would otherwise head-of-line-block main's async `fs` IO — credential IO included — with no dialog shown. Renderer input alone never admits a new persisted API origin, and it never admits an update feed. Three main-process requests to a renderer-influenced origin route through the connection-time egress guard (`guardedRequest.ts`/`egressPolicy.ts`) — the probe's two discovery GETs and the `credentials:'omit'` SSO logout (`revokeExplicitSession`) — so for those the address checked is the address dialled on every dial and every redirect hop; this is the desktop port of the Go guard in `backend.md` § "Outbound-request SSRF egress guard". **Coverage is deliberately partial, and the remainder is a known gap, not an oversight:** the four `credentials:'include'` `net.fetch` sites in `ipc/sso.ts` CANNOT move to the guarded transport, because Node's `https` has no cookie jar and Electron session cookies are exactly what those calls carry. They stay on `net.fetch`, unguarded at the egress layer. What bounds them instead is `approvedApiBase`, which admits only the production origin, the current main-owned API origin, or an origin the user approved in the ceremony — so a tier-1 address is unreachable there (the classifier would have refused it at approval time) and a tier-2 address is one the user consented to. Do NOT write "every main-process request is guarded"; closing the remaining four needs a cookie-carrying guarded transport and is outside #2354's scope. Direct Apple/Google SSO is stricter in every build: its main-process handler requires an exact canonical match to the production origin, current main-owned API origin, or an approved self-host origin before starting either provider flow. The binary updater feed is static and app-controlled (#1981), so neither the renderer nor a validated self-hosted API base can steer binary updates; update authenticity is anchored by the public recovery feed plus artifact verification. Dev/LAN builds (`isPackaged=false`) keep the host-agnostic scheme/shape check for `auth:storeRefreshToken`, not for direct SSO. This remains defense-in-depth on the accepted in-renderer-compromise risk; sender-frame validation is still required.
- **Self-hosted auth state is per-origin isolated (#1618).** SaaS keeps the historical root files under pinned `userData` for backward compatibility: `secure-token.dat`, `token-meta.json`, `secure-e2ee.dat`, and `machine-id.json`. Self-hosted origins use `profiles/<sha256(origin)>/` with the same filenames, `token-meta.json` includes `profileId`, and the pinned root carries only the active-profile pointer. `clearTokens()` clears only the active profile. Do NOT move the Electron `userData` root to implement self-hosting; profile isolation lives under the pinned `ConcordVoice` path.

## Path-identity pinning (post-#1291)

The app's **display name** (`productName` / `packagerConfig.name` = "Concord Voice") and its **machine path-identity** (the spaceless "ConcordVoice" used for `userData`, the electron-updater cache dir, and logs) are DECOUPLED and must stay that way. Path-identity is pinned, immutable, and never derived from the mutable display string:

- **userData** — pinned by `src/main/pinUserDataPath.ts`, which calls `app.setPath('userData', join(app.getPath('appData'), 'ConcordVoice'))` as an import-time side effect. It MUST remain `main.ts`'s FIRST import: `tokenManager.ts`, `machineId.ts`, and `updater.ts` capture `app.getPath('userData')` at module load, before `main.ts`'s body runs.
- **Applications-folder suppression** — `src/main/applicationsFolderGate.ts` stores `install-preferences.json` under the pinned `userData` path. Do not derive that path from `productName` or `app.getName()`; the prompt must also run before `BrowserWindow` creation so an accepted `app.moveToApplicationsFolder()` can quit/relaunch cleanly.
- **updater cache** — pinned by `updaterCacheDirName: ConcordVoice` in the generated `app-update.yml` (`scripts/generate-app-update.mts`). On Windows this resolves to `%LOCALAPPDATA%\ConcordVoice\pending`.
- **logs** — already pinned (hardcoded "ConcordVoice" in `updateLogger.ts`).
- **Windows install dir (post-#2402)** — `%LOCALAPPDATA%\ConcordVoice\`**`app`**, pinned at build time by the `customInit` macro in `desktop/build/installer.nsh`. The `\app` segment is load-bearing: it makes the install root a SIBLING of the updater cache above rather than its parent. See § "Windows packaging" below — this is the one path surface that deliberately adds a segment *under* the pinned identity, and removing it re-opens the #2402 failure class.

**Dev multi-client escape hatch (concord-dev.sh `--clients N`).** In DEV ONLY (`!app.isPackaged`), `pinUserDataPath()` honors an explicit `--user-data-dir` and skips the `<appData>/ConcordVoice` pin when one is present (it matches both `--user-data-dir=<path>` and the bare `--user-data-dir <path>` token form). This lets `scripts/concord-dev.sh up --clients N` launch N isolated Electron instances, each with its own userData + its own single-instance lock — pinning over the switch would collapse every instance onto one userData and only one client could launch. `--user-data-dir` is the only reliable per-instance isolation on macOS: `app.getPath('appData')` resolves via the Cocoa API and ignores `$HOME`, and `CFFIXED_USER_HOME` would redirect the login keychain and break `safeStorage`. **The production invariant is enforced** — packaged builds ignore `--user-data-dir` for this pinning decision and ALWAYS pin to `<appData>/ConcordVoice` (ADR-0020). Regression-locked by `desktop/tests/unit/main/pinUserDataPath.test.ts` (cases A–D).

**`concord-dev` synthetic-media default.** The same `_up_clients` rig turns synthetic camera/mic ON BY DEFAULT (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) so video E2EE is testable end-to-end with a deterministic test pattern, all N clients publish without contending for the one real camera, and there is no macOS Camera/Screen-Recording TCC prompt. Opt out for real devices with `CONCORD_DEV_FAKE_MEDIA=0`. In fake-media mode the clients also get `--mute-audio`, because the fake mic beeps and two clients would play each other's beeps aloud; set `CONCORD_DEV_MUTE_AUDIO=0` to hear the call. Real-device mode is never muted. `desktop/scripts/media-policer-probe/probe.mjs` always passes `--mute-audio`, with no opt-out.

**Do NOT** "fix" anything by changing `productName` to alter a path — that is the exact regression that caused the v0.1.38 userData split (commit `72b98f1a`, ADR-0020). `productName` / `packagerConfig.name` control display only. Any new path surface MUST adopt the pinned "ConcordVoice" identity, not `app.getName()`.

**Reference:** [ADR-0020](../../../docs/adr/0020-desktop-app-naming-and-update-cache.md), issue #1291.

## Windows packaging — NSIS, not Squirrel.Windows (post-#2402)

Windows ships an **NSIS** installer produced by the LOCAL maker `desktop/build/makerNsis.ts`. `@electron-forge/maker-squirrel` was removed from `forge.config.ts` and from `package.json` by #2402. The macOS ZIP remains the canonical auto-update artifact, while the install-only DMG now uses the LOCAL maker `desktop/build/makerDmg.ts`; Linux (DEB/RPM/AppImage) packaging is unchanged.

**Why Squirrel had to go — established empirically, not inferred.** Squirrel's `Setup.exe` unconditionally recursive-deletes its own install root before writing ("burning it to the ground", in its own log). electron-updater's download cache is `%LOCALAPPDATA%\ConcordVoice\pending`, which sat INSIDE that root, so the installer tried to delete its own running image; Windows locks a running executable, the delete threw `System.UnauthorizedAccessException`, the exception was unhandled, and the installer process died — the "a window flashes and disappears" symptom users reported. Three controlled trials on a live Windows install (2026-07-24) pinned it down: from `pending\` with the app running → fail; from `pending\` with the app fully exited → fail **byte-identically**; the same file from `Downloads\` → success. App liveness is therefore irrelevant, and Squirrel's own `is the app still running???` diagnostic is misleading — the locked file is the installer, not the app. electron-builder additionally documents auto-update as supported with the NSIS target but **not** with Squirrel.Windows, and Concord delivers updates via electron-updater (which instantiates `NsisUpdater` on win32 and spawns the setup with NSIS lifecycle arguments — `--updated`, `/S`, `--force-run`).

**Secondary finding, recorded so it is not rediscovered:** the same trials showed a *successful* Squirrel update was a full wipe-and-reinstall (`First run, starting from scratch`), so **every** successful Windows update destroyed the electron-updater cache including `current.blockmap`. Differential downloads were therefore **structurally impossible on Windows**, independent of #1292 — every Windows update was a full ~122 MB download, permanently. NSIS does not restore them; it only stops them being structurally impossible. Realizing them needs blockmap generation for the NSIS artifact (out of scope; belongs under epic #1323).

**The install directory is pinned to `%LOCALAPPDATA%\ConcordVoice\app`** by the `customInit` macro in `desktop/build/installer.nsh` (`StrCpy $INSTDIR "$LOCALAPPDATA\ConcordVoice\app"`), wired through the maker's `nsis.include`. Three properties of that pin are load-bearing:

- **The `\app` segment makes install root and updater cache siblings.** NSIS does not wipe its install root — it runs `uninstallOldVersion`, which is scoped to `$INSTDIR` and cannot reach a sibling directory. Install and cache therefore become *structurally incapable* of colliding rather than merely configured not to. Do **NOT** set `$INSTDIR` back to `$LOCALAPPDATA\ConcordVoice`: that re-nests the cache inside the install root and re-opens the same failure class from a new installer.
- **It must be baked into the artifact, not passed as a runtime `/D=`.** `installDirectory` is a property the *running* client sets on `NsisUpdater`, and the migration hop is executed by the OLD Squirrel client, which sets none — so the first NSIS install receives no `/D=`. A runtime `/D=` would take effect only from the *second* NSIS update onward, relocating an app that was already installed elsewhere.
- **NSIS's own default is not viable either.** With `oneClick: true` + `perMachine: false`, `getWindowsInstallationDirName` takes the `sanitizedName` branch and derives the directory from `@concordvoice/desktop`, not `Concord Voice`.

**`artifactName` MUST end in `Setup.exe`.** `build-desktop.yml`'s release signature-verification step globs `*Setup.exe`; electron-builder's default `${productName} Setup ${version}.exe` does not match it. The shipped value is the fixed `ConcordVoiceSetup.exe` (version-less — the release job normalizes and attaches artifacts by its own naming contract).

**Do NOT adopt the published `electron-forge-maker-nsis`.** It exports the Forge-5-era interface (a module-level `isSupportedOnCurrentPlatform` plus a default-export *function*) and throws under Forge 7 and 8, which discriminate class makers on `__isElectronForgeMaker` and otherwise falls to `new MakerClass(config, platforms)` — applying `new` to a function that returns a Promise yields that Promise, leaving `maker.platforms` undefined and throwing `TypeError` on the next line. electron-builder never updated the wrapper for the Forge 6 `MakerBase` migration. The local `MakerNsis` and `MakerDmg` are `MakerBase` subclasses and call `app-builder-lib`'s `build()` **directly**. `MakerNsis` never uses its `buildForge()` helper, which spreads caller options AFTER setting `config.directories.output` and would clobber the output dir, scattering artifacts outside `out/make` and breaking the CI signing glob and artifact normalization. `make()` calls `this.prepareConfig(opts.targetArch)` itself: `MakerBase` keeps the constructor argument on a private field until `prepareConfig` runs, and the call is idempotent with Forge's own. Concord therefore owns a small Forge↔electron-builder adapter for NSIS and a separate local DMG adapter; the NSIS maintenance cost is deliberate and preferred over depending on a wrapper its publisher abandoned two Forge majors ago.

**`electron-squirrel-startup` STAYS.** Only the Forge *maker* was replaced. The `require('electron-squirrel-startup')` guard in `main.ts` remains a runtime dependency — do not remove it as "leftover Squirrel."

**Squirrel residue cleanup runs from the installed app, never from the installer.** `src/main/squirrelCleanup.ts` is invoked from the `createWindow().then(...)` callback in `main.ts`, deferred one further tick via `setTimeout(…, 0)`. Both are load-bearing: the sweep is **synchronous** recursive `rmSync` over `app-*` directories that can total hundreds of MB, so calling it during `whenReady` blocks the main-process event loop before first paint and the app appears to hang on launch. An *installer* that invoked `Update.exe --uninstall` would recursive-delete `ConcordVoice\` while itself executing from `ConcordVoice\pending\` — reproducing the exact `UnauthorizedAccessException` this migration exists to fix. The cleanup is an explicit **allowlist**, never a directory wipe: `Update.exe`, `packages\`, the `Concord Voice.exe` execution stub, `app-N.N.N\` version dirs, `%LOCALAPPDATA%\SquirrelTemp\`, the `Concord Voice LLC` Start Menu company folder, and exactly one `HKCU` uninstall key removed via `execFileSync('reg', [...])` (never `shell: true`). Invariants: it MUST skip `app` and `pending` unconditionally (the `PROTECTED` set), it is idempotent by existence check (no marker file), and it MUST never throw or block startup — failures log PII-safely (message only, never a raw `err`, per `observability.md`). Do NOT reuse `updateSafety.ts`'s `purgeDirectory`, which deletes every entry it finds. The **Desktop** shortcut is deliberately left alone: both installers write `$DESKTOP\Concord Voice.lnk`, so NSIS overwrites it in place and it self-heals; deleting it here would race that overwrite. The `concord://` protocol handler self-heals the same way (`app.setAsDefaultProtocolClient` re-asserts on every launch).

**Trust anchors are unchanged; one accepted gap.** Windows update verification still runs Authenticode via `verifyUpdateCodeSignature` + `ALLOWED_WINDOWS_PUBLISHERS`, `publisherName` in `app-update.yml`, and the static public update feed (#1981). `publisherName` in `forge.config.ts` must stay in lockstep with `src/shared/allowedWindowsPublishers.ts` and `scripts/generate-app-update.mts` — electron-updater reads the allowlist ONLY from the on-disk file, so a divergence silently disables install-time verification (#2020). **Accepted:** the NSIS-embedded uninstaller is unsigned, because signing is a post-build step globbing `out/make`, so UAC shows "Unknown publisher" on uninstall. This is not a regression (Squirrel's `Update.exe` was equally unsigned) but is recorded so it is not discovered as a surprise.

**Release asset contract:** `*.nupkg` is no longer a Windows release asset. It was removed from `build-desktop.yml` (artifact normalization, `required_assets`, and the release attach/verify globs) and from the public-mirror allowlist (`scripts/public-mirror/lib.sh` and the public-overlay release-attestation workflow). Do not re-add it.

**Reference:** [ADR-0034](../../../docs/adr/0034-windows-nsis-migration.md), issue #2402, spec `2026-07-25-2402-windows-nsis-migration-design.md`.

## Auto-Updater
- **Windows cached-installer trust (#2455):** fresh-download `verifyUpdateCodeSignature` requires valid Authenticode, the packaged publisher list supplied by upstream, and the Trusted Signing intermediate pin. The packaged list is generated from the shared `ALLOWED_WINDOWS_PUBLISHERS` constant. Every Windows `safeQuitAndInstall()` attempt independently checks Authenticode, the compiled publisher allowlist, and the intermediate pin, so the packaged list cannot broaden installation trust. Upstream 6.8.9 cache hits bypass its download hook; never treat cached metadata as proof of trust. Install verification captures the pending artifact and generation, blocks overlapping admitted downloads/installs, and rejects stale verification. Rejection clears pending metadata and the prepared sentinel without releasing the quit veto, even if eviction fails. Verification-to-execution is not atomic: a local cache writer can replace bytes before OS execution, including delayed NSIS elevation/shell fallback.
- **Updater cleanup boundary (#2455):** share `UPDATER_CACHE_DIR_NAME = 'ConcordVoice'` between build and runtime. Resolve only `<platform cache>/ConcordVoice/pending` (Windows `LOCALAPPDATA` or `~/AppData/Local`; macOS `~/Library/Caches`; otherwise `XDG_CACHE_HOME` or `~/.cache`), never `userData` or a persisted manifest path. Refuse relative targets and symlink/non-directory application or pending roots; unlink child symlinks without traversing them. Preserve cache-root `current.blockmap`, logs, and historical installation siblings. Report absent/purged/failed honestly. Finalization and deferred cleanup retain the retry marker on failure; rollback and discard do not create one. Stable-path checks do not prevent hostile concurrent ancestor replacement.
- `spaLoader.ts` handles remote SPA hot-update flow
- Validates `spaUrl` over HTTPS + non-legacy path + `spaIpcContract` version match; **no host allowlist** by design (spec §8 defers host pinning; the HTTPS + contract checks are the security invariant)
- Never load unvalidated or untrusted remote URLs
- **Linux update signature verification (post-#653):** Linux update artifacts (`.AppImage`/`.deb`/`.rpm`) are signature-verified **at install** inside Concord's own `safeQuitAndInstall()` (`updater.ts`), before delegating to `autoUpdater.quitAndInstall()`. The client fetches the per-artifact detached Ed25519 signature (`<artifact>.sig`) from the static public recovery feed and verifies it over the downloaded bytes with one `node:crypto` `crypto.verify(null, …)` call (`verifyLinuxSignature.ts`) against the **bundled** public key (`linuxUpdatePublicKey.ts`) — the SOLE trust anchor (holds even without API-host TLS pinning). This is the **out-of-band gate Linux needs** because electron-updater's `verifyUpdateCodeSignature` hook is **Windows-only** (`NsisUpdater`); the Linux/mac updaters never call it. Fail-closed: the only path to install is `verify → true`; every failure refuses the install (identical install boundary). The user message distinguishes a cryptographic `verify → false` (genuine tampering → `{ securityEvent: true, subtype: 'signature-failure' }` security banner) from an availability failure (network/IO or missing/malformed `.sig` → a retryable, non-security "couldn't verify right now" message) so a transient blip does not raise a false tamper alarm — `verifyLinuxArtifact` returns `kind: 'tampered' | 'unavailable'` and only `tampered` reaches the banner. The `.sig` fetch MUST use Electron `net.fetch` against the static public recovery feed — never a renderer-controlled URL, custom session, or Node `https`. See ADR-0026, [`docs/policies/update-trust-model.md`](../../../docs/policies/update-trust-model.md) §Linux, and `docs/runbooks/refresh-linux-update-key.md`. macOS (Gatekeeper/notarization) and Windows (Authenticode allowlist) are unchanged.
- **Remote SPA host (post-#976 / T4a):** the SPA bundle is served by **Cloudflare Pages** at a constant URL `https://spa.concordvoice.chat/index.html`. The per-SHA `/spa/{sha7}/index.html` path on `api.concordvoice.chat` is gone; Pages performs atomic deploys so `SPA_URL` in `spa.env` is now a constant (no `${SHA7}` substitution). `app://concord` bundled-fallback is unchanged. Cross-origin consequence: `spa.concordvoice.chat` must be added to `ALLOWED_ORIGINS` AND `WEBAUTHN_RP_ORIGINS` (passkey login from the remote SPA origin); see Task 7 in issue #976 and deployment rules "Canonical Writer for /opt/concord/spa.env".
- **Pages missing-asset caching guard (post-#2173):** two pieces defend a hashed-asset request that is briefly missing during a deploy-propagation window. **(1)** `desktop/public/404.html` — Cloudflare Pages treats a project **without** a top-level `404.html` as an SPA and serves `index.html` (`200 text/html`) for **every** unmatched path, including a missing `/assets/<hash>.js`; its presence makes a missing path return a **genuine 404** instead (no wrong-MIME `200` executed as a module — the founding #2173 incident: "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html"). **(2)** `desktop/functions/assets/[[path]].js` — a Cloudflare **Pages Function** that forces `Cache-Control: no-store` on the fallback. This is REQUIRED because `public/_headers` marks `/assets/*` `immutable` but is **URL-matched and status-blind**, so *both* the real `200` asset **and** the fallback (`404`/HTML) inherit `immutable` — meaning the 404.html alone would still let a propagation-window client cache an **immutable 404** for hours (still a white screen). The Function passes real assets (`200`, non-HTML) through untouched and rewrites only the fallback (`404`, or any `text/html` at an `/assets/*` path) to `no-store`, so the client recovers on the next request once the asset propagates. It is file-based (NOT a top-level `_worker.js`) so `context.next()` still applies `_headers`/`_redirects`; a `_worker.js` bypasses both. `deploy-spa.sh` runs wrangler with `--cwd desktop` so `functions/` (and `wrangler.toml`) are discovered. Real assets are unaffected and hash-routed navigation is safe (`HashRouter` → the server only ever receives `/`). Regression-locked by `tests/unit/main/spa404Fallback.test.ts` (404.html self-containment) + `tests/unit/functions/assetsCache.test.ts` (the Function). Do NOT delete either, do NOT move the Function into `public/` (it must be compiled, not served as a static asset), and do NOT substitute a `_redirects` `/assets/* … 404` splat: Cloudflare's "redirects are always followed regardless of whether an asset matches" would 404 the **real** assets too.
- **Pages post-deploy propagation check (#2258):** `main-cd.yml` keeps the #2173 missing-asset probe and real-asset verification as separate bounded `8 × 20s` checks. Every real-asset attempt fetches a fresh `/`, extracts that response's hashed JavaScript path, and immediately probes only that path; success requires `200 + immutable`. Missing extraction, a non-200 status, or missing `immutable` retries, and exhaustion fails with the last path/headers. Do not hoist asset extraction outside the retry loop — an index may advance deployment generations while Pages propagates.
- **SPA deploy contract:** see ADR-0001. `spa.env` is a generated artifact (CI-enforced post-#919 via `pr-ci.yml`'s `static-guards` job — formerly the standalone `Verify spa.env contract` job, consolidated by #2065 — which invokes `infrastructure/deploy/verify-spa-env.sh --mode=pr`). Renderer self-heal lives in `src/main/spaSelfHeal.ts` (recovery primitive, R2 retry) + `src/main/spaSelfHealMainFrame.ts` (pure filter helpers) + `src/renderer/spaSelfHealClient.ts` (renderer-side detection). Self-heal modules are host-agnostic — the origin is derived at runtime from `spaUrl`, not hardcoded. Hand-edits to `spa.env` are rejected by the attribution check — for incident-response rollback (post-#919), `gh workflow run main-cd.yml -f break_glass=true -f break_glass_reason="<incident, impact, approver>" -f force=true -f ref=<commit-sha>` (`force` is a STRING per spec Invariant 7).
- **Runtime SPA reload + launch-time retry (post-#1778):** `resolveSpaSource` runs ONCE at launch with a 5s `net.fetch` timeout and no retry; a cold-start network (DNS/TLS/CF-edge not yet warm) loses that race → bundled fallback, sticky for the session. Two recoveries: (1) a bounded **launch-time retry** (`scheduleSpaSourceRetry`, `[4s, 10s]`, `main.ts`) fires only on an *unexpected* bundled fallback (`isUnexpectedBundled`), re-resolves on a now-warm network, and switches bundled→remote; (2) a user-triggered **"Load latest UI"** (Settings ▸ About) via `spa:reloadLatest`, which re-resolves and navigates the live window with no restart. Both go through the single `applySpaDecision(window, decision)` helper — `setRemoteSpaState(url)` BEFORE `loadURL` (load-bearing so will-navigate / PiP / openExternal / SSO / versionInfo origin consumers key on the actual origin), fail-closed to `app://concord`. **Security invariant:** the renderer only TRIGGERS; the `spa:reloadLatest` / `spa:checkForUpdate` IPCs take **zero args** — no renderer-supplied URL — and re-run all of `resolveSpaSource`'s validation, so a compromised renderer cannot choose the origin. `spa:reloadLatest` rejects an untrusted sender frame (`isPermittedFrameUrl`) FIRST. Do NOT add a reload path that accepts a URL from the renderer or that bypasses `applySpaDecision`. `spa:checkForUpdate` reports bundled-vs-remote + a SHA-256 `index.html` byte-diff (`hashEntryHtml`) — a binary "newer UI bytes available", NOT a version (`/client/config` exposes no SPA build id; the SPA URL is constant post-#976). Both IPCs are `app.isPackaged`-gated.
- **No-cache SPA loads + automatic freshness checks (post-#1870):** SPA config fetches, entry-hash fetches (`hashEntryHtml`, which now returns `null` on a non-`ok` response — fail-closed, no false "bytes match"), self-heal remote reloads, and `applySpaDecision`'s `loadURL` all use targeted no-cache options (`net.fetch(..., { cache: 'no-store', headers: no-cache })` and `loadURL(..., SPA_NO_CACHE_LOAD_OPTIONS)` — `spaLoader.ts`), so a deploy is never masked by a stale cached `index.html`. There is no global `session.clearCache()` on the normal path. **`spa:reloadLatest` is no longer user-triggered only:** the renderer's `clientConfigService` now *programmatically* invokes `spaUpdate.checkForUpdate()`/`reloadLatest()` on a schedule — startup, the 5-min poll, window `focus`, and `visibilitychange→visible` — **single-flight**, **rate-limited to 60s** (bypassed only while a deferred reload is pending), and **deferred while a call is active** (voice connecting/connected/reconnecting, screen share, or DM `callState.kind !== 'idle'`). A deferred reload retries on the next check once safe; the deferred intent clears when the server reports no newer bytes OR remote is unavailable (so it cannot stick true and bypass the rate-limit indefinitely). The renderer still only TRIGGERS — the zero-arg, sender-validated, origin-deriving security invariant above is unchanged. Design: #1870 spec.
- **Single-writer invariant for `/opt/concord/spa.env` (post-#994):** see deployment rules "Canonical Writer for /opt/concord/spa.env" — the canonical-writer discipline for all `/opt/concord/<path>` source-of-truth files (`.env`, `releases/`, `spa.env`) lives in `deployment.md` for coherence (PR #1020). Brief: `infrastructure/deploy/deploy-spa.sh` is the SOLE writer; the spa.env rsync uses `--inplace` to preserve the destination inode (required because the file is bind-mounted as a single file in docker-compose.production.yml — an atomic replace creates a new inode the mount cannot see, the #1315 root cause). The SPA bundle itself now lives on Cloudflare Pages, NOT at `/opt/concord/spa/`; that bundle directory and `SPA_DIR` config were removed in #976.
- **macOS differential updates (post-#1292):** macOS releases carry a sibling `ConcordVoice-<v>-macos-<arch>.zip.blockmap` (electron-builder-format content-defined block manifest). It is generated in the **release job** of `build-desktop.yml` via the `app-builder-bin` devDependency — run against the *normalized* `.zip` after `Normalize artifact filenames` and before manifest generation (so the name is correct with no build-job changes), then attached to the GitHub Release and synced by `sync-releases.yml` unchanged. `latest-mac.yml` advertises `blockMapSize` per the optional field in `desktop/schemas/update-manifest.json` (the manifest generator stats the sibling `.blockmap`). electron-updater fetches the NEW version's `<zip-url>.blockmap` (200, not 404) to perform changed-block downloads instead of a full ~122 MB download; `internal/updates/handler.go` serves it as `application/octet-stream` (binary 24h cache, unchanged). **Bootstrap (do NOT mistake for a regression):** the macOS differential path also needs the *previous* version's blockmap — from the client-local `current.blockmap` cache, or (fallback) the server. `current.blockmap` is empty until the first post-blockmap update completes, and `sync-releases.yml`'s `rsync --delete-after` keeps only the latest release's blockmap (server-fetch fallback 404s), so differential engages from the **second** consecutive update a client receives after this ships; the fallback is always a safe full download. Realized byte-savings are unmeasured/not guaranteed positive (post-hoc blockmap over a forge-built zip). Server-side N-1 blockmap retention in `sync-releases.yml` (a deployment rules-governed canonical-writer change) lands in the lockstep companion PR #1564 — with it, the server-fetch fallback works and differential engages one hop earlier. Do NOT migrate the artifact toolchain to electron-builder to "improve" this (ADR-0020 D4-b, rejected). See [ADR-0020 §D4-a](../../../docs/adr/0020-desktop-app-naming-and-update-cache.md) and #1292 spec §7.
- **Public-mirror releases (post-#1667/#1981/#654/#2048):** signed desktop
  releases (v0.2.0+) are mirrored to the public
  `Concord-Voice/Concord-Voice` Releases page by `main-ci.yml` calling
  `.github/workflows/publish-public-mirror.yml` beside the production asset
  sync after `build-desktop.yml` reports a successful release and its tag.
  `build-desktop.yml` retains the same direct call only for standalone manual
  release dispatches. The workflow's `release:published` trigger remains a
  backup for non-`GITHUB_TOKEN` publishers, but `workflow_call` is the normal
  path because `GITHUB_TOKEN`-created releases do not reliably trigger
  downstream workflows (#1601 class). The path is the `release-mirror` job in
  `.github/workflows/publish-public-mirror.yml` →
  `scripts/public-mirror/mirror-release.sh` (version-floor + asset allowlist +
  leak-safe notes live in `scripts/public-mirror/lib.sh`, regression-locked by
  `test-mirror-release.sh`). The public mirror release is published
  **non-prerelease** so `/releases/latest` resolves; existing immutable public
  releases are verified, not clobber-uploaded. `UpdateSecurityBanner.tsx`'s
  `DOWNLOAD_URL` points at that public page, and packaged `electron-updater`
  uses the same public `releases/latest/download` feed. API-host `apiBase`
  never steers binary updates. After #654, the release-mirror job dispatches
  the public repo's `public-release-attestation.yml` workflow and verifies each
  public release asset with signer-workflow constraints before the mirror job
  can trigger the marketing-site rebuild; this is public distribution
  provenance, not Alpha-private build provenance. Design:
  #1667 spec.

## Desktop packaging trust split (#2274)

Pull requests package only through the fixed `pr-smoke-build` macOS-arm64 job.
That job is deliberately unsigned and read-only: no environment, signing
secret, OIDC, attestation, artifact upload, release, publish, or promotion edge
may be added. `pr-smoke-result` remains the fail-closed required sentinel.

Signed releases use a separate static six-platform `release-build` matrix:
Windows, macOS, and Linux at both x64 and arm64. `build-desktop.yml` is
**dispatch-only** for releases (post-#2274 hotfix): the trusted path is a
`workflow_dispatch` run on exact `refs/heads/main`, either dispatched by
`main-ci.yml` after all scan/build/Sonar gates (binding its gated commit via
the `expected_sha` input, which `detect-release` verifies fail-closed against
main HEAD) or dispatched manually by an operator (empty `expected_sha` =
release current main HEAD). `workflow_call` is forbidden — a called workflow's
`secrets` context never receives `desktop-release` environment secrets even
though the environment binds for OIDC (#2048 class; third incident v0.2.29).
Every release leg checks out `${{ github.sha }}` and then verifies exact HEAD.
Only `release-build` and `release` may use `desktop-release` or signing values.
The release job consumes same-run `release-build` artifacts only; PR and
cross-run artifacts are never promoted. `GOOGLE_OAUTH_CLIENT_SECRET_DESKTOP`
resolves at repository scope directly inside the standalone run and is
non-signing native build configuration, not part of the
`desktop-release` inventory. See ADR-0032.

## Supply-chain hardening (GitHub Actions)

- Every repository-qualified action referenced in `.github/workflows/**`, `.github/actions/**`, or the public-mirror overlay MUST be pinned by full commit SHA per #847, including GitHub-owned `actions/*` and `github/*` actions. Enforcement is a **single upstream Semgrep rule** — `yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag`, carried by the `p/owasp-top-ten` pack **only** (`p/security-audit` does not contain it), at `WARNING` severity. [`semgrep.yml`](../../../.github/workflows/semgrep.yml) runs it un-excluded; findings reach Code Scanning as tool `Semgrep OSS` / category `semgrep-community`, where the Alpha Code Scanning Gate blocks merges at `errors_and_warnings`. The community step's in-job "non-blocking" comment refers only to that step's exit code — the ruleset blocks, the job does not. Because the pack is fetched from the registry at scan time and `SEMGREP_VERSION` pins only the engine, an upstream removal or downgrade would delete that gate with no repo-side signal; [`.semgrep/tests/action-ref-canary.test.yaml`](../../../.semgrep/tests/action-ref-canary.test.yaml) plus the canary step in the same workflow assert on every PR that the rule still fires AND still permits full SHAs and local `./` refs, failing closed otherwise (#2426). The trailing `# vX.Y.Z` comment is load-bearing for Dependabot and human reviewers: keep it accurate and **BARE**. Dependabot rewrites only a trailing comment matching exactly `# vX.Y.Z`; put explanatory annotations on their own line ABOVE `uses:`. Founding incident: #2309 left eight stale CodeQL version comments because each had a suffix after the version. The SonarQube detect-secrets pragma must likewise remain on its own preceding line. The bare-comment convention is review-enforced, not linted.
- Local actions (`./.github/actions/<name>`) are first-party by construction — they live in this repo and pass through normal PR review. No pinning required.
- **Upgrade procedure:** see `docs/runbooks/upgrade-sha-pinned-action.md`. The runbook covers: when to upgrade, pre-flight checks, SHA resolution via `gh api`, provenance verification, the `supply-chain upgrade` PR label contract, smoke-dispatch path per action category, and rollback procedure.
- Do not upgrade SHA-pinned actions speculatively. Each upgrade is a supply-chain trust delegation; the operational cost of "staying current" is non-trivial.

**Custom base images (post-#1166):** the SHA-pin discipline extends to Docker base images that Concord publishes to GHCR. Consumer Dockerfiles MUST reference the published image by manifest digest (`FROM ghcr.io/.../<name>@sha256:<digest>`), not by floating or date-stamped tag. The first such image is `ghcr.io/concord-voice/node-buildtools` consumed by `services/media-plane/Dockerfile` (migrated from `ghcr.io/markdrogersjr/node-buildtools` in PR #1348 — namespace moved to the Concord-Voice org; old namespace remains readable for historical builds); refresh procedure at `docs/runbooks/refresh-buildtools-base.md`, discipline cross-referenced from media-plane rules §"Custom base image discipline".

**Build-time dependencies in the desktop signing pipeline (post-#2402):** the same pin-the-artifact discipline extends to npm build dependencies that participate in the signed release. `app-builder-lib` is a `desktop` **devDependency** consumed by the local NSIS and DMG makers (`build/makerNsis.ts` and `build/makerDmg.ts`, see § "Windows packaging" above) and is declared with an **exact version, no caret** — `"app-builder-lib": "26.15.3"`. The pin is mandatory, not stylistic: the desktop build *is* the signing path (the `desktop-release` environment, Azure Trusted Signing, Apple notarization — ADR-0032), so a build-time dependency that floats on `npm ci` is a supply-chain exposure rather than a developer-convenience question. Pinning forces every version change to arrive as a reviewable dependabot PR triaged through `/weekly-deps` — the same governance shape as the digest-pinned `node-buildtools` base image above (pin the artifact, review the bump, never float; the difference is the refresh trigger — dependabot proposal or CVE, not a quarterly cadence). Scale of the delegation, measured 2026-07-25: a 214-package tree of which **48 were net-new**, including targets Concord does not use (`dmg-builder`, `electron-builder-squirrel-windows`) that arrive as declared dependencies and cannot be pruned selectively. The existing `npm audit` gate and Shai-Hulud IOC scan cover the new tree automatically once it is in the lockfile. Do NOT relax the pin to `^`, and do NOT add another build-time dependency to the desktop signing pipeline without the same exact-pin-plus-recorded-here treatment. Decision of record: [ADR-0034](../../../docs/adr/0034-windows-nsis-migration.md) (accepted by repo admin 2026-07-25 with exactly these two obligations).

**Upstream public-registry images on the deploy path are pinned by exact tag plus digest.** Every `FROM` in a deployable Dockerfile, and every `image:` that the shared `docker-compose.yml` runs on a managed or self-hosted host, names an exact version and its index digest (`redis:8.10.2-alpine@sha256:…`), never a floating tag such as `redis:7-alpine`. A floating tag does not float on a long-lived host. Compose pulls only a missing image, and a deploy rebuild (`concord-ctl.sh` runs `up --build`) reuses the cached `FROM`, so the host keeps whatever it first pulled. The digest makes the running version a reviewed fact and each change a diff. Dependabot keeps the pins current: the `docker` blocks cover Dockerfiles and the allow-scoped `docker-compose` block covers `redis` and `nats` (see deployment rules § Dependabot coverage and cadence). The accepted cost is a dependency-container restart on the first deploy after each merged bump.

- **Outside this rule:** the `tools` profile (`pgadmin`, `redis-commander`, local debugging only), `docker-compose.failover.yml` (an optional HA overlay that no deploy script loads), and CI service containers.
- **Own discipline, unchanged:** Concord-published bases (above), MinIO (#1220), and coturn, whose exact image and digest `copy-certs.sh` checks as the TLS key target's identity. Dependabot's compose block excludes MinIO and coturn for those reasons.
- **History:** this replaced a rule that exempted upstream bases from digest pinning as more burden than value. By then every deployable Dockerfile base except postgres already carried a digest, and the cache-reuse behavior above meant the floating tags were frozen rather than current.

**Buildtools publisher parent (post-#3283).** `infrastructure/docker/buildtools/Dockerfile` pins its parent as `FROM node:<tag>@sha256:…`, which also satisfies Scorecard's `PinnedDependencies`. Beyond the rule above, re-resolving that digest is a **mandatory pre-dispatch step** of the refresh procedure, because that image is one Concord **publishes**: its parent pin controls the provenance of an artifact Concord's own consumers then digest-pin against. Ordering is load-bearing — the publish builds from the committed digest, so a stale pin publishes a stale image and is caught only after the push. See the refresh runbook §3 and §10. The `node` major is deliberately not named here; it is derived from that Dockerfile's own FROM line by the publish workflow.

## `always()` and explicit dependency-result checks (#1077, #2730)

Jobs that must report a result after a dependency fails or skips MUST account
for GitHub Actions' implicit transitive-skip behavior: use a justified
job-level `always()` and explicitly inspect the needed jobs' results. Put the
success checks where they match the job's role: privileged release jobs check
success in the job condition; an unprivileged result reporter can always run,
then check every required result in its step. The #2730 PR build requirement
uses this pattern in a workflow sourced from protected `main`; a reporter in
PR-owned `pr-ci.yml` would not be an independent merge authority because the PR
could change its condition or logic. The trusted workflow does not run
SonarCloud against partial coverage. See ADR-0018
and the design.

Release jobs in `.github/workflows/build-desktop.yml` (and any future workflow
that fans out through detection and build phases) MUST combine `always()` with
explicit per-need `.result == 'success'` checks in the job condition. This
preserves the ADR-0004 anti-cascade-skip contract without weakening the #2274
trust boundary.

**Required pattern for release jobs:**

```yaml
release:
  needs: [detect-release, release-build]
  if: >-
    always() &&
    github.repository == 'Concord-Voice/Concord-Voice-Alpha' &&
    github.ref == 'refs/heads/main' &&
    github.event_name == 'workflow_dispatch' &&
    needs.detect-release.result == 'success' &&
    needs.release-build.result == 'success' &&
    needs.detect-release.outputs.should_release == 'true'
  # ... privileged signing + GitHub Release creation steps
```

**Required pattern for result reporters:** keep the reporter unprivileged and
make its step fail unless every required upstream job succeeded. In
`.github/workflows/required-pr-build.yml`, the reporter checks IOC, build, and
the warning publisher after `always()` admits it. SonarCloud remains a separate
org-required App check and continues to skip when the ordinary PR build fails,
preserving its full-coverage requirement. The workflow itself is sourced from
protected `main` by an Alpha-only organization ruleset; activation and
post-merge canaries are documented in the branch-protection policy.

**Why this matters:**

- `always()` prevents GitHub's implicit transitive-skip behavior from bypassing
  the job before its explicit classification logic runs.
- The `detect-release` and `release-build` success checks are mandatory with
  `always()`; bare `always()` would admit failed or cancelled trusted builds.
- Exact repository/ref/event guards remain mandatory. In particular,
  `result != 'skipped'` is invalid because it also accepts `failure` and
  `cancelled`.

**The `should_release` typing foot-gun:**

- `should_release` is emitted as a shell string (`"true"` or `"false"`), so compare as `needs.X.outputs.should_release == 'true'` (string literal), NOT bare `needs.X.outputs.should_release` (which truthiness-tests the string presence, not its value — both `"true"` and `"false"` are truthy strings).
- Same class of foot-gun as `workflow_dispatch` input booleans (project memory "workflow_dispatch needs default branch" + "Workflow PRs need real-dispatch test"): GHA's `inputs.<name>` is always a string when sourced from `workflow_dispatch`, never a real boolean.

**Justification-comment requirement (#920 §5.3):** Every `always()` in a
workflow MUST carry an inline justification comment explaining the
transitive-skip behavior and the explicit result checks that replace implicit
`success()`. Without it, the workflow lint hook rejects the file.

**Reference:** ADR-0004 Desktop release contract. Founding incident: PR #889 merged 2026-05-08 introduced `pr-paths-filter`; v0.1.36 / v0.1.37 / v0.1.38 were stranded (bumped on main, never tagged) until PR #1077 corrected the cascade-skip discipline.

## `app://` scheme for bundled SPA serving (#830)

The bundled-fallback renderer (when `spaLoader` decides `mode: 'bundled'`) loads from `app://concord/index.html` rather than `file://`. The `app://` scheme is registered in `desktop/src/main/main.ts` (top-level, before `app.whenReady`) via `protocol.registerSchemesAsPrivileged` with the privileges:

- `standard: true` — URL parsing, document loading semantics
- `secure: true` — treated as a secure context (WebCrypto, ServiceWorker)
- `supportFetchAPI: true` — `fetch()` works from `app://` pages
- `corsEnabled: true` — browser issues CORS preflights from `app://` origin (load-bearing for the bug fixed by #830)

The protocol handler (`protocol.handle('app', ...)`) delegates to `appProtocol.ts`'s pure resolver, which validates the host (must be `'concord'`), rejects path-traversal (raw `..`-segment scan with case-insensitive scheme/host slice for defense-in-depth, plus `path.resolve` boundary check), and resolves to an absolute path inside the asar bundle root. Files are served via `net.fetch(pathToFileURL(absolutePath).href)` so asar paths resolve transparently and Windows drive-letter paths are handled correctly.

**When to use `app://` vs `file://` vs HTTPS:**

| Surface | URL | Why |
|---------|-----|-----|
| Bundled SPA (packaged build, fallback path) | `app://concord/index.html` | Renderer must have a non-`null` `Origin` for browser-CORS to work against the server's allowlist |
| Cached SPA (packaged build, signed LKG cache, #1880) | `spa-cache://concord/index.html` | Same non-`null`-`Origin` / browser-CORS rationale as `app://concord`; the cache origin must be in the server allowlists too (#1889) |
| Remote SPA (packaged build, hot-update path) | `https://spa.concordvoice.chat/index.html` (Cloudflare Pages, constant URL post-#976) | spaLoader validates https + contract; no host allowlist by design |
| Dev mode | `http://localhost:3001` (Vite) via `loadDevRendererWithFallback` | The `app://` scheme is gated on `app.isPackaged`, so it does not exist in dev |

**Adding new bundled-asset URLs:** to load a new bundled path, use `app://concord/<path>`. The path resolves to `<bundle-root>/<path>` after path-traversal rejection. Do NOT use `file://` for bundled assets in packaged mode — that origin is `null` and breaks CORS.

**API URLs fed to `<img>` / `<video>` / `<audio>` `src` attributes MUST be absolute.** Browsers resolve relative URLs against `document.baseURI`, which is the renderer origin. In bundled mode that origin is `app://concord/` — the `app://` protocol handler only resolves to asar bundle files, so a relative `/api/...` path dead-ends at the protocol handler with `net::ERR_UNEXPECTED` (the founding incident: #1100, fixed by PR #1102). Use `runtimeServerBase.ts` helpers (`apiUrl`, `mediaUrl`, `getApiBase`) so SaaS/default builds use `API_BASE` and validated self-hosted sessions use the selected origin. Fetch-via-`apiClient` is unaffected because it prepends the active runtime API base itself; this rule applies specifically to URLs that bypass `apiClient` and flow into HTML element `src` props (e.g., the KLIPY media proxy via `rewriteMediaUrl` in `services/messaging/gifProvider/klipyClient.ts`).

**Avatar/banner/icon display (post-#1586):** the same class bit profile/server media, not just KLIPY. The control-plane emits avatar/banner/server-icon URLs as relative `/api/v1/media/{avatars,banners,server-icons}/*` paths (the documented contract, accepted by the `MediaURL` zod schema in `types/ws-events.ts`), and the renderer rendered them raw in `<img src>` across ~19 components (~23 sites) — broken on the remote SPA (resolved against `spa.concordvoice.chat`, not the API host). #1102 only covered KLIPY/attachments. Fix: the dedicated **`resolveMediaUrl`** helper (`src/renderer/utils/ui/resolveMediaUrl.ts`) — delegates leading-`/` paths to `runtimeServerBase.mediaUrl()` so they use the active runtime API base, passes `data:`/`blob:`/`http(s)://` through unchanged, returns `undefined` otherwise (at least as strict as the `MediaURL` schema on dangerous schemes — `javascript:` etc. never reach an `<img src>`). Every direct media `<img src>` wraps it; `useImageUpload` applies it to its `preview` (display) while keeping `imageUrl` (the wire value re-sent to the server) **relative** — do NOT absolutize `imageUrl`, that round-trips an absolute URL back to the server and breaks the relative contract. A renderer ESLint `no-restricted-syntax` guard fails a raw media `<img src>` whose `src` references a known server-media field (`avatar_url`/`avatarUrl`/`header_image_url`/`icon_url`/`banner_url`/`server_icon`) — when introducing a new server-media field name, add it to that selector (regression test: `desktop/tests/unit/main/eslint-resolve-media-url.test.ts`).

**Sender-frame validators:** `isValidPipOpenSender` (in `pipUrl.ts`) accepts `app://concord` as a valid origin in packaged + bundled mode using `sender.protocol === 'app:' && sender.host === 'concord'`. The straightforward `sender.origin === 'app://concord'` does NOT work — WHATWG URL spec returns the literal string `"null"` for `URL.origin` on non-special schemes (verified in #830 Task 5 development). `isPermittedFrameUrl` (in `frameValidation.ts`, the shared attestation/sso/openExternal validator) accepts `app://concord` via the **same** `protocol === 'app:' && host === 'concord'` parse. Both validators additionally accept `spa-cache://concord` (the signed LKG cache origin, #1880) via the identical protocol+host parse against `SPA_CACHE_SCHEME`/`SPA_CACHE_HOST` (`frameValidation.ts` `isBundledAppUrl`, `pipUrl.ts`). So the validator inventory is: `isValidPipOpenSender` and `isPermittedFrameUrl` **accept** `app://concord` **and** `spa-cache://concord`, while `validateSelfHealSenderFrame` (in `spaSelfHealMainFrame.ts`) intentionally **rejects** both because bundled mode is the terminal state of self-heal — there is no further fallback to recover to. (`isPermittedFrameUrl`'s acceptance resolved the #806 deferral; before it, the bundled build's per-request `attestation:get-token` IPC threw "untrusted sender frame" and, because the renderer awaited that optional token unguarded, bricked all API connectivity — the founding outage.)

**Server-side requirement:** the server's `ALLOWED_ORIGINS` must include `app://concord` for browser-CORS to succeed. The code default in `services/control-plane/pkg/config/config.go` includes it for dev/test/CI; production env var must be updated separately by the operator before shipping a client build with the `app://` scheme registration.

The signed LKG SPA cache origin `spa-cache://concord` (#1880) carries the **identical** requirement and is mirrored alongside `app://concord` on every allowlist surface — the `ALLOWED_ORIGINS` dev default (`config.go`), the production compose literals for both control-plane and media-plane, and the `WEBAUTHN_RP_ORIGINS` compose default (`docker-compose.production.yml`) — landed by #1889 **before** the cache is activated. Operator caveat: a *set* `WEBAUTHN_RP_ORIGINS` production secret overrides the compose default, so that secret value must also carry `spa-cache://concord` before activation, else passkey login from the cached origin fails. (Mirrors the `app://concord` operator step above.)

The mobile app's origin `app://concord-mobile` (#206) rides the same `ALLOWED_ORIGINS` surfaces (dev default in `config.go`, the production and West-staging compose literals for both planes, the public overlay and `deploy.env.example`). A native iOS WebSocket otherwise sends an `Origin` derived from the server URL, which the control plane's `CheckOrigin` rejects with 403 unless that host happens to be listed, so the mobile client must send this fixed origin explicitly. Browsers cannot forge it: a web page's `Origin` is always its own scheme and host. It is **not** added to `WEBAUTHN_RP_ORIGINS`, because a native passkey ceremony is bound to the app's associated domain, not to this origin. An operator who sets `ALLOWED_ORIGINS` explicitly must add `app://concord-mobile` before mobile clients connect.

**WHATWG URL gotchas to remember:**
- `URL.origin` for non-special schemes returns `"null"` (literal string). Use `protocol === 'app:' && host === 'concord'` instead.
- `URL.pathname` silently strips `..` segments during construction. Defense-in-depth requires inspecting the raw URL string for `..` before parsing.
- Non-special schemes preserve host case (unlike `http`/`https` which normalize to lowercase). Use case-insensitive comparison for the scheme/host prefix slice.

**Reference:** spec at `docs/superpowers/specs/2026-05-02-830-bundled-spa-cors-design.md`, issue #830.

## Machine Identity
- `machineId.ts` provides device binding via hardware fingerprint
- Machine ID is UUID format, validated by server middleware

## External-link scheme policy (#754)

The desktop client has four external-link surfaces, with different scheme policies justified by different consent models:

| Surface | File | Allowed schemes | Why |
|---------|------|-----------------|-----|
| `setWindowOpenHandler` | `src/main/main.ts` (`externalizeWindowOpen`, registered on every window in `web-contents-created`) | `https:` | Passive nav — fires for `<a target="_blank">` and `window.open()`. |
| `will-navigate` (with externalization safety net) | `src/main/main.ts` (`web-contents-created` → `will-navigate` listener) | `https:` | Passive nav — fires for redirects, programmatic nav, bare `<a>`. |
| `open-external` IPC | `src/main/ipc/openExternal.ts` | `http:`, `https:`, `mailto:` | User-initiated — fires only on explicit click of a Markdown-rendered link. The click is consent. |
| Billing launcher | `src/main/billing/billingWindow.ts` | `https:` (`window.open` and downloads go to the OS browser; main-frame navigation allowlisted to the Stripe custom domain and 3DS host) | Hosted Stripe pages only; the return URL is intercepted. |

**Rationale:** the navigation handlers fire passively (no button was clicked — a redirect or programmatic nav happened). Stricter posture is appropriate because the user has not exercised conscious consent. The IPC handler fires only on explicit user click of a visibly-rendered Markdown link; the user has read the URL and decided to proceed. Different consent model → different scheme posture.

**When adding new external-link surfaces:**
- If the surface fires passively (browser-default navigation, programmatic JS, redirects), adopt `https:`-only.
- If the surface fires on explicit user click of a UI element that displays the URL, the broader `http:`/`https:`/`mailto:` policy is acceptable (with sender-frame validation).
- Renderer code: use `<a target="_blank" rel="noopener noreferrer">` as the canonical pattern. The `no-restricted-syntax` rule in `eslint.config.mjs` enforces this for bare `<a href="https://...">` literals.
- **Server-stored (user-supplied) URLs MUST route through the `open-external` IPC handler** (`window.electron.openExternal(url)`) in an `onClick`, in addition to carrying `target="_blank" rel="noopener noreferrer"`. `setWindowOpenHandler` is `https:`-only and silently drops legacy `http://` URLs; the IPC path accepts `{http, https, mailto}` because the explicit user click is consent. Prior art: `SafeLink.tsx` (Markdown links) and `UserProfileModal.tsx` (profile links, post-#775).

## Accepted risk: in-renderer compromise

A compromised SPA bundle that executes `window.location = 'https://evil.example'` will trigger `will-navigate`, which (after #754) externalizes `https:` URLs to the OS browser. The user's OS browser would open the attacker-controlled URL.

**This risk is accepted** because:

- A compromised renderer has many higher-leverage attacks available (DM key extraction via the `e2eeService`, IPC abuse to existing privileged channels, exfiltration of `localStorage`-staged secrets through attacker-controlled fetch URLs). Phishing-via-redirect is not where defense budget should be spent.
- The OS browser is the user's own trust environment — separate process, separate cookie jar, separate password manager. Routing a URL there is materially safer than rendering it in the Electron sandbox.
- The threat model for #754 (per its design spec §6.1) explicitly scopes to drift defense, not in-renderer compromise.
- Mitigated upstream by the static public binary update feed plus artifact verification, and by the SPA loader's strict origin validation against the server-supplied `spaUrl`.

**If this risk profile changes** (e.g., a future feature elevates the renderer's attack surface), revisit `will-navigate` to either suppress externalization for programmatic navigation or introduce a host allowlist (Option B/C from #754's brainstorm).

See `docs/superpowers/specs/2026-04-26-754-externalize-blocked-nav-design.md` §6.

## CI runner discipline (ADR-0005 §3 / ADR-0013)

This section is the durable, review-enforced home for the runner-tier rule; the **rationale of record** lives in ADR-0013 (the *which*) and ADR-0005 (the *when*). Enforcement is by the `deployment-config-reviewer` agent at review time — **NOT** by this file's frontmatter glob, which is scoped to `desktop/**` and so does NOT auto-load when a `.github/workflows/**` file is edited. (The placement follows ADR-0013 §8's explicit instruction; the glob mismatch is a known limitation mitigated by the agent.)

**Inherit-by-default (ADR-0013 §8).** When adding or editing a workflow job, select the runner by job class from the matrix below. **Standard `ubuntu-latest` is the default and needs no justification.** Any deviation — a larger SKU, `macos-*-large`/`-xlarge`, self-hosted, or a Blacksmith `blacksmith-Nvcpu-ubuntu-2404` label — MUST carry an inline comment citing ADR-0013 + the ADR-0005 §3 evidence. Native `ubuntu-latest-arm64` for genuine arm64 correctness/fidelity work needs only a one-line comment citing ADR-0013 §3 (no measurement bar — it is a correctness choice; it is a *managed* runner that bills from minute 1, so keep it off high-frequency jobs).

**Per-job-class matrix (ADR-0013 §2 — abridged; the ADR is canonical):**

| Job class | Runner | Why |
|---|---|---|
| Lint / scan / verify / detect | `ubuntu-latest` / pinned Blacksmith | most short jobs use 2 vCPU; whole-module Go lint uses 4 vCPU after a measured CPU-bound profile |
| Unit / integration test | `ubuntu-latest` / pinned Blacksmith | shard first; measured desktop CPU demand supports 8 vCPU, and per-package Go databases allow `-p 2` on 4-vCPU shards |
| Static-analysis, server-side (SonarQube) | `ubuntu-latest` / pinned Blacksmith | wall-clock is SonarCloud server-side; runner size cannot help |
| Electron build — Linux/Windows legs | `ubuntu-latest` / `windows-latest` | low freq, not compute-bound |
| Electron build — macOS legs | `macos-latest`; larger is measure-first | only memory-pressured + human-blocking surface |
| Docker cache-cold (compose stack) | measured Blacksmith tier; currently 16 vCPU | preserve `--no-cache` and the local builder; Codesmith measured sustained CPU demand on 8 vCPU (ADR-0016) |
| arm64 smoke / native-arch test | native `ubuntu-latest-arm64` | QEMU is buggy (#1359) + slow; native is correct + faster |
| Deploy / provision / sync / dispatch ops | `ubuntu-latest` | network/SSH-bound; runner compute irrelevant |

**Evidence bar for any sizing change (ADR-0005 §3).** Before merge, a runner-sizing change (SKU up/down, self-hosted, or a Blacksmith label change) MUST: (1) update this section if the rule itself changes; (2) link a before/after p95 wall-clock measurement artifact for the affected job(s); (3) record the cost-delta calculation in the PR/issue body. **A "CPU looks idle" observation is NOT sufficient evidence to downsize** — first verify the job is not server-side-latency-bound or timeout-cliff-exposed. The `sonar` and control-plane `Test + Coverage` jobs are the canonical traps (see their inline guard comments + ADR-0016).

**Founding application (2026-06-17 CI deep-dive, T2).** A proposal to downsize `sonar` and control-plane `Test + Coverage` 4→2 vCPU was **DECLINED**: sonar is server-side-bound (a downsize buys nothing and risks the #1381 timeout-cliff) and control-plane is CPU-bound (measured −43% on 4 vCPU; a downsize regresses it). Both are pinned at 4 vCPU with inline guard comments. An 8 vCPU control-plane *upsize* is a separate measure-first trial (ADR-0016 Action Item 2 / #1414). Full analysis: `docs/superpowers/reports/2026-06-17-pr1583-ci-deepdive-design.md`.

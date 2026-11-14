> ADR number provisional — re-grep docs/adr across all org checkouts before merge.

# ADR-0052: Exclusive capture lease and owner-bound main resources

**Status:** Proposed
**Date:** 2026-11-11
**Deciders:** Mark (project lead)
**Issue:** Desktop#87 (child of Self-Hosted#59)
**Spec:** `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md`
**Plan:** `docs/superpowers/plans/2026-11-09-87-capture-lease-and-resource-budgets.md` (its
"Reconciliation against #86 as built", RC-1..RC-15, records where the code differed from the spec)
**Related:** #86 ([ADR-0051](0051-connection-context-isolation.md)), #88 (connections UI), #90
(SSO journeys and the loopback/MFA rewrite), [ADR-0043](0043-per-process-screen-share-audio-capture.md)
(per-process screen-share audio), ADR-0035 (main-owned trust ceremonies; `IpcMainInvokeEvent`
carries no user-activation signal)

## Context

After #86 each connection is its own document on its own Chromium `Session`, which isolates
network, storage, credential custody and IPC authority. #86 leaves shared the things the OS has
one of: the microphone, camera and screen; the single audio-capture child (`audiocapHost.ts`);
the loopback OAuth listeners (`ipc/sso.ts`); and the tray.

#86 fenced part of this. `media:getDesktopSources` and `audiocap:start` are `app-global-mutate`
(foreground only), and `audiocap:start` refused while another connection owned a live share
(ADR-0051 S-1). But #86's default `captureArbiter` allowed every bound `media` request, and an
off-document permission check (`webContents === null`) answered the static policy, which is true
for `media` and `display-capture`. So CVNet, self-hosted A and self-hosted B could each call
`getUserMedia` and publish the same microphone to three servers, and a compromised renderer in a
background connection could open the microphone while the user watched another connection.

The binding maintainer decision (2026-11-08) is an **exclusive** lease: one connection holds
microphone, camera and screen capture at a time. Joining voice on another connection asks the
user to move capture there. There is no simultaneous publication and no cloned capture.

## Decision

**Option C: explicit IPC, the permission handlers as backstop, and a native ceremony.**

- **D1 — Native ceremony.** A `voice-join` acquire against a held lease runs
  `dialog.showMessageBox(shellWindow(), …)` in main (`captureCeremony.ts`): "Join voice on {B}?",
  `&Stay on {A}` / `&Join on {B}`, `normalizeAccessKeys: true`, Stay is `defaultId` and
  `cancelId`, no timer. The `signal` is aborted only by main: on the requester's generation
  advance and on quit. Labels come only from main (`'Concord Voice'` or the punycode `URL.host`
  of `ServiceRecord.origin`).
- **D2 — One lease** covers microphone, camera and screen.
- **D3 — The previous holder leaves voice.** There is no listen-only join on B while A holds
  capture.
- **D5 — No cross-service identity reaches a renderer.** Renderer copy says "connection",
  "call", "microphone". Lease pushes carry `{ held, mine }` only, and go only to the holder, the
  foreground primary, and once to a connection whose own lease just ended (R6).
- **D6 — Budgets cover main-owned resources only.** No ledger: the owning maps hold at most one
  entry per connection, and `mainResourceCounts()` reads them for tests (R9).
- **D7 — Loopback supersede.** At most one ephemeral OAuth loopback per connection: a newer
  sign-in on the same connection closes the older listener, and a superseded port answers like
  an unknown one (`ipc/sso.ts`). Listeners are never shared across connections.
- **D8 — The tray follows the holder.**

### As built

- **Lease module.** `desktop/src/main/captureLease.ts` is the one authority, keyed on #86's
  `ConnectionRef` and bound with `bindOwner('capture-lease', ref)`. The holder carries a claims
  set (`'voice-join' | 'device-test'`, R4) and a `legacy` flag. No lease token crosses IPC (R3):
  `capture:release({ intent })` resolves the holder from the sender binding.
- **Acquire rules.** A fresh acquire requires the foreground primary main frame, and a
  background acquire is refused `not-foreground` before the held check (R5, R6). A holder's
  re-acquire is not foreground-gated.
- **Handoff, ack-or-crash.** On Join the gate flips first, `revokeAudiocapShare()` ends the
  outgoing share, and A is told `capture:leaseRevoked { reason: 'moved' }`. If A does not release
  within `HANDOFF_ACK_TIMEOUT_MS = 5000`, main calls `forcefullyCrashRenderer()` and issues
  `reload()` from that `webContents`' `render-process-gone` event (`crashAndReloadRenderer`),
  not in the same task (T0 row 4). B is granted only after A's ack or A's renderer is gone.
- **Voluntary release.** A release that empties the claims set clears the holder,
  `setTrayOwner(null)`, calls `revokeAudiocapShare()` (a share must not outlive the lease that
  admitted it), and publishes the new state.
- **Generation listener.** A `switch (reason)` with no default branch that ends the holder (an
  unclassified reason is a compile error through `never`):
  - `renderer-gone`, `disposed` **end** the holder at once. `document` ends it only on its
    SECOND advance: #86 advances at a navigation's start and again when it commits, and a
    cancelled navigation (ERR_ABORTED) leaves the old document, with live tracks, after the
    first only. The first advance therefore keeps the lease reserved behind a grantee-less
    handoff on the same 5 s ack-or-crash timer, so a navigation that never commits is crashed
    and reloaded (then `renderer-gone` ends the holder) instead of freeing capture;
  - `credential-start`, `credential-end` **re-key** it in place to the new generation: new
    `ConnectionRef`, new `bindOwner('capture-lease', …)`, claims and `legacy` kept,
    `setTrayOwner(newRef)`, no push, no audiocap call. The same re-key applies to `handoff.from`
    and to the connection's lease-aware mark (RC-14). A credential event leaves the same document
    and its live tracks running, so ending the lease there would grant another connection a
    second live microphone with no ceremony.
  - The listener **never calls audiocap.** #86's own `registerAudiocapIpc` listener already
    stops the owner's share gracefully (`stopAudiocapHost`) on every advance; a kill here would
    race it (RC-4).
- **Arbiter policy.** `desktop/src/main/capturePolicy.ts` replaces #86's default for `media` and
  `display-capture`. Request handler: unbound, PiP, subframe or stale → deny; `isHolder(ref)` →
  allow; legacy gate (`!leaseAware ∧ free ∧ foreground primary` → implicit acquire with
  `claims: {'voice-join'}`, `legacy: true`) → allow; otherwise deny (`NotAllowedError`). Check
  handler: `CAPTURE_CHECK_POLICY = 'bound-primary-main-frame'` (T0 row 1 passed), and
  `webContents === null` now answers false. `setDisplayMediaRequestHandler` stays uninstalled.
- **Handler gates.** `audiocap:start` keeps its `app-global-mutate` class and post-await
  foreground re-check; the holder gate replaces #86's refuse-while-owned rule (RC-3).
  `media:getDesktopSources` requires the holder (refusal `[]`). `permission:changed` is also
  delivered to the holder; `permission:request` is not widened (R14).
- **Tray.** `ipc/trayStatus.ts` keeps one snapshot per connection and displays the owner's (the
  holder's), else the foreground's (R15). `tray:action` routes to `trayActionTarget()`; a stale
  owner routes nothing.
- **Modal mutex.** `modalMutex.ts` allows one main-owned modal at a time. The capture ceremony
  and both self-hosted approval call paths share it, and the loser answers `busy` (R13).
- **Ceremony budget.** `captureCeremonyBudget.ts`: a token bucket of 3, refilled 1 per 20 s,
  answering `busy` with explanatory copy (F8). It is separate from `selfHostedCeremonyBudget.ts`.
- **Renderer.** `services/voice/captureLeaseClient.ts` wraps `globalThis.electron?.capture`.
  With no bridge (an older shell) `acquire` returns `granted`. `joinChannel` awaits
  `acquire('voice-join')` as its first await (F14); `declined` resolves silently (F1). The
  `device-test` claim is refcounted in the client: overlapping mic and camera tests share one
  claim, and only the last stop releases it. `voiceStore` gains `captureLease`,
  `captureMovedNotice` (both preserved by `reset()`) and the transient `captureDeclinedSeq` (F3).
- **IPC contract.** `IPC_CONTRACT_VERSION = 35`, `SPA_MIN_CONTRACT = 19` (`ipcContract.ts`).
  New: `capture:acquire`, `capture:release` (both `connection-bound`), pushes `capture:lease` and
  `capture:leaseRevoked`, bridge `electron.capture.{acquire, release, onLeaseChanged,
  onLeaseRevoked}`. A `connection-bound` admission refusal is mapped explicitly to a
  `CaptureRejectReason` (RC-13).
- **Banner signal.** `BANNER_VISIBILITY_SIGNAL = 'visibilityState'`. It holds only while hidden
  views keep `backgroundThrottling: true` (`shellWindow.ts`; T0 row 7).

## Supersession of ADR-0051

ADR-0052 supersedes, **in substance**, two parts of ADR-0051:

1. **S-1's refusal rule.** "A start while **another** connection owns a live share is refused
   with `protocol-fault`." `audiocap:start` now admits only the lease holder; a handoff ends the
   outgoing share through `revokeAudiocapShare()`. S-1's other bullets stand: `audiocap:start`
   stays `app-global-mutate`, and `audiocap:stop` stays owner-only.
2. **The `tray:setStatus` row of "Accepted classification changes".** The class is unchanged
   (`connection-bound`), but the handler no longer narrows to one accepted snapshot. It stores a
   snapshot per connection and the tray displays the holder's, else the foreground's.

**Open maintainer question:** whether ADR-0051 is also edited in place to mark these as
superseded. This PR leaves ADR-0051 unchanged; both ADRs are provisional and ship together (R16).

## Options rejected

- **Dossier option A, a general socket/HTTP/queue arbiter.** Rejected: under #86 those resources
  are already per-document. Only OS-singular resources need arbitration.
- **Option B, a renderer-themed consent dialog.** Rejected (Q1). `IpcMainInvokeEvent` carries no
  user-activation signal (ADR-0035 non-property #14b), so a renderer cannot prove the user acted.
  A renderer-drawn consent would let a compromised foreground renderer move capture to itself.
  Choosing it would mean rewriting the §4 security section to accept that risk. The cost of the
  native choice is an OS-styled dialog (see Accepted risks).

## Reconciliation

One line each; the spec §0 tables carry the full reasoning.

- **R1** Forced end of a non-acking holder is `forcefullyCrashRenderer()` then `reload()`, never
  a bare reload; the reload runs from `render-process-gone` (T0 row 4).
- **R2** The handoff ends the share with `killAudiocapCapture()` through `revokeAudiocapShare()`,
  never `killAudiocapHost()`, so the app-start probe survives (ADR-0043).
- **R3** No lease token crosses IPC; release resolves the holder from the sender binding.
- **R4** Claims set; the lease frees when it is empty.
- **R5** A fresh acquire needs the foreground primary main frame; a holder re-acquire does not.
- **R6** Lease pushes go to the holder, the foreground primary, and once to a former holder.
- **R7** Legacy gate: implicit acquire for a document with no `capture:*` call in its
  generation, only when free and from the foreground primary main frame.
- **R8** Check handler follows T0 row 1; it passed, so `bound-primary-main-frame`.
- **R9** No resource ledger; read-only `mainResourceCounts()`.
- **R10** Loopbacks keyed per connection as `OwnedLoopback`, with identity-guarded deletes.
- **R11** Withdrawn: #86 tears down SSO slots on every advance; the capture lease re-keys on
  credential reasons instead (RC-14).
- **R12** A device-test-only lease is revoked when its connection leaves the foreground.
- **R13** One main-owned modal across ceremony kinds; the other answers `busy`.
- **R14** `permission:request` is not widened; `permission:changed` also reaches the holder.
- **R15** Per-connection tray snapshots; the tray displays the holder's.
- **R16** Release gate: no tag ships #86 without #87.
- **Q1** Native `dialog.showMessageBox` ceremony.
- **Q2** Revoke a device-test-only lease on background (R12 stands).
- **Q3** Release gate rather than reopening #86's arbiter default.
- **Q4** `HANDOFF_ACK_TIMEOUT_MS = 5000`, then crash-then-reload.
- **F1** `declined` is silent; a polite status says "Staying on your current call."
- **F2** Dialog copy "Join voice on {B}?" with the §3.3 detail and buttons.
- **F3** Three `voiceStore` fields; two preserved by `reset()`.
- **F4** Join controls carry a hidden `aria-describedby` hint and stay enabled; device tests
  show a visible line.
- **F5** Pending state is `aria-busy` + `aria-disabled` with an activation guard, never native
  `disabled`.
- **F6** No dialog timer; closed early only through main's `signal`.
- **F7** No `busy` / `rate-limited` split; reopen only if T0 row 6 shows a non-modal box.
- **F8** Ceremony token bucket, capacity 3, refill 1 per 20 s, answering `busy`.
- **F9** `CaptureMovedBanner` in `App.tsx` after `<UpdateBanner />`, not in the voice area.
- **F10** `superseded` copy is shown only when the document survives.
- **F11** Live-region pattern from #3394; banner text set once the document is visible.
- **F12** `normalizeAccessKeys` and `signal` both set.
- **F13** The crash path loses the banner; declined for v35 (Accepted risks).
- **F14** No join watchdog exists around `acquire`; it is the first await.

## T0 results

Harness: `desktop/spikes/capture-gate/` (results in `results/`). Measured 2026-11-11 on
Electron 45.0.0 (Chromium 156.0.8078.48), macOS 27.2 (build 26B123), Apple Silicon.
`--use-fake-device-for-media-stream` on every run; `--use-fake-ui-for-media-stream` on row 5 only.
Every row ran three times per configuration, each on a fresh temporary profile.

### macOS arm64 (copied verbatim from `results/macos-arm64.md`)

| row | observed | run count | note |
|---|---|---|---|
| 1 (`--check=true`) | The request handler fired **exactly once per `getUserMedia({ audio: true })`**, on all three calls: twice with the earlier tracks still live, once after `stopAll()`. Every call resolved with an audio track after the grant. Before any grant, `enumerateDevices()` returned 7 entries, all labelled and all with a `deviceId`, and `permissions.query('microphone')` returned `granted`. **PASS** | 3 / 3 | A `true` check does not stand in for the request: Chromium still asks the request handler on every call |
| 1 (`--check=false`) | The request handler still fired **exactly once per `getUserMedia`**, and every call resolved after the grant. `enumerateDevices()` returned 3 entries with **no labels and no `deviceId`**, before the first grant and after the third with a track live. `permissions.query('microphone')` returned `denied` | 3 / 3 | The check handler is **not** a gate for `getUserMedia`, and it does not have to answer `true` for a call to reach the request handler. What the check answer controls is `enumerateDevices()` labels and ids and `permissions.query` |
| 2 | `callback(false)` in the request handler. The renderer received **`NotAllowedError`**, message `Permission denied`, for `{ audio: true }` and for `{ video: true }`. The request handler was called once for each, with `mediaTypes` `['audio']` and `['video']` | 3 / 3 | |
| 3 | `getUserMedia` with `chromeMediaSource: 'desktop'` reached the **request** handler as **`display-capture`**: `mediaTypes` `['video']` without an id and with `chromeMediaSourceId: 'screen:0:0'`, and `['audio', 'video']` with loopback audio. **`getDisplayMedia({ video: true })` with no `setDisplayMediaRequestHandler` also reached the request handler as `display-capture`, `['video']`.** The check handler was **never** called for `display-capture`. Every denial reached the renderer as `NotAllowedError` (`Permission denied`) | 3 / 3 with `--check=true`, 3 / 3 with `--check=false` | Deny arm only. The grant arm was not run: a grant could start a real screen capture and raise a macOS Screen Recording prompt on the executor's machine. So what `getDisplayMedia` does **after** a granted `display-capture` with no display-media handler installed is NOT MEASURED |
| 4 (veto installed with user activation) | (a) **`reload()` alone did not end the tracks.** `will-prevent-unload` fired, the document nonce was unchanged, both tracks were `live`, and the renderer pid was alive. (b) **`forcefullyCrashRenderer()` + `reload()`:** `render-process-gone` fired with **`reason: 'killed'`** (exitCode 2), and the old renderer pid no longer existed, so the tracks ended with the process. **But the same-task `reload()` produced no document:** the events were `did-start-loading` → `did-stop-loading` → `render-process-gone`, no `did-finish-load` came within 5 s, `isCrashed()` stayed `true` with OS pid 0, and `executeJavaScript` rejected with "Render frame was disposed before WebFrameMain could be accessed". (c) A second `reload()` issued **after** `render-process-gone` loaded a fresh document with **zero tracks** | 3 / 3 | Track end is shown at process level: the renderer that owned the `MediaStreamTrack`s is dead. Chromium closing its capture device was not observed directly. `forcefullyCrashRenderer()` is asynchronous: straight after the call `isCrashed()` was `false` and the pid unchanged, so a `reload()` in the same task reaches the dying renderer and is lost. This contradicts the Electron docs' "Calling `reload()` immediately after calling this method will force the reload to occur in a new process" for a `WebContentsView` on 45.0.0 |
| 4 (veto installed without user activation) | (a) `reload()` alone **replaced the document** and the tracks were gone: Chromium ignores a `beforeunload` veto from a frame with no sticky user activation. (b) and (c) as in the row above: `killed`, old pid gone, the same-task reload lost, the reload after `render-process-gone` loaded a fresh document with zero tracks | 3 / 3 | A document the user has clicked in (any call UI) has sticky activation, so the activation arm is the realistic one |
| 5 (`--fake-ui`, `--check=true`) | The request handler was **never called**. `getUserMedia` audio and video **both resolved** although the request handler would have denied them. The check handler was called (`media`, 1 call for audio, 3 for video) | 3 / 3 | |
| 5 (`--fake-ui`, `--check=false`) | The request handler was **never called**. Audio and video **both resolved** although the check handler answered `false` and the request handler would have denied them | 3 / 3 | `--use-fake-ui-for-media-stream` bypasses **both** handlers: a test run with it passes with no gate at all. Desktop capture was not exercised under fake UI (a grant could start a real screen capture) |
| 6 | `dialog.showMessageBox(baseWindow, { signal, … })` with the §3.3 option shape attached as a **macOS sheet**: `sheet-begin` fired. `controller.abort()` closed it: `sheet-end` fired and the promise **resolved `{ response: 0 }`** (`cancelId`, i.e. Stay) about 270 ms after the abort (267–269 ms). It did not reject. A `sendInputEvent` `mouseDown` **reached A's document while the sheet was open** (A's counter went 1 → 2), as it did before and after | 3 / 3 | `sendInputEvent` injects straight into the renderer and bypasses the OS window's event routing, so the click result does **not** measure modality. Whether a real pointer click on A is refused while the sheet is open is NOT MEASURED: it needs a person at the machine, or OS-level mouse events posted into the user's session, which an unattended run should not do. The sheet itself is the macOS window-modal contract |
| 7 (`--throttle=true`, the shell's value) | B, hidden from creation, reported **`hidden`**. After `setVisible(false)`, A reported **`hidden`** and its document saw a `visibilitychange` to `hidden`. B, shown with `setVisible(true)`, reported `visible` and saw a `visibilitychange` to `visible`. Control: A reported `visible` before the swap, so the window was not occluded | 3 / 3 | |
| 7 (`--throttle=false`) | Every view reported **`visible`** in every phase, and no `visibilitychange` fired | 3 / 3 | The signal depends on `backgroundThrottling: true` (`shellWindow.ts:181`). #86 T0 also recorded that a locked screen or an occluded window reports `hidden` for the **foreground** view too |

### Windows x64 and Linux x64

**NOT MEASURED** — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11.
Every row of `results/windows-x64.md` and `results/linux-x64.md` reads so, and the macOS results
do not transfer. Open on both platforms: row 6 modality (F7's `busy` split stays closed until it
is measured, with a real pointer, since `sendInputEvent` cannot answer it); access-key reach of
`&Join` under `normalizeAccessKeys`; `signal` abort resolving as `cancelId`; whether row 4's
same-task `reload()` is lost there too; and rows 1, 3, 5 and 7.

### Branch taken and what T0 changed

- **§5.2 branch: row 1 passed.** `CAPTURE_CHECK_POLICY = 'bound-primary-main-frame'`. The
  request handler is the gate for every `getUserMedia`, so the check may answer for any bound
  primary main frame, which keeps device labels and ids working. The legacy gate stays.
  `DeviceSelector` needs no `device-test` acquire before `enumerateDevices`, and no
  SPA-before-shell deploy ordering is required: the remote SPA may deploy in either order.
- **Banner signal: row 7 passed.** `BANNER_VISIBILITY_SIGNAL = 'visibilityState'`, valid only
  while hidden views keep `backgroundThrottling: true`.
- **Row 4 surprise.** `reload()` in the same task as `forcefullyCrashRenderer()` is lost and
  leaves a crashed `webContents` with no document. Main therefore reloads from
  `render-process-gone` (spec §3.4 step 4 amended; `crashAndReloadRenderer`).
- **Row 5 surprise.** `--use-fake-ui-for-media-stream` bypasses both permission handlers, so a
  run with it passes with no gate at all. No e2e test or manual capture check may use it
  (`desktop/tests/README.md` § Electron e2e; spec §7 has the e2e fixture assert its absence).
- **Row 3 surprise.** Display capture, both `chromeMediaSource: 'desktop'` and `getDisplayMedia`,
  reaches the **request** handler only, as `display-capture`; the check handler is never called
  for it. The request-handler gate therefore covers `getDisplayMedia` too. What `getDisplayMedia`
  does after a granted `display-capture` with no display-media handler is not measured.

## Accepted risks

- **Free-lease acquire by a compromised foreground renderer.** A compromised foreground renderer
  may acquire a **free** lease, explicitly or through the legacy gate. That is the same class as
  #86's foreground `app-global-mutate`; it cannot take a held lease without the native ceremony.
- **Unthemed native dialog.** The ceremony is OS-styled, so a dark app may show a light dialog.
  This is the cost of Q1.
- **The crash path loses the banner (F13).** Only legacy SPAs (which cannot render the notice)
  and lease-aware documents that fail to ack in 5 s (hostile or hung) reach it, and a reloaded
  document gets no "moved" notice. The seam is named: `CaptureLeaseState` is an exact-key object,
  so a later `notice` field needs a contract bump.
- **Crash-reporter noise.** A forced end produces a `render-process-gone` with `reason=killed`,
  which is distinguishable from a real crash.
- **Device-test claim refcounted client-side only.** Overlapping mic and camera tests share one
  `device-test` claim in main; the count lives in `captureLeaseClient.ts`. A compromised renderer
  can release the claim early, which only frees its own lease.

- **A hostile holder that sends the ack keeps the tracks it already has (security review).** Main
  cannot tell whether a renderer really stopped capturing, so any well-formed `capture:release`
  from the revoked holder counts as the ack and disarms the 5 s crash. A compromised holder can
  therefore release and keep running tracks it was already granted; the gate stops only new
  requests, and only the audiocap share is killed. The crash enforces against legacy and hung
  holders, not against a hostile one that acks. The same holds for a holder that releases its last
  claim while keeping tracks. Open question 4 asks whether to crash and reload on every `moved`
  handoff instead.

## Release gate

**R16: no release tag ships #86 (ADR-0051) without #87 (ADR-0052).** #86's arbiter default
allows every bound `media` request, so a #86-only shell allows uncontrolled capture across
connections. Desktop has no release checklist document; the gate is recorded here and in the PR
body.

## Open questions

1. **ADR-0051 in place.** Whether ADR-0051 is also edited to mark S-1's refusal rule and the
   `tray:setStatus` row as superseded (see Supersession). Default: ADR-0051 left unchanged.
2. **R11 withdrawal.** Whether it is accepted that #86 tears down a connection's renderer-driven
   loopbacks and its pending MFA / completion on **any** generation advance, credential events
   included, so no renderer-driven loopback flow survives a credential event mid-flow. Default:
   accepted, R11 withdrawn.
3. **Legacy-gate coverage.** Whether unit-only coverage is enough for the implicit legacy acquire.
   `contextBridge` freezes `window.electron`, so no e2e view can omit the `capture` key; a
   test-only preload switch would be its own production attack surface. Default: unit-only, with
   the e2e row `test.fixme`.
4. **Fake ack.** Whether a `moved` handoff always crashes and reloads the old holder, treating the
   ack only as a signal to do it sooner, or whether the gap in Accepted risks is accepted.
   Default: accepted, because an always-crash handoff reloads the old connection's page on every
   honest move.

## Consequences

- One voice session at a time across connections. Joining elsewhere asks first; Join ends the
  other call (people there see the user leave) and nothing rejoins on its own.
- At no instant do two documents hold a live encrypting media context: `MediaEncryption` and the
  E2EE worker are created only after `acquire` resolves `granted`, and B is granted only after
  A's ack or A's renderer is gone.
- ADR-0043 per-process audio is preserved: the handoff and voluntary release kill only the
  capture child, never the probe.
- An older SPA on shell 35 keeps working through the legacy gate; an older shell gives a
  lease-aware SPA `granted` with no bridge (today's behaviour).
- Capture tests and manual checks can no longer use `--use-fake-ui-for-media-stream`.
- #90 edits `ipc/sso.ts` next; #87 changed only keying, supersede and logging there.
- When #88 names connections, every renderer string changes together.

## Verification

Unit (vitest, from `desktop/`):

- `tests/unit/shared/captureLease.test.ts`
- `tests/unit/main/capturePolicy.test.ts`
- `tests/unit/main/captureIpc.test.ts`
- `tests/unit/main/preloadCaptureBridge.test.ts`
- `tests/unit/main/captureCeremony.test.ts`
- `tests/unit/main/modalMutex.test.ts`
- `tests/unit/main/ipc/sso.test.ts`
- `tests/unit/main/ipc/trayStatusIpc.test.ts`
- `tests/unit/main/audiocapIpc.test.ts`
- `tests/unit/services/voiceService.captureLease.test.ts`,
  `tests/unit/services/voiceService.captureLeaseRelease.test.ts`

e2e (real Electron, no fake-UI flag): `tests/e2e/captureArbitration.spec.ts`, run through
`npm run test:e2e:electron`. The legacy-gate row is `test.fixme` (Open question 3).

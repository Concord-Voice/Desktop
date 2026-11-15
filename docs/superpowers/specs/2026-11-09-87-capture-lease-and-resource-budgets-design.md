# Exclusive Capture Lease and Owner-Bound Main Resources (Desktop #87) — Final Spec

**Intended repo path:** `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` (Desktop). The implementing agent commits it; the design worktree was read-only.
**Issue:** Concord-Voice/Desktop#87, child of Self-Hosted#59. Second in the serialized batch after #86. **Scope:** #87 only. Connections UI is #88, the unified DM/call list is #89, and SSO journeys plus the loopback/MFA rewrite are #90.
**Status:** Final (Phase 2 reconciliation, 2026-11-09; panel: architect, system-engineer, frontend-designer with UI and UX inputs). ADR number 0052 is provisional. Re-grep `docs/adr` across every org checkout immediately before merge; #86 holds 0051 provisionally (highest on disk in Desktop is 0043; highest org-wide on 2026-11-09 was 0050).
**Binding maintainer decision (batch-decisions.md, 2026-11-08):** an EXCLUSIVE capture lease. One connection holds microphone, camera and screen capture at a time. Joining voice on another service asks the user to move capture there. There is no simultaneous multi-service publication and no cloned capture. The lease is keyed on #86's `ConnectionRef` and is invalidated when that connection's generation advances.

**Evidence versions:** Electron **45.0.0**. Typings were read from the npm tarball (`scratchpad/electron45pkg/package/electron.d.ts`, `package.json` `"version": "45.0.0"`):
- `dialog.showMessageBox(window: BaseWindow, options)` at `:8253`.
- `MessageBoxOptions` (`:23412-23487`): `signal?: AbortSignal` at `:23439` — *"On macOS, `signal` does not work with message boxes that do not have a parent window"*; the ceremony always passes the `BaseWindow`. `normalizeAccessKeys?: boolean` is in the same interface (`&` removed on macOS, `_` on Linux).
- `MediaAccessPermissionRequest { mediaTypes?, securityOrigin? }` at `:10090`; `PermissionRequest { isMainFrame, requestingUrl }` at `:11507`.
- `setPermissionRequestHandler` / `setPermissionCheckHandler` at `:14236-14253`: *"`display-capture` … whether made through `getDisplayMedia` or through `getUserMedia` with `chromeMediaSource` constraints"* and *"Most web APIs do a permission check and then make a permission request if the check is denied"*.
- `PermissionCheckHandlerHandlerDetails { mediaType, isMainFrame, requestingUrl? }` at `:24230`.
- `WebContents.forcefullyCrashRenderer()` at `:19002`: *"Calling `reload()` immediately after … will force the reload to occur in a new process"*.

Cross-checked against Context7 `/electron/electron` (latest indexed 44.9.3). Zustand ^5.0.16 is not load-bearing: no new store; three fields on `voiceStore`.

Repo facts verified in the worktree on 2026-11-09: `ipcContract.ts:328` `IPC_CONTRACT_VERSION = 33`, `:361` `SPA_MIN_CONTRACT = 19`; `main.ts:1657-1668` allows every permission except `geolocation`; `audiocapHost.ts:18` "AT MOST ONE CHILD", `killAudiocapHost` `:450`, `killAudiocapCapture` `:494`, `stopAudiocapHost` `:591`; `PipWindow.tsx:102-115` installs a `beforeunload` veto; `main.ts:1536` only logs `render-process-gone`; `voiceStore.ts:1196-1207` `reset()` spreads `initialState` with an explicit preserve list (`machineScreenAudioCapable` `:1205`, the #2153 dialog field `:605`); `services/system/resetService.ts:101` `gracefulReset()`; `App.tsx:678-679` renders `{!isPipWindow && <VoiceJoinErrorNotice />}` then `<UpdateBanner />`; `voiceService.joinChannel` `:4075` has no outer timeout in `:4075-4300`; `selfHostedCeremonyBudget.ts` is a 5-per-10-minute windowed budget (`CEREMONY_BUDGET`, `CEREMONY_WINDOW_MS`); `frontend.md:2436` (O1) requires `aria-disabled`, never native `disabled`, on guarded controls; `tests/unit/styles/contrast-pairs.test.ts` exists.

**As built by #86** *(#86 as built, 2026-11-11)*: the facts above predate #86 and the plan's "Reconciliation against #86 as built" (RC-1..RC-15) is authoritative where they differ. `IPC_CONTRACT_VERSION = 34` at `ipcContract.ts:353`, `SPA_MIN_CONTRACT = 19` at `:408`. Permissions go through the per-session `captureArbiter` (`connectionSession.ts`), whose default allows bound `media` requests, while an off-document check (`webContents === null`) gets the static policy (true for `media` / `display-capture`). `media:getDesktopSources` and `audiocap:start` are `app-global-mutate` (foreground only); `audiocap:start` refuses while another connection owns a live share and #86's own generation listener stops the owner's share gracefully on every advance. `trayOwner` / `setTrayOwner` exist (`ipc/trayStatus.ts:75`, `:80`) and `tray:setStatus` is already `connection-bound`, narrowed in the handler. Loopbacks are `OwnedLoopback { handle, owner: OwnerBinding }` in `active: Map<port, OwnedLoopback>` (`ipc/sso.ts:131-136`), refused to other connections and torn down on every advance. `requestSelfHostedApproval` is `main.ts:2625`; `killAudiocapCapture` is `audiocapHost.ts:505`. `credential-start` / `credential-end` advance the generation while the same document keeps running (`tokenManager.ts:864`, `:873`, `:1207` via `shellWindow.ts:220`).

---

## 0. Reconciliation record

Three passes fed this spec: the architect's Mode-2 draft, the system-engineer's technical approach (rows R1–R16) and the frontend-designer's handoff reconciling UI and UX inputs (rows F1–F14). Rows Q1–Q4 are the architect's rulings on the system-engineer's open questions. Each is recorded so that no reviewer re-litigates it.

### 0.1 System-engineer overrides of the Mode-2 draft (adopted)

| # | Topic | Mode-2 position | Final | Why |
|---|---|---|---|---|
| R1 | Forced end of a non-acking holder | `webContents.reload()` at 5 s | **`forcefullyCrashRenderer()` then `reload()`** | A renderer can veto `reload()` through `beforeunload`; the repo already depends on that veto (`PipWindow.tsx:102-115`). Killing the process cannot be vetoed and ends every `MediaStreamTrack`, worker and `MediaEncryption`. Different `Session`s never share a renderer process, so the kill reaches only A's documents (A's PiP may share A's process and dies with it, acceptable). `main.ts:1536` only logs `render-process-gone`, so main calls `reload()` itself. |
| R2 | Audiocap teardown on handoff or generation advance | `killAudiocapHost()` | **`killAudiocapCapture()`, on handoff only**, through `revokeAudiocapShare()` (also clears `shareOwner`) *(#86 as built, 2026-11-11)* | `killAudiocapHost` also reaps the windowless app-start probe, memoizing `child-crash` and leaving per-process screen-share audio dead for the process lifetime (ADR-0043 regression). `killAudiocapCapture` spares the probe. On a generation advance #86's own listener already stops the share gracefully (`stopAudiocapHost`), so the lease calls nothing there. |
| R3 | `LeaseId` crossing IPC | 128-bit `leaseId` returned and passed back | **No lease token crosses IPC.** `release({ intent })` resolves the holder from the sender binding (`requireOwner`). Pushes carry no id. | #86 R4: no bearer secrets in renderers unless the proof is renderer↔renderer. |
| R4 | Release granularity | One `release(leaseId)` clears the lease | **Claims set** `claims: Set<'voice-join' \| 'device-test'>`; the lease frees when empty. | A Settings mic test inside the holder's own call would otherwise free the lease mid-call on test stop. |
| R5 | Fresh acquire from a background document | Allowed when free | **Fresh acquire requires the foreground primary main frame.** A holder's re-acquire does not. | A compromised background renderer must not open the mic while the user looks elsewhere; and a background C taking a lease A freed mid-ceremony would make B's "Join" move capture away from a connection the dialog never named. |
| R6 | Lease-state push | Broadcast to every primary | **Push only to the holder, to the foreground primary, and once to a connection whose own lease just ended.** A background acquire is refused `not-foreground` *before* the held check. | Whether the user is in a call elsewhere is a cross-service signal no background document needs. Telling a connection about its own lease leaks nothing (added in reconciliation so `captureLease` never goes stale at `'mine'`). |
| R7 | Legacy (pre-35) SPA on a 35 shell | Not addressed | **Legacy gate** (§5.2): implicit acquire at the request handler for a document that has made no `capture:*` call in its generation, only when free, no handoff pending and the requester is the foreground primary main frame. T0 row 1 must pass. | The `saas` view loads the remote SPA and the LKG cache can hold an older build; a strict gate would break voice for the installed base in that window. The legacy gate's exposure equals an explicit free acquire's. |
| R8 | Check handler | `isHolder` | **Depends on T0 row 1.** Pass → `boundPrimaryMainFrame` (device labels keep working); fail → `isHolder` and the legacy gate is dropped. | A permissive check may let Chromium skip the request; a strict check strips `enumerateDevices` labels before any join. |
| R9 | `resourceBudget.ts` ledger | A new counting ledger | **No ledger.** Maps keyed by `ConnectionId` hold at most one entry per connection under `MAX_LIVE_CONNECTIONS`; read-only `mainResourceCounts()` for tests. | A second copy of state the owning maps already hold is a drift bug. |
| R10 | Loopback keying | `Map<ConnectionId, LoopbackHandle>` | **`Map<ConnectionId, OwnedLoopback>`** *(#86 as built, 2026-11-11)*, identity-guarded deletes (`active.get(id)?.handle === handle`) kept from #86. | With supersede, the old handle's settle would otherwise delete the new entry. |
| R11 | SSO pending-slot teardown | Every generation advance | **Withdrawn** *(#86 as built, 2026-11-11)*: #86's teardown on every advance (89ed3dc0) stays. **Capture lease:** only `document`, `renderer-gone`, `disposed` end the holder; `credential-start` / `credential-end` re-key it to the new generation (plan RC-14). | Owner bindings are generation-exact, so an SSO slot kept across `credential-start` could never be completed; the sign-in flow binds its owner after its own `credential-start`. For capture the reverse holds: a credential advance leaves the same document and its live tracks running, so clearing the lease would allow a second live mic with no ceremony. |
| R12 | Device-test lease while backgrounded | Not addressed | **Main revokes a device-test-only lease when its connection leaves the foreground** (`capture:leaseRevoked { reason: 'backgrounded' }`). | A forgotten Settings meter in A must not force a ceremony on B's join or silently pre-empt it. |
| R13 | Ceremony exclusivity | Capture single-flight | **One main-owned modal at a time across ceremony kinds** (capture ↔ self-hosted approval): the other returns `busy`. | A hostile foreground renderer could otherwise stack two native modals. |
| R14 | `permission:request` widening for the holder | Widen to foreground ∨ holder | **Not widened**; `permission:changed` is also delivered to the holder. | Every capture-starting flow begins in the foreground document; widening adds red-team surface no flow needs. Closes #86 open item 3 for #87. |
| R15 | Tray while held | Drop non-holder `tray:setStatus` | **Per-connection snapshot map; display `snapshot[trayOwner()]`.** | Dropped snapshots leave the tray stale when the lease frees. |
| R16 | Release order vs a #86-only shell | Not addressed | **Release gate: no release tag ships #86 without #87.** | #86's arbiter default allows all `media`; a #86-only shell allows uncontrolled three-way capture. |

### 0.2 Architect rulings on the system-engineer's open questions

| # | Question | Ruling | Why |
|---|---|---|---|
| Q1 | D1: native dialog, or a themed renderer dialog with the accepted-risk rewrite? | **Native `dialog.showMessageBox` ceremony.** All three panel seats concur. | `IpcMainInvokeEvent` carries no user-activation signal (ADR-0035 non-property #14b, `electron.md:1235`); a renderer cannot prove the user acted, so a renderer-drawn consent would let a compromised foreground renderer move capture to itself. The maintainer may still overrule at the cost stated in §11; the casualty (an unthemed OS dialog) is documented, not hidden. |
| Q2 | Revoke a device-test-only lease on background? | **Yes (R12 stands).** Copy for the stopped test is in §3.8. | A device test is a foreground activity; the alternative is a surprise ceremony or a silent pre-emption. |
| Q3 | Release gate, or reopen #86's arbiter default? | **Release gate (R16).** Do not re-panel #86. | #86's spec already states "#87 replaces the default" and both land in the same serialized batch and milestone. Tightening #86's default to foreground-only would spend a panel round on a policy #87 replaces weeks later. The release-classification checklist for `v1.0.0` carries the gate. |
| Q4 | 5 s timeout and crash-then-reload? | **Confirmed: `HANDOFF_ACK_TIMEOUT_MS = 5000`, then `forcefullyCrashRenderer()` + `reload()`.** | The honest ack is sent synchronously inside the push handler; 5 s is two orders of magnitude of slack. Every second longer is a second the microphone stays open on A against the user's explicit instruction. Legacy and hostile holders never ack, so a longer timeout only delays B. |

### 0.3 Frontend-designer reconciliation (adopted unless marked)

| # | Topic | Draft position | Final | Why |
|---|---|---|---|---|
| F1 | `declined` presentation | Routed through `setJoinError` | **Silent.** `joinChannel` catches `CaptureLeaseError('declined')`, calls `bumpCaptureDeclined()`, resolves quietly; a polite SR status says "Staying on your current call." | The user chose Stay; an error notice reads as a failure. A ceremony only runs when the holder is in a call, so the string is always true. |
| F2 | Dialog copy | "Move voice to {B}?" / "Stay on {A}" / "Move to {B}" | **"Join voice on {B}?"**, detail and buttons per §3.3 | "Join" names the action the user started; "move/switch your call" wrongly suggests the same call continues. The detail keeps "people on {A} will see you leave" as the most important consequence. |
| F3 | Store fields | One field `captureLease` | **Three fields**: `captureLease`, `captureMovedNotice` (both preserved by `reset()`), `captureDeclinedSeq` (transient) | `reset()` (`voiceStore.ts:1196`) spreads `initialState`; a main-pushed `captureLease` and the moved notice would be wiped on every leave unless added to the preserve list, exactly as `machineScreenAudioCapable` is (`:1205`). The handoff's `resetAllStores()` does not exist; the clearing path is `gracefulReset()` (`resetService.ts:101`). |
| F4 | Pre-click hint | Generic held copy on join controls | **Split by surface**: join controls carry a visually hidden `aria-describedby` hint and stay enabled; the device test shows a visible line because it never prompts (R12) and the click would otherwise be dead. | A visible hint on every join row is noise; the dialog explains the move at the moment of decision. |
| F5 | Pending state | Not specified | `aria-busy="true"` + `aria-disabled="true"`, click guarded, focus kept, SR "Joining voice…", existing connecting look if the control has one. Never native `disabled` (`frontend.md:2436` O1: it drops focus to `<body>`). | One pending promise covers "dialog open" and "handing off". |
| F6 | Dialog lifetime | Not specified | **No timer** (WCAG 2.2.1). Closed early only through `signal` when the requester's generation advances or the app quits; an abort resolves as Stay and the post-await re-check returns `superseded`/`declined`. | `signal` confirmed in 45.0.0 for parented boxes. |
| F7 | `busy` split into `busy` + `rate-limited` | One reason | **No split.** | The parented box is modal to its window, so an honest user cannot click Join while a prompt is open; on the honest path `busy` means the rate limit. Reopen only if T0 row 6 shows non-modal behaviour on a platform. |
| F8 | Anti-nag cool-down | Token bucket | **Token bucket stands** (capacity 3, refill 1 per 20 s) answering `busy` with explanatory copy; no silent `declined`. | A silent `declined` without a dialog would tell an honest user they stayed when nobody asked. |
| F9 | Banner location and tokens | "A banner" | **`CaptureMovedBanner` in `App.tsx` directly after `<UpdateBanner />` (`:679`), `{!isPipWindow && …}`**; `--bg-secondary` surface, `--text-primary` text, no new tokens | D3 tears down A's voice UI, so a banner in the voice area would unmount with it. `--text-secondary` contrast is unmeasured in every block. |
| F10 | `superseded` | Error copy | **Shown only when the document survives** (credential-reason advance); a reloaded document never receives the reply. | WCAG 3.3.1: an unexplained silent failure is worse than a named one. |
| F11 | Live-region pattern | `aria-live="polite"` banner | **#3394 pattern**: mount the region when there is something to say, set text one `requestAnimationFrame` later, module-level last-announced guard; banner text set only once the document is visible (§3.8 E4 fallback). | A is in the background when revoked; announcing into a hidden document is lost. |
| F12 | `normalizeAccessKeys` and `signal` | Not specified | **Both set.** `&Stay on {A}` / `&Join on {B}`; `signal` aborted on requester generation advance and on quit. | Keyboard reach on Windows/Linux; a renderer cannot type into a native dialog, so access keys add no surface. |
| F13 | Crash path loses the banner (E5) | — | **Declined for v35.** Recorded as a known gap in the ADR; seam named (`CaptureLeaseState` is an exact-key object, so a later `notice` field needs a contract bump). | The only documents that reach the crash path are legacy SPAs (which cannot render the notice at all) and lease-aware documents that failed to ack in 5 s (hostile or hung). The user has already read "Joining on {B} ends that call" in the dialog they answered. A main-side per-connection memory plus a once-only push is a contract-semantics change not worth paying for that residue. |
| F14 | Join watchdog around `acquire` (E8) | — | **Verified: none exists** in `joinChannel:4075-4300`. Rule stands: `acquire` is the first await, before any timed step. | — |

Mode-2 decisions that stand: **D1** native ceremony (Q1), **D2** one lease for mic + camera + screen, **D3** the previous holder leaves voice, **D5** no cross-service identity in any renderer, **D6** budgets cover main-owned resources only, **D7** loopback supersede, **D8** the tray follows the holder, and **Option C** (explicit IPC + permission-gate backstop + native ceremony). Dossier option A (a general socket/HTTP/queue arbiter) stays rejected: those resources are per-document under #86.

---

## 1. Problem statement

After #86, each connection is its own document on its own Chromium `Session`, which isolates network, storage, custody and IPC authority. #86 leaves shared the things the OS has only one of: the physical microphone, camera and screen; the single audio-capture child (`audiocapHost.ts:18`); the loopback OAuth listeners (`ipc/sso.ts`, keyed by port); and the tray.

Before #86, the handlers answered `callback(true)` for every `media` and `display-capture` request (`main.ts:1657-1668`), `media:getDesktopSources` returned live screen thumbnails to any trusted sender, and `audiocap:start` admitted any trusted primary. *(#86 as built, 2026-11-11)*: #86 fences part of this — `getDesktopSources` and `audiocap:start` are foreground-only and `audiocap:start` refuses while another connection owns a live share — but its arbiter default still allows every bound `media` request, so the problem below stands. CVNet, self-hosted A and self-hosted B can each call `getUserMedia` and publish the same microphone to three servers. A compromised renderer in B can open the mic while the user believes only A's call is live.

#87 makes capture exclusive and owner-bound, binds main-owned listeners and children to their `ConnectionRef`, and releases what a connection owns when its generation advances. It does this without rewriting `voiceService.ts` (12,273 lines), without a new store, and without pre-empting #90.

## 2. Constraints

| Constraint | Source |
|---|---|
| `contextIsolation`, `sandbox`, no `nodeIntegration`, no `@electron/remote`; preload imports only `electron`; sender-frame validation on every privileged handler through `registerIpc(channel, class, handler)` | `electron.md:20-34`; #86 §3.7 |
| `IPC_CONTRACT_VERSION` 34 → **35** (34 at `ipcContract.ts:353`, *(#86 as built, 2026-11-11)*); `SPA_MIN_CONTRACT` stays **19** (`:408`); server-config `spaIpcContract` not raised | `electron.md:321-346` |
| Owner primitives only: `ConnectionRef`, `bindOwner`, `isOwnerCurrent`, `requireOwner`, `onGenerationAdvanced(id, from, to, reason)` (fired synchronously after revocation) | #86 §3.1, §3.8 |
| Permission policy enters through #86's `captureArbiter.decide(ref \| null, permission, details)`; unbound → deny | #86 §3.3(2) |
| ADR-0043 per-process screen-share audio untouched; audiocap kill semantics (`killAudiocapHost` quit-safe and probe-reaping; `killAudiocapCapture` spares the probe; `stopAudiocapHost` graceful) | `audiocapHost.ts:450-600`; `native-audio.md` |
| Structural E2EE: `MediaEncryption` and the E2EE worker live per voice session per document and are destroyed by `teardownSharedE2EEState()` (`voiceService.ts:4983`); no runtime branch on encryption | `e2ee.md:84-90, :589+` |
| SSO `state`, PKCE, redirect shape and the MFA proof path are #90 + Self-Hosted#117; #87 changes ownership and lifecycle only | scouts 87/90 |
| Trust-granting consent is main-owned: `IpcMainInvokeEvent` carries no user-activation signal | `electron.md:1235`, ADR-0035 |
| Guarded controls use `aria-disabled` + an activation guard, never native `disabled`; option/status hints via `aria-describedby`, not `title` | `frontend.md:2436` (O1) |
| Every `var(--token)` resolves in 15 schemes × dark/light + `data-high-contrast`; new selectors set `color` and `background` together so `contrast-pairs.test.ts` sees the pair; visual verification before the PR | `frontend.md:2111-2124`; org rule |
| No new dependency; `package-lock.json` untouched; no new design token | task |
| Self-Hosted#112 is soft: the media capability is an optional input with no producer in #87 | batch decisions |
| Test conventions: `desktop/tests/README.md` + `.claude/rules/domains/{electron,frontend,e2ee,native-audio}.md` (the AC's `.codex/rules/tests.md` does not exist) | scout 87 |
| Desktop has no `@e2ee-reviewer`; §4 stands alone for `@security-reviewer` + `@red-team` | dispatch table |
| Frontend scope bounded to: consent ceremony copy, refusal copy, held hint, moved banner, device-test rows. No Connections UI (#88), no unified DM list (#89). | task |

## 3. Design

### 3.1 Shared types: `desktop/src/shared/captureLease.ts`

```ts
type CaptureIntent = 'voice-join' | 'device-test';
type CaptureAcquireResult =
  | { status: 'granted' }
  | { status: 'held' }        // foreground requester, intent device-test, another connection holds; no ceremony
  | { status: 'declined' }    // ceremony shown; user stayed, the dialog threw, or the signal aborted
  | { status: 'rejected'; reason: 'untrusted-sender' | 'not-foreground' | 'busy' | 'superseded' | 'unavailable' };
interface CaptureLeaseState   { held: boolean; mine: boolean }               // holder, foreground, and own-lease-ended
interface CaptureLeaseRevoked { reason: 'moved' | 'backgrounded' }
```

Exact-key guards (`isCaptureIntent`, `isCaptureAcquireResult`, `isCaptureLeaseState`, `isCaptureLeaseRevoked`) follow the `trayStatus.ts` / `audiocapProtocol.ts` style. Preload re-validates every push and drops malformed ones.

### 3.2 Lease state machine: `desktop/src/main/captureLease.ts`

In-memory only. Nothing is persisted.

```ts
holder:  { ref: ConnectionRef; binding: OwnerBinding; claims: Set<CaptureIntent>; legacy: boolean } | null
handoff: { from: ConnectionRef; to: ConnectionRef; settle: (r: CaptureAcquireResult) => void; timer: Timeout } | null
leaseAware: Map<ConnectionId, Generation>  // set by any capture:* call; carried forward on credential reasons, deleted on document-replacing ones (#86 as built, 2026-11-11; plan Task 2)
```

**Predicates (synchronous):** `free() = holder === null && handoff === null`; `isHolder(ref) = holder !== null && same connectionId && same generation && isOwnerCurrent(holder.binding)`. `primaryMainFrame(event | webContents, details?)` holds when the binding role is `'primary'` (a PiP is never a capture principal), the frame is the main frame, and the binding is current.

**`acquire(event, { intent })`** has a synchronous prologue and no `await` before step 6:
1. Validate the sender: `requireConnectionSender` → `ref`, plus `primaryMainFrame`. Failure → `rejected: untrusted-sender`. Mark `leaseAware`.
2. `isHolder(ref)` → `claims.add(intent)` → `granted`. No foreground check (camera toggle, device change, outage resume).
3. Requester is not the foreground primary → `rejected: not-foreground`, *before* any held check (R6).
4. `serviceMediaCapability(ref.connectionId) === false` → `rejected: unavailable` (§3.7).
5. `free()` → `holder = { ref, binding: bindOwner('capture', ref), claims: {intent}, legacy: false }` → push state → `granted`.
6. Held by another connection or a handoff is pending:
   - `intent === 'device-test'` → `held`.
   - Any main ceremony in flight (R13), `handoff !== null`, or the ceremony bucket is exhausted → `rejected: busy`.
   - Otherwise snapshot `named = holder.ref` and run the ceremony (§3.3) with an `AbortController` whose `abort()` is wired to the requester's generation advance and to quit. The `await` happens here.
   - After the await, re-check: requester not `isOwnerCurrent` → `superseded`. Holder changed from `named` → `busy` (no unconsented move). Became `free()` → grant as in step 5.
   - Stay/abort/throw → `declined`. Join → handoff (§3.4).

**`release(event, { intent })` → `boolean`.** `requireOwner(event, holder.binding)` must succeed, otherwise `false`. Delete the claim. If the set is empty: clear the holder, push `{ held: false, mine: false }` to the former holder and current state to the foreground, settle any handoff waiting on this holder. Synchronous, never throws.

**`onGenerationAdvanced((id, from, to, reason) => …)`** runs inside #86's synchronous `advanceGeneration` block, after revocation:
- **Holder's connection, `document` / `renderer-gone` / `disposed`:** clear the holder, `setTrayOwner(null)`, settle any handoff whose `from` is this connection by granting `to`, push state to the foreground. No audiocap call (#86's listener stops the share gracefully) and no tray-snapshot drop (the tray module's own listener does it) *(#86 as built, 2026-11-11)*.
- **Holder's connection, `credential-start` / `credential-end`:** re-key the holder (and `handoff.from`) to the new generation with a fresh `bindOwner('capture-lease', …)` and `setTrayOwner(newRef)`; claims kept; no push. The document and its tracks are unchanged, so the lease stays exclusive *(#86 as built, 2026-11-11)*.
- **Handoff `to` connection:** abort its ceremony signal if still open; settle `superseded`. The lease ends free.

**`onForegroundChanged(prev, next)`** is a small additive export of #86's `connectionRegistry.ts`, fired from `setForeground` and from `disposeConnection`'s direct foreground clear (`next = null`) *(#86 as built, 2026-11-11)*:
- If `prev` holds a lease whose claims are exactly `{device-test}`, run the handoff with `reason: 'backgrounded'` (R12).
- Push current state to `next`. Nobody else receives anything.

**Lease-state push targets (R6):** the holder (`{ held: true, mine: true }`); the foreground primary when it is not the holder (`{ held: holder !== null, mine: false }`); a connection whose own lease just ended (`{ held: false, mine: false }`, once). Background non-holders receive nothing.

### 3.3 Ceremony: `desktop/src/main/captureCeremony.ts`

Same dependency-injection shape as `requestSelfHostedApproval` (`main.ts:2625`, *(#86 as built, 2026-11-11)*), with an injected `showMessageBox` for tests. Default calls `dialog.showMessageBox(baseWindow, options)`; the `BaseWindow` signature is confirmed in 45.0.0, so no `BrowserWindow` cast.

```ts
{ type: 'question', noLink: true, normalizeAccessKeys: true, signal,
  title: 'Concord Voice',
  message: `Join voice on ${B}?`,
  detail: `You're in a call on ${A}. Joining on ${B} ends that call, and people on ${A} will see you leave. ` +
          `Concord Voice can use your microphone, camera and screen sharing on one connection at a time.`,
  buttons: [`&Stay on ${Ab}`, `&Join on ${Bb}`], defaultId: 0, cancelId: 0 }
```

- **Labels come only from main.** `saas` → "Concord Voice"; `selfhost-*` → the canonical ASCII (punycode) `URL.host` of `ServiceRecord.origin`, including a non-default port. Never renderer-supplied (the tray's no-free-text rule), never IDN-rendered (no homograph labels). `Ab`/`Bb` are the button variants, middle-truncated to 28 characters; `detail` keeps the full host. If both labels are equal, `A` becomes "your other connection".
- **Keys:** Return and Escape both mean Stay (`defaultId: 0`, `cancelId: 0`). Windows/Linux reach Join through the access key; macOS reaches it via Full Keyboard Access or VoiceOver (OS contract; captured in the macOS visual check).
- **Ration:** a separate `captureCeremonyBudget` module with the API shape of `selfHostedCeremonyBudget.ts` (`consumeCaptureCeremonyToken(now)`, `_resetForTesting`) but token-bucket semantics: capacity 3, refill one token per 20 s. Plus the cross-kind modal mutex (R13).
- **Lifetime:** no timer (WCAG 2.2.1). `signal` aborts only on the requester's generation advance or `isQuitting` (#1383); an abort resolves as Stay. The dialog throwing → `declined`, lease unchanged. No `await` is added to the quit path.
- **Modality:** the parented box blocks window input (including A's view) while open; mute/leave on A remain reachable from the tray, which routes to `trayOwner()` = A. No i18n path exists in main; strings are English like the existing approval ceremony.

### 3.4 Handoff: ack-or-crash

Runs synchronously up to the wait:
1. Set `handoff = { from: holder.ref, to: B.ref, … }`, then `holder = null`, so `isHolder(A)` is false at once: the gate, `getDesktopSources` and `audiocap:start` refuse A, and `free()` is false so the legacy gate cannot fire. Call `revokeAudiocapShare()` → `killAudiocapCapture()` (R2; *(#86 as built, 2026-11-11)*).
2. `sendToConnection(A.ref, 'capture:leaseRevoked', { reason })`.
3. Wait for one of: A's `capture:release` (any release from A while `handoff.from === A` counts as the ack; the honest renderer sends it synchronously after `emergencyCleanup()`); A's generation advancing for a document-replacing reason (`document`, `renderer-gone`, `disposed`; *(#86 as built, 2026-11-11)*); `HANDOFF_ACK_TIMEOUT_MS` (5000) → step 4.
4. **Timeout:** `A.webContents.forcefullyCrashRenderer()`, then `A.webContents.reload()` from A's `render-process-gone` (R1). *(T0 row 4, 2026-11-11: a `reload()` in the same task as the crash is lost and the view stays crashed; the reload must follow `render-process-gone`.)* `render-process-gone` advances A's generation (`renderer-gone`, #86 R6), and that listener settles the handoff. A credential advance on A does not settle it (the document is still running); the ack and the timer still apply *(#86 as built, 2026-11-11)*.
5. Grant B: `isOwnerCurrent(B)` else `superseded`; `holder = { ref: B, claims: {'voice-join'}, legacy: false }` → `granted`.

No second document's `getUserMedia` is granted while the first document's tracks may still be live. Chromium gates only *new* requests; step 4 is what makes "no cloned capture" structural instead of cooperative.

### 3.5 Arbiter policy: replaces #86's default in `connectionSession.ts`

**Request handler, `media` and `display-capture`:** unbound, PiP, subframe (`details.isMainFrame === false`) or stale → **deny**; `isHolder(ref)` → allow; legacy gate (§5.2): `!leaseAware(binding) ∧ free() ∧ foreground primary` → implicit acquire (`claims: {'voice-join'}`, `legacy: true`) → allow; otherwise **deny** (`getUserMedia` rejects `NotAllowedError`).

**Check handler, `media` and `display-capture`:** `boundPrimaryMainFrame` if T0 row 1 passes, `isHolder(ref)` if it fails (R8). `webContents === null` (off-document: service worker, notifications) → false. *(#86 as built, 2026-11-11)*: #86 answers this branch with the static policy, which is **true** for both, without the arbiter; #87 changes it to false in `connectionSession.ts` and rewrites #86's pin.

**Other permissions:** #86's default unchanged (deny `geolocation`, allow the rest; unbound → deny). `setDevicePermissionHandler` unchanged.

**`setDisplayMediaRequestHandler` stays uninstalled.** Packaged screen share uses `getDesktopSources` + `chromeMediaSource`, which 45.0.0 routes through `display-capture`. The dev/web `getDisplayMedia` fallback (`voiceService.ts:5718`) fails closed without a handler. A test pins that it stays absent.

### 3.6 Handler gating

- **`media:getDesktopSources`** (`main.ts:2106-2129`) requires `isHolder(ref)` after sender validation, otherwise returns `[]` without calling `desktopCapturer` (#86's refusal value, `:2128`) *(#86 as built, 2026-11-11)*. T7 verifies `ScreenSharePicker.tsx:301` and `voiceService.ts:5748` tolerate it and show refusal copy.
- **`audiocap:start`** additionally requires `isHolder(ref)` (before the await and again after it), otherwise `{ ok: false, reason: 'protocol-fault' }`, no fork. This **replaces** #86's refuse-while-another-connection-owns-a-live-share rule; the consent handoff ends the old share through `revokeAudiocapShare()`. The class stays foreground-only. `stop`, `port`, `interrupted` stay owner-only (#86) *(#86 as built, 2026-11-11)*.
- **Tray:** `trayOwner() = holder?.ref ?? foreground`. #86 provides `trayOwner` / `setTrayOwner` and the `connection-bound` class but drops non-owner snapshots; R15 replaces that with storage: `tray:setStatus` stores a snapshot per connection and the tray renders the displayed connection's (a stale owner fails closed to a neutral tray). `tray:action` (`set-muted`, `leave-voice`, `stop-share`) routes to that connection (`main.ts:1935-1939`) *(#86 as built, 2026-11-11)*.
- **`permission:request` / `openSettings`** stay foreground-only (R14). `permission:changed` goes to the requester and to the holder.
- **Loopback** (`ipc/sso.ts`; the only change in the #90 region) *(#86 as built, 2026-11-11)*: `active: Map<ConnectionId, OwnedLoopback>` (#86's `OwnedLoopback { handle, owner: OwnerBinding }`); `startLoopback` from a connection that already has a handle closes the old one (supersede, D7; its promise rejects `oauth_cancelled`); `awaitCallback(port)` / `cancelLoopback(port)` keep their IPC shape and #86's cross-connection refusal, and now also refuse the sender's own superseded port; deletes stay identity-guarded (R10); the bare `.catch(() => {})` at `:855` becomes `logLoopbackSettle` (`console.debug` for `oauth_timeout` / `oauth_cancelled`, one fixed-text `console.warn` otherwise — never URL, code, state or message). No filtered listener: #86's any-advance teardown stays (R11 withdrawn). `state`, `code`, PKCE, redirect URI and the MFA proof path are untouched. The **#90 seam** is `OwnedLoopback.owner` plus `mainResourceCounts()`.

### 3.7 Self-Hosted#112 input: optional

`serviceMediaCapability(id: ConnectionId): boolean | undefined` reads `ServiceRecord.capabilities?.media`. #87 adds the optional field and **no producer** (the probe/handshake parser is SH#112 / #88 scope). `undefined` has no effect; only an explicit `false` refuses (`rejected: unavailable`), before any ceremony.

### 3.8 Renderer: no new store, no `voiceService` rewrite

All paths under `desktop/src/renderer/`.

**`services/voice/captureLeaseClient.ts`** (a service, not a store) wraps `globalThis.electron?.capture`. Bridge absent → `acquire` returns `granted`, `release` is a no-op (old shell, today's behaviour). `onLeaseChanged` maps `{ held, mine }` → `captureLease` (`'mine'` | `'other'` | `'none'`). `onLeaseRevoked`:
- `moved`: **first** `setCaptureMovedNotice(true)`, then synchronously: `advanceVoiceActionGeneration()` (supersedes queued rejoins); clear `pendingVoiceRejoin`; `voiceService.emergencyCleanup()` (stops every track, terminates the E2EE worker, `mediaEncryption.destroy()`, disconnects the media socket); emit `capture-revoked` so `useMicTest`, `useCameraTest` and the webcam capability probe (`enumerateWebcamCapabilities`; file located by the implementer) stop their streams; `release()` each claim; `setCaptureLease('none')`.
- `backgrounded`: emit `capture-revoked` with the reason; the device test stops and shows its row; `release('device-test')`; `setCaptureLease('none')`.

**`voiceService.joinChannel`** (`:4075`): `await captureLeaseClient.acquire('voice-join')` is the **first await**, placed after `this.joinInFlight = true` (`:4100`) inside the existing try so the existing finally resets the flag, and before `authorizeVoiceJoin`, E2EE init, any `getUserMedia` and any timed step (F14). Results: `granted` → continue and `setCaptureMovedNotice(false)`; `declined` → `bumpCaptureDeclined()` and resolve quietly (F1); every other non-grant → `throw new CaptureLeaseError(reason)` into the existing `setJoinError` path with the copy below. The join control's pending state is visible from the click until `acquire` settles, through the control's existing connecting treatment or a local pending flag (implementer verifies which controls have one).

**Release points for claim `voice-join`** (decided here; one test per site):

| Site | Rule |
|---|---|
| `leaveChannel` without `internalRebuild` (`:4481`), after `cleanup()` | release; an internal rebuild keeps the claim |
| `emergencyCleanup()` (`:4530`) | **releases by default** at the end of cleanup. Every call site below inherits that unless marked keep |
| `useConnectionRecovery.ts:127` (outage with a rejoin ticket) | **keep**: call `emergencyCleanup({ keepCaptureLease: true })`. The holder re-acquire path (§3.2 step 2) has no foreground check, so a background call survives an outage. The ticket-retraction path that abandons the rejoin releases; the `.catch` at `:130` (module never loaded, no teardown) has nothing to release |
| `resumeAfterReconnect` no-context (`:4744`); network-change resume failed while still owner (`:4831`); `io server disconnect` (`:10056`); `reconnect_failed` without a reconnecting call (`:10086`); placement recovery failed (`:10099`); encrypt re-base failed closed (`:10933`) | release (the call is over; no rejoin follows) |
| auth session replaced/cleared (`:12257`) | release. *(#86 as built, 2026-11-11)*: main re-keys the lease on credential reasons instead of clearing it, so this release is the one that frees it |
| `beforeunload` (`:12270`) | nothing to send; the document's generation advance releases it in main |

**Device tests:** `hooks/device/useMicTest.ts`, `hooks/device/useCameraTest.ts` and the webcam capability probe call `acquire('device-test')` before `getUserMedia`; `held` shows the visible row; stopping releases. Each hook exposes `stoppedReason: 'held' | 'backgrounded' | null` as local state, cleared on the next Start or when the pane closes.

**`stores/voice/voiceStore.ts`** (F3): new fields and actions, no new store.
- `captureLease: 'none' | 'mine' | 'other'` (initial `'none'`). **Preserved by `reset()`** (`:1196-1207` preserve list). Cleared by `gracefulReset()`.
- `captureMovedNotice: boolean`. **Preserved by `reset()`.** Cleared by `gracefulReset()`, Dismiss, and a `granted` join.
- `captureDeclinedSeq: number`. Transient; `reset()` may wipe it.
- Actions: `setCaptureLease`, `setCaptureMovedNotice`, `bumpCaptureDeclined`.

**Components** (existing tokens only: `--bg-secondary`, `--bg-tertiary`, `--bg-hover`, `--border-color`, `--text-primary`, `--state-focused`; measurements: `calc(13px * var(--font-scale, 1))`, `line-height 1.4`, `overflow-wrap: anywhere`, padding `calc(8px * var(--sp,1)) calc(12px * var(--sp,1))`, 8px gap, Dismiss ≥ 24×24 CSS px, wraps to its own right-aligned line below ~480px):

| Item | Change |
|---|---|
| Join controls (channel-list voice row, DM call button; implementer enumerates every one) | Selective subscriptions to `captureLease` and the pending state. When `'other'`: `aria-describedby` → a visually hidden hint node; never `title`. Pending: `aria-busy` + `aria-disabled`, guarded click, focus kept. Never native `disabled`. |
| `components/Settings/AudioConfigSection.tsx` + device-test hooks | Visible held line under Test when `captureLease === 'other'`, before any click; Test stays enabled; the row is `role="status"` on `--bg-tertiary` with a 1px `--border-color`, 6px radius; shows `held` / `backgrounded` copy from `stoppedReason`. |
| **New** `components/Voice/CaptureMovedBanner.tsx` + `.css` | Mounted in `App.tsx` directly after `<UpdateBanner />` (`:679`) as `{!isPipWindow && <CaptureMovedBanner />}` (same pattern as `:678`). Reads `captureMovedNotice`. Wrapper `role="status"` polite; `Info` glyph in `currentColor`; native `<button>` Dismiss copied from `.voice-join-error-notice__dismiss`. 1px `--border-color` `border-bottom`, no radius. Enter 150 ms ease-out opacity + `translateY(-4px)` keyframe `capture-moved-banner-enter`; the `@media (prefers-reduced-motion: reduce)` block (opacity only) is last in the file; no exit animation. On Dismiss, focus moves to the first tabbable element after the banner in DOM order, captured before unmount; if none, `.app` with `tabindex="-1"`; never `<body>`. Banner text is set only once the document is visible: `document.visibilityState === 'visible'` if T0 row 7 confirms hidden views report `hidden`; otherwise the fallback signal is the first `capture:lease` push received after the `moved` revocation, which by R6 a non-holder receives only as the foreground primary. |
| **New** `components/Voice/CaptureLeaseAnnouncer.tsx` | Mounted in App. Visually hidden polite region that mounts when `captureDeclinedSeq` or the pending state changes; text set one rAF later; module-level `lastAnnouncedSeq` guard. Not adjacent to the #2153 `MediaPolicyNotice` region (`VoiceControls.tsx:668`). |
| `components/Voice/VoiceJoinErrorNotice.tsx` | No change; only new message strings. |

**Renderer copy** (D5: never names a service; always "call", "connection", "microphone"):

| Key | String |
|---|---|
| Hint (`aria-describedby` on join controls; visible in the device test) | "Your microphone is in a call on another connection. Joining here will ask before ending that call." |
| Device test, `held` | "Your microphone is in a call on another connection. Leave that call to test it here." |
| Device test, `backgrounded` | "Your test stopped when you switched to another connection. Start it again to keep testing." |
| Pending (SR) | "Joining voice…" |
| Declined (SR) | "Staying on your current call." |
| Banner | "Your call ended because your microphone moved to another connection." Button: "Dismiss" |
| `busy` | "You've asked to switch a few times quickly. Wait a moment, then try again." |
| `not-foreground` | "Voice can start only on the connection you're viewing. Join again from here." |
| `unavailable` | "This connection doesn't offer voice." |
| `superseded` (only if the document survives) | "Your connection restarted before voice could start. Join again." |
| `untrusted-sender`, IPC throws, unknown | "Couldn't start voice. Restart Concord Voice and try again." |

**Accessibility (merged):** hints are text, not tooltips (1.3.1); every renderer control is native (2.1.1); Dismiss precedes the main region in DOM order and post-Dismiss/post-Stay focus is defined (2.4.3); no timer (2.2.1); every reachable failure is named (3.3.1); banner wraps at 200% zoom with no fixed heights (1.4.4/1.4.10/1.4.12); forced-colours mode keeps real borders and `currentColor` glyphs. The `--state-focused` ring (`outline: 2px solid; outline-offset: 2px`) against `--bg-secondary` and `--bg-tertiary` is **unmeasured** in the 30 combinations and the `data-high-contrast` block: both pairs are added to `contrast-pairs.test.ts`, and a per-scheme ring override is added if any fails. Reserved and not used here: `AlertTriangle` + `--text-warning-strong`, `--danger` as text, `--text-secondary` / `--text-muted`.

**Terminology:** "connection" is used now; when #88 names these things, every string changes together (recorded in `docs/self-hosted-client.md`).

### 3.9 IPC contract v35

| Channel | Direction | Shape | Admission class | Failure |
|---|---|---|---|---|
| `capture:acquire` | invoke | `{ intent: CaptureIntent }` → `CaptureAcquireResult` | connection-bound primary main frame; fresh/ceremony branches foreground-only | `rejected` reasons; malformed → `rejected: untrusted-sender`; admission refusals mapped explicitly onto `CaptureRejectReason` (`not-foreground` kept, every other `SenderRefusal` → `untrusted-sender`) *(#86 as built, 2026-11-11)* |
| `capture:release` | invoke | `{ intent: CaptureIntent }` → `boolean` | connection-bound, `requireOwner` on the holder binding | `false` |
| `capture:lease` | push | `CaptureLeaseState` | holder, foreground primary, own-lease-ended (once) | preload drops malformed |
| `capture:leaseRevoked` | push | `CaptureLeaseRevoked` | holder only, `sendToConnection` | no-op if ref stale |

**Changed semantics, no shape change:** `media:getDesktopSources`, `audiocap:start`, `tray:setStatus`, `tray:action` routing, `permission:changed` delivery, `sso:startLoopback` (supersede only; the cross-connection port refusal is already #86's, *(#86 as built, 2026-11-11)*).

**Bridge:** `electron.capture.{acquire, release, onLeaseChanged, onLeaseRevoked}`. Preload still imports only `electron`. The registry classification table gains 2 rows; the snapshot test fails on an unclassified channel.

### 3.10 Concurrency rules

- All lease mutations are synchronous in main. The only awaits are the ceremony (§3.2 step 6) and the handoff wait (§3.4 step 3). After each, re-check `isOwnerCurrent` for the requester and holder identity before any effect.
- `onGenerationAdvanced` and `onForegroundChanged` listeners take no `await`.
- Renderer→main `invoke` messages from one document arrive in order, and the acquire/release fast paths are synchronous, so leave→rejoin cannot reorder a release behind a later acquire. Regression-tested.
- Quit: no new await on the quit path. A pending ceremony is aborted via `signal` and resolves `declined`; a pending handoff timer is cleared in both quit hooks (`before-quit-for-update`, `before-quit`; *(#86 as built, 2026-11-11)*).

## 4. Security section (stands alone for `@security-reviewer` + `@red-team`)

**Held:** every §2 hard constraint; no TLS, custody, approvals-ledger or TURN change; no diff in `mediaEncryption.ts` or the E2EE worker; no secret or identifier in any new push; nothing persisted; no cross-service identity or activity signal reaches a background renderer; the native dialog cannot be typed into or aborted by a renderer (`signal` is wired only to main's generation and quit events).

**Media-key ownership follows the lease:** `MediaEncryption` and the E2EE worker are created only inside `joinChannel` *after* `acquire` resolves `granted`; destroyed by `teardownSharedE2EEState()` on revocation (inside `emergencyCleanup`) or by process death on the crash path. B's grant is issued only after A's ack or A's renderer is gone, so at no instant do two documents hold a live encrypting media context. Frame keys derive from each document's own `e2eeService` channel keys and never cross a `Session`; the PiP `get-frame-key` proxy is per storage partition (#86 R8).

| Threat (compromised renderer unless stated) | Reachable? | Enforcement |
|---|---|---|
| B opens mic or camera while A holds | No | request handler denies `media`; `NotAllowedError` |
| B screen-captures or reads live thumbnails while A holds | No | `display-capture` denied; `getDesktopSources` → `[]`; `audiocap:start` refused |
| Background B opens capture while the lease is free | No (R5) | fresh acquire and the legacy gate require the foreground primary main frame |
| B moves A's lease without consent | No | only `voice-join` from the foreground reaches the main-drawn ceremony; default/Escape = Stay; post-await holder re-check; labels main-sourced |
| B spams or stacks ceremonies | Bounded | single-flight, token bucket, cross-kind modal mutex → `busy` |
| A ignores revocation, or vetoes unload | No | gate flips first; audiocap killed (probe spared); `forcefullyCrashRenderer` cannot be vetoed (R1) |
| A sends a fake ack (`capture:release`) and keeps its tracks | **Yes, accepted** | the ack disarms the crash; tracks already granted keep running; only new requests and the audiocap share are stopped. ADR-0052 open question 4 |
| PiP or subframe acquires | No | role `primary` ∧ `isMainFrame` required |
| Stale generation acquires or releases | No | `requireOwner` / `isOwnerCurrent` after every await |
| Background B learns the user is in a call elsewhere | No (R6) | state pushed only to holder, foreground, own-lease-ended; `not-foreground` precedes the held check |
| B receives A's media or frame keys | No | separate documents/`Session`s; key context lives only in the holder's document |
| Hostile server payload makes the honest SPA capture | No | the SPA acquires only on user join or test |
| Loopback callback consumed by another connection | No | #86's owner-bound handle refusal + per-connection supersede + identity-guarded cleanup |
| Foreground compromised renderer acquires a **free** lease (explicitly or via the legacy gate) | **Yes, accepted** | Same class as today's single-renderer exposure and #86's foreground `app-global-mutate` (`electron.md` § Accepted risk). Recorded in the v35 section. |
| Local user launches with `--use-fake-ui-for-media-stream` | Out of model | The local account owner is outside the threat model. The e2e asserts the flag is absent; T0 row 5 records its effect. |

**Fail-closed defaults:** unbound, PiP, subframe or stale → deny; non-holder → deny; handoff pending → nobody granted; dialog throws or aborts → `declined`; `whoAmI === null` documents never reach `capture:acquire` (#86); no `setDisplayMediaRequestHandler`.

## 5. Rollout and compatibility

### 5.1 Ordering

Desktop-only, one PR after #86 merges. No server, Hosted or Self-Hosted change. **Release gate (R16, Q3):** no release tag contains #86 without #87; the `v1.0.0` release-classification checklist states this. #86's arbiter default is not reopened.

### 5.2 Mixed-version matrix

| Shell | SPA | Behaviour |
|---|---|---|
| 35 | bundled (`app://concord`, self-hosted views) | lockstep, full lease |
| 35 | remote `saas` SPA, lease-aware | full lease |
| 35 | remote `saas` SPA pre-35 (deploy lag, rollback, LKG) | **legacy gate:** implicit lease at the request handler when free ∧ foreground; held until generation advance or a move; a move away always reaches the crash fallback (legacy documents never ack) and the legacy document shows no banner (F13). Logged once per generation (`[capture] legacy implicit lease`). |
| ≤34 | lease-aware SPA | bridge absent → `captureLeaseClient` returns `granted`; `captureLease` stays `'none'`; today's behaviour |

**The compatibility gate is T0 row 1.** If it passes, the matrix holds and the remote SPA deploy may go in either order. If it fails: the check becomes `isHolder`; the legacy gate is removed; `DeviceSelector` acquires `device-test` before `enumerateDevices`; the remote SPA lease-aware build deploys **before** shell 35 is released; the SPA deploy runbook records a rollback floor at that build.

## 6. Decomposition

| Task | Deliverable | Depends | Parallel |
|---|---|---|---|
| T0 | Real-Electron probe, `desktop/spikes/capture-gate/` (not CI), `--use-fake-device-for-media-stream` **without** `--use-fake-ui-for-media-stream`. Rows: (1) the request fires on every `getUserMedia` when the check returns true; (2) a denied request → `NotAllowedError`; (3) `chromeMediaSource` → `display-capture`; (4) `forcefullyCrashRenderer`+`reload` ends tracks in a document with a `beforeunload` veto, and plain `reload()` does not; (5) effect of the fake-UI flag; (6) a parented `showMessageBox` is modal to the `BaseWindow` on macOS, Windows and Linux, and `signal.abort()` closes it (F7, F12); (7) a hidden `WebContentsView`'s `document.visibilityState` reports `hidden` (banner announcement path, §3.8). Results recorded in the ADR. **Row 1 selects §5.2's branch; row 7 selects the banner's visibility signal.** | #86 T0 fixture | first |
| T1 | `shared/captureLease.ts` types + guards + tests | #86 T1 | P |
| T2 | `main/captureLease.ts` state machine, claims, handoff, generation and foreground listeners, push targeting, `mainResourceCounts()`; `onForegroundChanged` export in `connectionRegistry.ts` | #86 T2 | P with T3, T5 |
| T3 | `captureCeremony.ts` (DI, labels + truncation, `signal`, `normalizeAccessKeys`, `captureCeremonyBudget`, cross-kind mutex shared with the self-hosted ceremony) | — | P |
| T4 | Arbiter policy, `getDesktopSources` / `audiocap:start` gating, tray snapshot map + routing, `permission:changed` delivery, SH#112 seam | T2, #86 T3/T7 | — |
| T5 | `ipc/sso.ts` loopback keying and supersede, `:855` settle logging (reduced: the rest is #86's, *(#86 as built, 2026-11-11)*) | T2 | P with T4 |
| T6 | Contract 35: registry rows, preload `electron.capture.*`, `ipcContract.ts` history entry | T1–T5 | — |
| T7 | Renderer: `captureLeaseClient`, `joinChannel` acquire + `declined` path, release classification incl. `emergencyCleanup({ keepCaptureLease })`, revoke handler, device-test hooks + `stoppedReason`, three `voiceStore` fields + `reset()` preserve list + `gracefulReset` clearing, join-control hint/pending, `CaptureMovedBanner`, `CaptureLeaseAnnouncer`, copy, contrast-test pairs, visual check | T6 | — |
| T8 | e2e `tests/e2e/captureArbitration.spec.ts`; ADR-0052; docs (§8) | all | — |

Sequence: T0 → T1 → {T2, T3, T5} → T4 → T6 → T7 → T8. Phase-4 count probe: test files only (no store, migration, route or package count change).

## 7. Test strategy

**Unit (vitest; `tests/unit/{main,shared,services,hooks,components,styles}`):**
- Lease matrix: free/foreground → granted; free/background → `not-foreground`; holder re-acquire from background → granted; held + device-test → `held`; held + join (foreground) → ceremony; busy (in flight, handoff, bucket, cross-kind mutex); declined; dialog throws → declined; signal abort → declined then `superseded` on re-check; holder changed during the ceremony → `busy`; holder freed during the ceremony → granted with no handoff.
- Claims: a device test inside the holder's call, then its release, leaves the lease held (R4).
- Handoff: the gate is false for A before the push; `revokeAudiocapShare` (→ `killAudiocapCapture`) called and the probe result unchanged; ack → grant; A's generation advance → grant; timeout (fake timers) → `forcefullyCrashRenderer` then `reload`, exactly once each; B's advance mid-handoff → `superseded`, lease free.
- Generation listener for every reason (document-replacing ends the holder; credential re-keys it); foreground-change revocation of device-test-only leases; push targeting (background non-holder receives nothing; former holder receives one `{false,false}`).
- Arbiter decide table: {holder, non-holder, unbound, PiP, subframe, stale, legacy-free-foreground, legacy-free-background, legacy-during-handoff} × {`media`, `display-capture`} × {request, check-T0-pass, check-T0-fail}. `setDisplayMediaRequestHandler` never installed.
- `getDesktopSources` refusal makes no `desktopCapturer` call; `audiocap:start` refusal does not fork.
- Tray snapshot selection; loopback (one per connection; supersede; R10; stale own port after supersede; settle logging classes). Credential reasons on the holder re-key the lease and do not free it *(#86 as built, 2026-11-11)*.
- Ceremony: labels only from `ServiceRecord` (payload-injection test); punycode host; 28-char middle truncation; equal labels → "your other connection"; default/cancel = Stay; `normalizeAccessKeys: true` and `signal` present in options; quit → declined; bucket 3 then `busy`, refill after 20 s.
- Guards reject extra keys.

**Renderer:**
- `joinChannel` acquires before `authorizeVoiceJoin`, E2EE init, `getUserMedia`; non-grant calls none of them; `declined` resolves without `setJoinError` and bumps `captureDeclinedSeq`; other reasons map to the copy table.
- One test per release site in §3.8; `useConnectionRecovery` keeps the claim; an abandoned rejoin releases.
- Revocation order: `captureMovedNotice` set before `emergencyCleanup`; rejoin ticket cleared; no auto-rejoin; releases; `captureLease` → `'none'`.
- `reset()` preserves `captureLease` and `captureMovedNotice`; `gracefulReset()` clears them.
- Join control: `aria-describedby` present only when `'other'`; pending sets `aria-busy` + `aria-disabled`, never `disabled`; focus remains after Stay; repeat click guarded.
- Device-test hooks: `held` row; `backgrounded` row; row cleared on next Start.
- `CaptureMovedBanner`: renders only when the flag is set; Dismiss focus target rule; text set after visibility; `CaptureLeaseAnnouncer` rAF + guard.
- `contrast-pairs.test.ts`: new selectors' pairs; `--state-focused` vs `--bg-secondary` and `--bg-tertiary` in all 30 combinations and `data-high-contrast`.
- Legacy-shell path unchanged.

**Mutation-checked:** every deny/refuse branch has a test that turns red when its guard is removed.

**Keep green:** `audiocapIpc.test.ts`, `audiocapHost.test.ts`, `ssoLoopback.test.ts`, `main.test.ts` ordering pins, `preload-sandbox-contract.test.ts`, `tray*.test.ts`, `permissionManager.test.ts`, `VoiceAudioSection.test.tsx`, the #86 classification snapshot.

**e2e** (real Electron; extends #86's `_electron` fixture and two fixture control planes; fake devices; **no fake-UI flag**, asserted at fixture start):
- B's `getUserMedia` while A holds → `NotAllowedError`.
- Injected ceremony Join → main observes A's ack (or A's `render-process-gone`) **before** B's grant; B's tracks go live afterwards; A's banner flag is set.
- Injected Stay → A unaffected; B's control returns to idle.
- Hostile-holder stub ignores revocation and installs a `beforeunload` veto → A crashed and reloaded at the timeout, then B granted.
- A reload releases the lease.
- Three-service CVNet+A+B: exactly one document has live tracks at any sampled instant; no audiocap child outside the holder.
- 50× loopback start/cancel churn on B leaves A's SSO and voice untouched; `mainResourceCounts()` returns to baseline.
- Legacy-SPA fixture captures when free and foreground — `test.fixme` *(#86 as built, 2026-11-11)*: `contextBridge` freezes `window.electron`, so a view without the `capture` key cannot be booted; covered by unit rows. The hostile holder is a lease-aware view with a `beforeunload` veto and a wedged renderer.

**Visual (before the PR, captures attached):** pending join control; the hidden hint rendered visible in the a11y tree inspector; both device-test rows; banner at rest, hover, focus; every error string including long wrapped ones; all 15 schemes × dark/light, plus `data-high-contrast`, plus one 200% pass. The native ceremony captured once per platform, including macOS keyboard reach to Join.

**Coverage:** ≥80% on new code.

## 8. Docs to update (ship in the same PR)

| Doc | Change |
|---|---|
| `docs/adr/0052-exclusive-capture-lease.md` (provisional) | Decision; rejected dossier A and Option B; R1–R16, Q1–Q4, F1–F14; T0 results and the §5.2 branch taken; accepted free-lease risk; unthemed native dialog casualty; F13 known gap |
| `docs/self-hosted-client.md` | "Voice and capture across connections" (one voice session at a time; the join prompt and its two outcomes; the other connection sees you leave; the dialog is OS-styled); "OAuth callback ownership" (one ephemeral listener per connection, superseded on retry, closed on reload/close); terminology note for #88 |
| `.claude/rules/domains/electron.md` | "IPC contract v35: capture lease" section; Sender-frame rows for the lease-gated handlers; Accepted-risk paragraph; audiocap note (lease-gated `start`; handoff uses `killAudiocapCapture`); forced-end rule (crash, never bare reload); main-owned ceremony list now has two kinds under one modal mutex |
| `.claude/rules/domains/frontend.md` | Voice: join acquires first; `declined` is silent; revocation → notice before cleanup, no auto-rejoin; three `voiceStore` fields and the `reset()` preserve rule; generic copy table; `aria-disabled` pending pattern; banner placement after `UpdateBanner` |
| `.claude/rules/domains/e2ee.md` § Media frame crypto | The media key context exists only in the lease holder's document and is destroyed before another document is granted |
| `.claude/rules/domains/native-audio.md` | `audiocap:start` requires the lease; handoff kill is `killAudiocapCapture` |
| `desktop/tests/README.md` | New e2e spec; count; the no-fake-UI rule |
| `desktop/docs/STATE_MANAGEMENT.md` | `voiceStore` fields and preserve semantics (store count unchanged) |
| `src/main/ipcContract.ts` history | v35 entry |
| Generated rule mirrors | Re-synced |

## 9. Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | CVNet + A + B with identical remote ports: no local listener or callback collision; at most one ephemeral loopback per connection | loopback unit + e2e churn |
| A2 | Concurrent SSO ceremonies cannot overwrite, replay or consume each other's state | #86's owner-bound handles and any-advance teardown (`ssoCrossConnection.test.ts`), per-connection supersede, identity-guarded deletes |
| A3 | A hostile service cannot start capture (including from the background), steal a session, or receive another service's media or keys | §4 tests; e2e `NotAllowedError`; three-service scenario |
| A4 | Repeated connect/refuse/reconnect and a failed service stay bounded and preserve other connections | `mainResourceCounts()` baseline after churn; generation teardown units |
| A5 | Structural E2EE and encrypted transports preserved; TURN unchanged | no diff in `mediaEncryption.ts` / TLS / TURN; e2ee suites green |
| A6 | Explicit consent in a main-owned dialog precedes any move; Stay is the default and is silent; the previous holder's capture ends before the new holder is granted | ceremony DI tests; e2e ordering assertion including the veto stub |
| A7 | `IPC_CONTRACT_VERSION` = 35; `SPA_MIN_CONTRACT` = 19; legacy SPA and legacy shell paths work | `classify-release.yml`; legacy e2e |
| A8 | No new dependency; sandbox/contextIsolation pins; registry classification complete | empty lockfile diff; `preload-sandbox-contract`; snapshot |
| A9 | ADR-0043 preserved: the handoff never reaps the probe | probe-result-unchanged test |
| A10 | Renderer surfaces accessible (no native `disabled`, hint via `aria-describedby`, focus never lands on `<body>`, no timer) and visually verified in all 30 combinations + high contrast + 200%; native dialog captured per platform | component tests; contrast pairs; captures |
| A11 | **Docs to update**: every §8 row lands in the PR | docs-reviewer |
| A12 | **Quality gate** (`docs/ci/quality-gate-definition.md`; absent in Desktop; use the org copy): 0 new blocker/critical issues, 0 new high-confidence security hotspots, ≥80% new-code coverage | SonarCloud PR decoration |

## 10. Risk register

| Risk | L | I | Mitigation |
|---|---|---|---|
| Chromium skips the request when the check is true | M | Critical | T0 row 1 selects §5.2's branch; e2e `NotAllowedError` |
| Holder's tracks outlive the handoff | L (post-R1) | Critical | gate first; audiocap kill; crash-not-reload |
| Lease stuck after a misclassified `emergencyCleanup` path | L (classified in §3.8) | Low | per-site tests; cost is one unnecessary ceremony; same-connection re-acquire is idempotent |
| Honest holder misses the 5 s ack under load and is crashed | L | Medium | ack is synchronous in the push handler (Q4) |
| Legacy SPA moved away is always crashed and shows no banner | Certain in the mixed window | Low | documented (F13); ends when the remote SPA deploys |
| Parented dialog not modal on some platform (F7 depends on it) | L | Medium | T0 row 6; reopen the `busy` split if it fails |
| Hidden views do not report `visibilityState: hidden` | M | Low | T0 row 7; `capture:lease` push fallback already in the contract |
| `--state-focused` ring fails contrast on a scheme | M | Low | contrast-test rows; per-scheme override |
| #86-only release ships uncontrolled multi-capture | M | High | R16 release gate (Q3) |
| #90 collides in `ipc/sso.ts` | M | Medium | #87 edits only keying, supersede and logging (#86 as built, 2026-11-11); seam named |
| Forced crash triggers crash-reporting noise | L | Low | `reason=killed` is distinguishable; the ADR notes it |
| ADR number collision | L | Low | re-grep before merge |

## 11. Open items for the maintainer

Decided defaults the maintainer may still override, with the cost of overriding:
1. **D1 native ceremony (Q1).** Override to a renderer-themed dialog requires accepting that a compromised foreground renderer may move capture to itself without consent (Option B rewrite of §4). The native dialog is OS-styled, so a dark app may show a light dialog.
2. **`HANDOFF_ACK_TIMEOUT_MS` 5000 + crash-then-reload (Q4).**
3. **R12** device-test lease revoked on background (Q2).
4. **R16** #86 and #87 ship in the same release (Q3).

Informational, no decision required for #87:
5. **D3 consequence (E6):** there is no listen-only join on B while A holds capture. This follows from the binding exclusive-lease decision; relaxing it is a new decision, not a #87 option.
6. **Terminology:** renderer copy says "connection"; #88 aligns or changes all strings together.

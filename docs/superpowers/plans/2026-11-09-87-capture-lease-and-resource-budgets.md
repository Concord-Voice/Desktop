# Exclusive Capture Lease and Owner-Bound Main Resources (Desktop #87) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make microphone, camera and screen capture exclusive to one connection at a time, moved only through a main-owned consent dialog, and bind the audio-capture child, the OAuth loopback listeners and the tray to the connection that owns them so that each releases when that connection's generation advances.

**Architecture:** A main-process lease state machine (`captureLease.ts`) keyed on #86's `ConnectionRef` is the single authority; the Chromium permission handlers (`media`, `display-capture`), `media:getDesktopSources` and `audiocap:start` all ask `isHolder(ref)`. A `voice-join` acquire against a held lease runs a native `dialog.showMessageBox` ceremony; Join triggers an ack-or-crash handoff (gate flips first, audiocap child killed, 5 s then `forcefullyCrashRenderer()` + `reload()`). The renderer adds a thin `captureLeaseClient` service, three `voiceStore` fields, a hint, two device-test rows and a moved banner — no new store, no `voiceService.ts` rewrite.

**Tech Stack:** Electron 45.0.0 (`dialog.showMessageBox(BaseWindow, …)` with `signal` + `normalizeAccessKeys`, `WebContents.forcefullyCrashRenderer`), TypeScript, Vitest (unit, `desktop/tests/unit/**`), Playwright `_electron` (e2e; #86 Task 10 fixture), React + Zustand ^5.0.16 (three fields on `voiceStore`, no new store).

**Spec:** `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` (committed in Task 0 from the panel's final spec). Section references (§n) are to that spec. **Upstream contract:** `docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md` and `docs/superpowers/plans/2026-11-09-86-connection-context-isolation.md` — every #86 name used below is taken verbatim from the #86 plan's Interfaces blocks and is never redefined here. This branch stacks on `feature/86-isolate-connection-contexts`; every task may assume all of #86 exists.

## Global Constraints

- `IPC_CONTRACT_VERSION` **34 → 35** (`desktop/src/main/ipcContract.ts:328`; #86 takes 34); `SPA_MIN_CONTRACT` **stays 19** (`:361`); server `spaIpcContract` not raised. Renderer feature-detects `typeof globalThis.electron?.capture?.acquire === 'function'`.
- Maintainer defaults, accepted: **D1** native `dialog.showMessageBox` ceremony (Q1); **`HANDOFF_ACK_TIMEOUT_MS = 5000`** then `forcefullyCrashRenderer()` + `reload()` (Q4, R1); **R12** a device-test-only lease is revoked when its connection leaves the foreground; **R16** #86 and #87 ship in the same release (no tag contains #86 without #87).
- **No new dependency** (`package-lock.json` untouched), **no new Zustand store**, **no new design token**. Only existing tokens: `--bg-secondary`, `--bg-tertiary`, `--bg-hover`, `--border-color`, `--text-primary`, `--state-focused`.
- #86 names consumed verbatim: `ConnectionRef`, `ConnectionId`, `Generation`, `GenerationReason`, `ConnectionRecord`, `ServiceRecord`, `BindingRole`, `bindOwner(kind, ref)`, `isOwnerCurrent(b)`, `requireOwner(event, b)`, `onGenerationAdvanced(l)`, `foreground()`, `setForeground(id)`, `recordFor(id)`, `getService(id)`, `MAX_LIVE_CONNECTIONS`, `CaptureArbiter`/`captureArbiter()`/`setCaptureArbiter(a)`/`defaultCaptureArbiter`, `trayOwner()`/`setTrayOwner(ref | null)`, `registerIpc(channel, cls, handler, opts?)` + `AdmissionClass` + `CHANNEL_CLASSES`, `ConnectionSender`, `requireConnectionSender`, `sendToConnection(ref, channel, …args)`, `foregroundWebContents()`, `LoopbackHandle.owner: ConnectionRef`. The capability kind for the lease is #86's **`'capture-lease'`** (the spec's `bindOwner('capture', ref)` is a typo against #86's `CapabilityKind`; `'capture-lease'` wins).
- Handlers register only through `registerIpc`; `capture:acquire` and `capture:release` are class **`connection-bound`** (admission = registered primary main frame); the foreground rule for a fresh acquire is enforced inside the lease module because a holder's re-acquire is deliberately not foreground-gated (§3.2 step 2).
- Preload imports only `electron` and `desktop/src/shared/**` pure TS (`tests/integration/preload-sandbox-contract.test.ts` stays green). Every push is validated with an exact-key guard, then copied.
- All lease mutations are synchronous in main; the only awaits are the ceremony and the handoff wait, each followed by an `isOwnerCurrent` + holder-identity re-check (§3.10). No new `await` on the quit path.
- Audiocap: the handoff and the generation listener call **`killAudiocapCapture()`**, never `killAudiocapHost()` (R2, ADR-0043). `setDisplayMediaRequestHandler` stays uninstalled (§3.5).
- No cross-service identity reaches a renderer: labels in the native dialog come only from main (`'Concord Voice'` or the punycode `URL.host` of `ServiceRecord.origin`); renderer copy says "connection", "call", "microphone" (§3.8 copy table, verbatim).
- Guarded controls use `aria-disabled` + an activation guard, never native `disabled` (`frontend.md:2436` O1); hints via `aria-describedby`, never `title`; no timer on the dialog (WCAG 2.2.1); focus never lands on `<body>`.
- Commits: Conventional Commits with a **bare type** (`feat:`, `test:`, `docs:`, `refactor:`, `chore:`); the hook rejects `type(scope):`. At least one commit per task. Never stage `.claude/state/` or `.superpowers/`. Docs ship inside the task that changes the behaviour (§8 rows are distributed below).
- Test commands run from `desktop/`: `npx vitest run <path>`; `npm run lint`; `npm run typecheck`; `npm run build:main`. Keep green: `audiocapIpc.test.ts`, `audiocapHost.test.ts`, `ssoLoopback.test.ts`, `main.test.ts` ordering pins, `preload-sandbox-contract.test.ts`, `tray*.test.ts`, `permissionManager.test.ts`, `VoiceAudioSection.test.tsx`, the #86 classification audit.
- T0 runs only on the executor's machine (**macOS arm64**). Windows x64 and Linux x64 rows are **NOT MEASURED** with the reason; nothing is fabricated. The ADR carries exactly what was measured.
- ADR number **0052 is provisional**: re-grep `docs/adr` across every org checkout immediately before merge (#86 holds 0051 provisionally; highest org-wide on 2026-11-09 was 0050).
- Phase-4 count probe: only test-file counts change (no store, migration, route or Go package); run `./scripts/update-claude-md-counts.sh` if it exists in Desktop, otherwise update `desktop/tests/README.md` by hand (Task 8).

## Review Focus

Input classes the spec implies but no spec'd test exercises; each has a test added to the owning task below.

1. **Lease-state push arrives before the SPA subscribes** (main pushes `capture:lease` to a view the moment it becomes foreground; the SPA boots later) — the join hint must still show `'other'`; preload caches the last validated push and replays it to the first subscriber. (Task 6.)
2. **Acquire during quit, and a handoff timer pending at quit** — `isQuitting()` true → `declined` with no dialog; both quit hooks call `shutdownCaptureLeaseForQuit()` (aborts an open ceremony signal, clears the handoff timer) so no renderer is crashed during shutdown. (Tasks 2, 4.)
3. **The named holder's lease ends on its own while the dialog is open** (A leaves voice or reloads) — Join grants B with **no handoff** and A receives **no** `moved` revocation (no banner); Stay leaves the lease free. (Tasks 2, 7A.)
4. **Double activation of a join control** (double-click or Enter twice) while free — exactly one `acquire`, the claim set holds one `voice-join`, the second activation is guarded; a later single `release` frees the lease. (Tasks 2, 7B.)
5. **Foreground becomes `null`** (last view disposed, window closing) and a `backgrounded` revocation for a connection whose `webContents` is gone — no throw, no push, lease cleared. (Task 2.)

---

## File Structure

| File | Responsibility |
|---|---|
| `desktop/src/shared/captureLease.ts` | Channel constants, `CaptureIntent`, `CaptureAcquireResult`, `CaptureLeaseState`, `CaptureLeaseRevoked`, exact-key guards (pure; preload + renderer) |
| `desktop/src/main/captureLease.ts` | Lease state machine: holder, claims, handoff, legacy gate, generation + foreground listeners, push targeting, counters |
| `desktop/src/main/captureCeremony.ts` | Native dialog options (exact copy), main-sourced labels, truncation, `signal`, DI `showMessageBox` |
| `desktop/src/main/captureCeremonyBudget.ts` | Token bucket: capacity 3, refill 1 per 20 s |
| `desktop/src/main/modalMutex.ts` | One main-owned modal at a time across ceremony kinds (R13) |
| `desktop/src/main/capturePolicy.ts` | The `CaptureArbiter` that replaces #86's default for `media` / `display-capture`; T0-selected check policy |
| `desktop/src/main/mainResourceCounts.ts` | Read-only `mainResourceCounts()` composing lease, tray, loopback and audiocap counters (tests only) |
| `desktop/src/renderer/services/voice/captureLeaseClient.ts` | Bridge wrapper: `acquire`/`release`, lease view mapping, pending flag, revoked emitter; legacy shell → `granted` |
| `desktop/src/renderer/services/voice/captureRevocation.ts` | The `moved` / `backgrounded` handler (order: notice → cleanup → release) |
| `desktop/src/renderer/components/Voice/CaptureMovedBanner.tsx` + `.css` | Banner after `<UpdateBanner />` |
| `desktop/src/renderer/components/Voice/CaptureLeaseAnnouncer.tsx` | Polite SR region (#3394 pattern) |
| `desktop/spikes/capture-gate/` | T0 real-Electron probe (not CI) |

Modified: `connectionRegistry.ts` (+`onForegroundChanged`, `ServiceRecord.capabilities?`, `serviceMediaCapability`), `connectionSession.ts` (additive `ArbiterContext` on `decide`), `ipc/trayStatus.ts` (snapshot map), `ipc/audiocap.ts` (holder gate), `audiocapHost.ts` (+`audiocapCaptureActive()`), `permissionManager.ts` (holder delivery), `main.ts` (`getDesktopSources`, modal mutex at the approval ceremony, lease init, quit hooks), `ipc/sso.ts`, `ipc/connection.ts` (modal mutex), `ipc/channelClassification.ts`, `ipcContract.ts`, `preload/preload.ts`, `voiceService.ts`, `useConnectionRecovery.ts`, `useMicTest.ts`, `useCameraTest.ts`, `mediaCapabilities.ts`, `voiceStore.ts`, `resetService.ts`, `AudioConfigSection.tsx`, `VideoConfigSection.tsx`, join controls (`VoiceView.tsx`, `DMChatArea.tsx`, any other `joinChannel(` caller), `App.tsx`, `contrast-pairs.test.ts`, docs per §8.

**Sequence:** T0 → T1 → {T2, T3, T5} → T4 → T6 → T7A → T7B → T8. T7 is split (semantics vs surfaces) because a reviewer can reject the UI while approving the lease wiring; each half has its own test cycle. T0 also commits the spec file.

---

### Task 0: Capture-gate probe (`desktop/spikes/capture-gate/`, not CI) + commit the spec

**Files:**
- Create: `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` (copy of the panel's final spec, verbatim), `desktop/spikes/capture-gate/README.md`, `desktop/spikes/capture-gate/main.mjs`, `desktop/spikes/capture-gate/renderer.html`, `desktop/spikes/capture-gate/results/macos-arm64.md`, `desktop/spikes/capture-gate/results/windows-x64.md`, `desktop/spikes/capture-gate/results/linux-x64.md`
- Reference: `desktop/spikes/connection-footprint/` (#86 T0 shape), `desktop/spikes/s2-windows-loopback/`

**Interfaces:**
- Consumes: Electron 45 `session.setPermissionRequestHandler` / `setPermissionCheckHandler`, `webContents.forcefullyCrashRenderer()` / `reload()`, `dialog.showMessageBox(BaseWindow, { signal })`, `WebContentsView`, flags `--use-fake-device-for-media-stream` (always) and `--use-fake-ui-for-media-stream` (row 5 only).
- Produces: `results/macos-arm64.md` with rows 1–7 and two decisions consumed downstream: **row 1 → `CAPTURE_CHECK_POLICY`** (Task 4) and the §5.2 branch (Task 7A/7B `DeviceSelector` step); **row 7 → banner visibility signal** (Task 7B).

- [ ] **Step 1: Write `main.mjs` + `renderer.html`** — plain ESM entry outside tsc/eslint/vitest globs. `BaseWindow` with two `WebContentsView`s (A, B) on `session.fromPath(<userData>/spike/<i>/session)`; each loads `renderer.html`, which exposes `window.probe = { gum(constraints), vetoUnload(), trackStates() }`. Main installs counting permission handlers (log `(view, permission, phase, mediaTypes, isMainFrame)`), accepts `--check=true|false`, `--fake-ui`, and drives rows: (1) check returns true → does the request handler fire on each `getUserMedia({audio:true})`? (2) request `callback(false)` → `NotAllowedError` name observed in the renderer; (3) `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop' } } })` → which permission string reaches the handlers; (4) with `vetoUnload()` installed and a live track: `reload()` alone — do tracks end? then `forcefullyCrashRenderer()` + `reload()` — do they end, and does `render-process-gone` fire with `reason: 'killed'`? (5) same run with `--fake-ui`: which handlers still fire; (6) `dialog.showMessageBox(baseWindow, { signal, … })` — is A's view inert while open (log a click attempt via `sendInputEvent`)? does `controller.abort()` close it and resolve? (7) `document.visibilityState` in the hidden view after `setVisible(false)`.
- [ ] **Step 2: Write the `README.md`** — how to run (`cd desktop && npx electron spikes/capture-gate/main.mjs --row=N`), the flag rule (**never** `--use-fake-ui-for-media-stream` except row 5), and the exact result table template (row, observed, run count, note).
- [ ] **Step 3: Run rows 1–7 on macOS arm64**, three runs each; record in `results/macos-arm64.md`. At the bottom write the two decisions in these exact forms: `CAPTURE_CHECK_POLICY = 'bound-primary-main-frame'` (row 1 PASS) or `'holder'` (row 1 FAIL); `BANNER_VISIBILITY_SIGNAL = 'visibilityState'` (row 7 reports `hidden`) or `'lease-push'`. If row 4 shows `forcefullyCrashRenderer()` + `reload()` does **not** end tracks: STOP and report to the orchestrator (R1 is invalid).
- [ ] **Step 4: Write `results/windows-x64.md` and `results/linux-x64.md`** with every row `NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09`. List what stays open in the ADR: row 6 modality on Windows/Linux (F7's `busy` split stays closed until measured), access-key reach on Windows/Linux.
- [ ] **Step 5: Copy the spec** to `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` unchanged.
- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md desktop/spikes/capture-gate
git commit -m "chore: add capture-gate spike results and the #87 design spec"
```

---

### Task 1: Shared types, channel constants and guards (`shared/captureLease.ts`)

**Files:**
- Create: `desktop/src/shared/captureLease.ts`
- Test: `desktop/tests/unit/shared/captureLease.test.ts`
- Reference: `desktop/src/shared/trayStatus.ts:44-170` (exact-key guard style), `desktop/src/shared/audiocapProtocol.ts`

**Interfaces:**
- Consumes: nothing (pure; no imports).
- Produces:

```ts
export const CAPTURE_ACQUIRE = 'capture:acquire'; export const CAPTURE_RELEASE = 'capture:release';
export const CAPTURE_LEASE_PUSH = 'capture:lease'; export const CAPTURE_LEASE_REVOKED_PUSH = 'capture:leaseRevoked';
export type CaptureIntent = 'voice-join' | 'device-test';
export type CaptureRejectReason = 'untrusted-sender' | 'not-foreground' | 'busy' | 'superseded' | 'unavailable';
export type CaptureAcquireResult =
  | { status: 'granted' } | { status: 'held' } | { status: 'declined' }
  | { status: 'rejected'; reason: CaptureRejectReason };
export interface CaptureAcquireInput { intent: CaptureIntent }
export interface CaptureLeaseState { held: boolean; mine: boolean }
export interface CaptureLeaseRevoked { reason: 'moved' | 'backgrounded' }
export function isCaptureIntent(v: unknown): v is CaptureIntent;
export function isCaptureAcquireInput(v: unknown): v is CaptureAcquireInput;      // exact keys
export function isCaptureAcquireResult(v: unknown): v is CaptureAcquireResult;    // exact keys per variant
export function isCaptureLeaseState(v: unknown): v is CaptureLeaseState;          // exactly {held, mine} booleans
export function isCaptureLeaseRevoked(v: unknown): v is CaptureLeaseRevoked;      // exactly {reason}
```

- [ ] **Step 1: Write the failing tests** (`captureLease.test.ts`): `isCaptureIntent` accepts both intents, rejects `'screen'`, `''`, `1`; `isCaptureAcquireInput` rejects an extra key (`{ intent: 'voice-join', leaseId: 'x' }`) and a missing key; `isCaptureAcquireResult` accepts every variant in the union and rejects `{ status: 'rejected' }` (no reason), `{ status: 'granted', extra: 1 }`, `{ status: 'rejected', reason: 'nope' }`; `isCaptureLeaseState` rejects `{ held: 1, mine: false }` and `{ held: true }`; `isCaptureLeaseRevoked` rejects `{ reason: 'moved', id: 'x' }`; the four constants equal their literal channel strings.
- [ ] **Step 2: Run to verify failure** — `cd desktop && npx vitest run tests/unit/shared/captureLease.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `shared/captureLease.ts` (no imports; `Object.keys(v).length` exact-key checks as in `trayStatus.ts`).
- [ ] **Step 4: Run to verify pass** → PASS; `npx vitest run tests/integration/preload-sandbox-contract.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/shared/captureLease.ts desktop/tests/unit/shared/captureLease.test.ts
git commit -m "feat: add capture lease shared types and guards"
```

---

### Task 2: Lease state machine (`main/captureLease.ts`) + `onForegroundChanged` + SH#112 seam

**Files:**
- Create: `desktop/src/main/captureLease.ts`
- Modify: `desktop/src/main/connectionRegistry.ts` (`setForeground` fires `onForegroundChanged` listeners synchronously; `ServiceRecord.capabilities?: { media?: boolean }`; `serviceMediaCapability`)
- Test: `desktop/tests/unit/main/captureLease.test.ts`, `desktop/tests/unit/main/connectionRegistry.test.ts` (extend)

**Interfaces:**
- Consumes (#86): `ConnectionRef`, `ConnectionId`, `Generation`, `GenerationReason`, `ConnectionRecord`, `foreground()`, `recordFor(id)`, `bindOwner('capture-lease', ref)`, `isOwnerCurrent(b)`, `requireOwner(event, b)`, `onGenerationAdvanced(l)`, `ConnectionSender`, `sendToConnection(ref, channel, …)`, `setTrayOwner(ref | null)`; Task 1 types + constants; Task 3 `runCaptureCeremony` and `tryAcquireModal` (DI — Task 3 lands in parallel; until then the tests inject fakes). `killAudiocapCapture()` from `audiocapHost.ts`.
- Produces:

```ts
// connectionRegistry.ts — additive
export function onForegroundChanged(l: (prev: ConnectionRecord | null, next: ConnectionRecord | null) => void): () => void;  // fired synchronously inside setForeground, after the write; not fired when prev === next
export interface ServiceRecord { …#86 fields…; capabilities?: { media?: boolean } }   // no producer in #87 (SH#112)
export function serviceMediaCapability(id: ConnectionId): boolean | undefined;        // recordFor(id) → getService(serviceId)?.capabilities?.media
// captureLease.ts
export const HANDOFF_ACK_TIMEOUT_MS = 5000;
export interface CaptureLeaseDeps {
  foreground(): ConnectionRecord | null; recordFor(id: ConnectionId): ConnectionRecord | undefined;
  sendToConnection(ref: ConnectionRef, channel: string, ...args: unknown[]): boolean;
  setTrayOwner(ref: ConnectionRef | null): void; killAudiocapCapture(): void;
  serviceMediaCapability(id: ConnectionId): boolean | undefined; isQuitting(): boolean;
  runCeremony(from: ConnectionRef, to: ConnectionRef, signal: AbortSignal): Promise<'join' | 'stay'>;   // Task 3 wraps labels + dialog
  tryAcquireModal(): (() => void) | null;                                                            // Task 3 modalMutex('capture')
  consumeCeremonyToken(): boolean;                                                                   // Task 3 bucket
  crashAndReload(record: ConnectionRecord): void;   // record.webContents.forcefullyCrashRenderer(); record.webContents.reload()
}
export function initCaptureLease(deps: CaptureLeaseDeps): () => void;   // subscribes onGenerationAdvanced + onForegroundChanged; returns dispose
export function acquire(sender: ConnectionSender, input: unknown): Promise<CaptureAcquireResult>;   // no await before §3.2 step 6
export function release(sender: ConnectionSender, event: IpcMainInvokeEvent, input: unknown): boolean;   // synchronous, never throws
export function isHolder(ref: ConnectionRef): boolean;  export function isFree(): boolean;  export function holderRef(): ConnectionRef | null;
export function isLeaseAware(ref: ConnectionRef): boolean;  export function markLeaseAware(ref: ConnectionRef): void;   // Map<ConnectionId, Generation>
export function legacyAcquire(ref: ConnectionRef): boolean;   // §5.2: !isLeaseAware ∧ isFree ∧ ref is foreground → holder {claims:{voice-join}, legacy:true}; logs once per generation '[capture] legacy implicit lease'
export function shutdownCaptureLeaseForQuit(): void;          // synchronous: aborts an open ceremony signal (resolves 'stay' → declined) and clears a pending handoff timer; called from both quit hooks (Task 4)
export function captureLeaseCounts(): { holder: 0 | 1; handoff: 0 | 1; claims: number; leaseAware: number };
export function _resetCaptureLeaseForTesting(): void;
```

Decisions the spec left open, fixed here: `leaseAware` is a `Map<ConnectionId, Generation>` compared against `ref.generation` (the spec's `WeakMap<OwnerBinding>` cannot key a non-holder — a requester has no binding until granted); the lease binding kind is `'capture-lease'`; a `'backgrounded'` revocation reuses the handoff path with `to = null` (no grantee; the lease ends free); `acquire` while `isQuitting()` → `{ status: 'declined' }` without a dialog.

- [ ] **Step 1: Write the failing registry additions** in `connectionRegistry.test.ts`: `onForegroundChanged` receives `(prev, next)` synchronously inside `setForeground`; not fired when the id is unchanged; fired with `next === null` on `setForeground(null)`; unsubscribe stops delivery; `serviceMediaCapability` is `undefined` when `capabilities` is absent, `false` only when set `false`.
- [ ] **Step 2: Write the failing lease matrix** (`captureLease.test.ts`; fake `ConnectionSender`s built through #86's registry mocks; `vi.useFakeTimers()`; deps injected as spies). One `it` per row:
  - `acquire` free + foreground `voice-join` → `granted`; `captureLeaseCounts().holder === 1`; `setTrayOwner(ref)` called; `sendToConnection(ref, 'capture:lease', { held: true, mine: true })`.
  - free + background → `{ rejected: 'not-foreground' }`, **before** any held check (held by C → still `not-foreground`, no ceremony, no push).
  - holder re-acquire from background (`device-test`) → `granted`, claims 2; `release('device-test')` → lease still held (R4); `release('voice-join')` → free, former holder receives one `{ held: false, mine: false }`.
  - `serviceMediaCapability === false` → `{ rejected: 'unavailable' }` before any ceremony.
  - held + foreground `device-test` → `held`, no ceremony.
  - held + foreground `voice-join` → `runCeremony(holderRef, requesterRef, signal)` called once; `'stay'` → `declined`, holder unchanged; ceremony throws → `declined`; `signal` aborted by the requester's `advanceGeneration` → `declined`, then a second call from the stale sender → `superseded`.
  - `busy` rows: `tryAcquireModal()` null; `consumeCeremonyToken()` false; handoff pending; a second `acquire` while the first ceremony is open.
  - holder changed during the ceremony (C acquired after A released) → `busy`; holder freed during the ceremony and `'join'` → `granted` with **no** `capture:leaseRevoked` push and no `crashAndReload` (Review Focus 3); same with `'stay'` → `declined`, lease free.
  - handoff: after `'join'`, synchronously `isHolder(A) === false`, `isFree() === false`, `killAudiocapCapture` called once, `sendToConnection(A, 'capture:leaseRevoked', { reason: 'moved' })`; A's `release` (any intent) → B `granted`; A's `advanceGeneration('document')` → B `granted`; `vi.advanceTimersByTime(4999)` → nothing; `5000` → `crashAndReload(A)` exactly once, then A's `renderer-gone` → B `granted`; B's advance mid-handoff → B `superseded`, lease free.
  - generation listener: each of the five reasons on the holder clears the lease, calls `killAudiocapCapture`, `setTrayOwner(null)`, pushes `{ held: false, mine: false }` to the foreground; on a non-holder → no effect.
  - `onForegroundChanged`: prev holds `{device-test}` only → prev receives `capture:leaseRevoked { reason: 'backgrounded' }`, lease free after prev's release or at 5 s crash; prev holds `{voice-join}` → nothing; `next` receives `{ held: holder !== null, mine: false }`; `next === null` → no push, no throw (Review Focus 5); a `backgrounded` revocation whose record is gone (`recordFor` undefined) → lease cleared, no throw.
  - `legacyAcquire`: free + foreground + not lease-aware → true, `legacy: true`; lease-aware (after any `acquire`) → false; background → false; handoff pending → false; logs once per generation.
  - `acquire` with `isQuitting()` true → `declined`, `runCeremony` not called (Review Focus 2); `shutdownCaptureLeaseForQuit()` while a ceremony is open → its `signal.aborted === true` and the acquire resolves `declined`; after `'join'` → timer cleared, `crashAndReload` never called.
  - double acquire `voice-join` from the holder → `granted` twice, `claims === 1` (Review Focus 4).
  - leave→rejoin ordering (§3.10): `release('voice-join')` then `acquire('voice-join')` from the same sender in one synchronous sequence → the acquire resolves `granted` with `claims === 1` and the former-holder `{false,false}` push precedes the `{true,true}` push.
  - `release` from a non-holder, malformed input, or stale generation → `false`, state unchanged. `acquire` with malformed input → `{ rejected: 'untrusted-sender' }`.
  - synchronous prologue: the fast paths (`granted` free, `held`, every `rejected`) resolve without a macrotask (assert with `vi.runAllTicks` not needed — resolve observed before `setImmediate`).
- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/unit/main/captureLease.test.ts tests/unit/main/connectionRegistry.test.ts` → FAIL.
- [ ] **Step 4: Implement** `captureLease.ts` and the registry additions. Push targeting per §3.2: holder `{true,true}`; foreground non-holder `{ holder !== null, false }`; former holder `{false,false}` once; nobody else. `crashAndReload` default (wired in Task 4) is `record.webContents.forcefullyCrashRenderer(); record.webContents.reload()`.
- [ ] **Step 5: Run to verify pass** → PASS; `npm run build:main` clean.
- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/captureLease.ts desktop/src/main/connectionRegistry.ts desktop/tests/unit/main/captureLease.test.ts desktop/tests/unit/main/connectionRegistry.test.ts
git commit -m "feat: add the exclusive capture lease state machine with ack-or-crash handoff"
```

---

### Task 3: Ceremony, budget and cross-kind modal mutex

**Files:**
- Create: `desktop/src/main/captureCeremony.ts`, `desktop/src/main/captureCeremonyBudget.ts`, `desktop/src/main/modalMutex.ts`
- Modify: `desktop/src/main/main.ts:2366-2380` (`requestSelfHostedApproval` call site at `:2485` acquires the `'self-hosted-approval'` slot; null → the handler's existing refused/`busy` shape), `desktop/src/main/ipc/connection.ts` (#86 `connection:create` acquires the slot before its ceremony; null → `{ status: 'rejected', reason: 'busy' }`)
- Modify: `.claude/rules/domains/electron.md` (main-owned ceremony list: two kinds under one modal mutex)
- Test: `desktop/tests/unit/main/captureCeremony.test.ts`, `desktop/tests/unit/main/captureCeremonyBudget.test.ts`, `desktop/tests/unit/main/modalMutex.test.ts`, `desktop/tests/unit/main/ipc/connection.test.ts` (extend), `desktop/tests/unit/main/selfHostedDialConsent.test.ts` (extend)

**Interfaces:**
- Consumes: Electron `dialog.showMessageBox(window: BaseWindow, options)`; `ServiceRecord` (#86); `selfHostedCeremonyBudget.ts` API shape (`consumeCeremonyToken(now)`, `_resetCeremonyBudgetForTesting`).
- Produces:

```ts
// captureCeremony.ts
export type ShowMessageBox = (w: BaseWindow, o: Electron.MessageBoxOptions) => Promise<{ response: number }>;
export const LABEL_MAX = 28;  export const OTHER_CONNECTION_LABEL = 'your other connection';
export function connectionLabel(service: Pick<ServiceRecord, 'kind' | 'origin'>): string;   // 'Concord Voice' | new URL(origin).host (punycode ASCII, incl. non-default port)
export function truncateLabel(label: string, max = LABEL_MAX): string;                      // middle '…'
export function buildCeremonyOptions(currentLabel: string, requestedLabel: string, signal: AbortSignal): Electron.MessageBoxOptions;  // §3.3 verbatim; equal labels → current = OTHER_CONNECTION_LABEL
export function runCaptureCeremony(win: BaseWindow, from: ServiceRecord, to: ServiceRecord, signal: AbortSignal, deps?: { showMessageBox?: ShowMessageBox }): Promise<'join' | 'stay'>;  // response 1 → 'join'; anything else, throw, or abort → 'stay'
export function _setShowMessageBoxForTesting(fn: ShowMessageBox | null): void;   // e2e seam (Task 8 via app.evaluate + require)
// captureCeremonyBudget.ts
export const CAPTURE_CEREMONY_CAPACITY = 3;  export const CAPTURE_CEREMONY_REFILL_MS = 20_000;
export function consumeCaptureCeremonyToken(now: number = Date.now()): boolean;
export function _resetCaptureCeremonyBudgetForTesting(): void;
// modalMutex.ts
export type ModalKind = 'capture' | 'self-hosted-approval';
export function tryAcquireModal(kind: ModalKind): (() => void) | null;   // null while ANY kind is held; release is idempotent
export function modalInFlight(): ModalKind | null;
export function _resetModalMutexForTesting(): void;
```

- [ ] **Step 1: Write the failing ceremony tests** (`captureCeremony.test.ts`): `buildCeremonyOptions('Concord Voice', 'a.example')` equals `{ type: 'question', noLink: true, normalizeAccessKeys: true, signal, title: 'Concord Voice', message: 'Join voice on a.example?', detail: "You're in a call on Concord Voice. Joining on a.example ends that call, and people on Concord Voice will see you leave. Concord Voice can use your microphone, camera and screen sharing on one connection at a time.", buttons: ['&Stay on Concord Voice', '&Join on a.example'], defaultId: 0, cancelId: 0 }`; `connectionLabel({ kind: 'selfhost', origin: 'https://bücher.example:8443' })` → `'xn--bcher-kva.example:8443'`; `connectionLabel({ kind: 'saas', … })` → `'Concord Voice'`; `truncateLabel` of a 40-char host is 28 chars with `'…'` in the middle, `detail` keeps the full host; equal labels → `message` names B and `detail` starts `"You're in a call on your other connection."`; payload injection: a `ServiceRecord` whose origin is `'https://evil.example/&Join'` yields a label equal to `'evil.example'` (host only); `showMessageBox` resolving `{ response: 1 }` → `'join'`, `{ response: 0 }` → `'stay'`, rejecting → `'stay'`; `signal.abort()` while pending → the injected `showMessageBox` sees `options.signal.aborted === true` and the result is `'stay'`; the `BaseWindow` passed is the first argument (no `BrowserWindow` cast).
- [ ] **Step 2: Write the failing budget + mutex tests**: three `consumeCaptureCeremonyToken(t0)` → true, fourth → false; at `t0 + 20_000` one more → true; at `t0 + 60_000` three → true; `_reset…` restores capacity. `tryAcquireModal('capture')` returns a release; while held `tryAcquireModal('self-hosted-approval')` → null and `modalInFlight() === 'capture'`; after release → the other kind acquires; releasing twice is a no-op.
- [ ] **Step 3: Write the failing integration rows**: in `connection.test.ts` — with `tryAcquireModal` held by `'capture'`, `connection:create` → `{ status: 'rejected', reason: 'busy' }` and `probe`/`ceremony` not called; in `selfHostedDialConsent.test.ts` — the `selfHosted:probeServer` approval path refuses while the capture modal is held, and releases its slot after the dialog resolves (even on throw).
- [ ] **Step 4: Run to verify failure** — `npx vitest run tests/unit/main/captureCeremony.test.ts tests/unit/main/captureCeremonyBudget.test.ts tests/unit/main/modalMutex.test.ts tests/unit/main/ipc/connection.test.ts tests/unit/main/selfHostedDialConsent.test.ts` → FAIL.
- [ ] **Step 5: Implement** the three modules; wire the slot into both approval call sites with `try { … } finally { releaseSlot() }`.
- [ ] **Step 6: Run to verify pass** → PASS; `npm run build:main` clean.
- [ ] **Step 7: Docs** — electron.md: in the main-owned ceremony text (near `:2361` references / the self-hosted approval section), state that main owns two ceremony kinds (self-hosted approval, capture move) under one modal mutex; the other returns `busy`; labels main-sourced, punycode, 28-char button truncation.
- [ ] **Step 8: Commit**

```bash
git add desktop/src/main/captureCeremony.ts desktop/src/main/captureCeremonyBudget.ts desktop/src/main/modalMutex.ts desktop/src/main/main.ts desktop/src/main/ipc/connection.ts desktop/tests/unit/main .claude/rules/domains/electron.md
git commit -m "feat: add the native capture-move ceremony with token bucket and modal mutex"
```

---

### Task 5: Loopback ownership in `ipc/sso.ts` (parallel with Task 4)

**Files:**
- Modify: `desktop/src/main/ipc/sso.ts:115` (`active` map re-keyed), `startLoopback` (supersede), `awaitCallback` / `cancelLoopback` (port cross-check), every `active.delete` (identity-guarded), `:618-619` (`.catch(() => {})` → `logLoopbackSettle`), new `onGenerationAdvanced` listener filtered to `document | renderer-gone | disposed`
- Modify: `docs/self-hosted-client.md` ("OAuth callback ownership")
- Test: `desktop/tests/unit/main/ssoLoopback.test.ts` (extend), `desktop/tests/unit/main/ipc/sso.test.ts` (extend)

**Interfaces:**
- Consumes (#86 T7B): `LoopbackHandle.owner: ConnectionRef`; `pendingMFA: Map<ConnectionId, …>`, `pendingCompletion: Map<ConnectionId, …>`; `ConnectionSender`; `onGenerationAdvanced`.
- Produces:

```ts
const active: Map<ConnectionId, LoopbackHandle>;                       // was Map<number /*port*/, LoopbackHandle>
export function loopbackCount(): number;                                // active.size (Task 6 mainResourceCounts)
function logLoopbackSettle(e: unknown): void;                           // console.debug for 'oauth_timeout' | 'cancelled'; console.warn(reason class) otherwise — never URL, code, state
function closeLoopbackFor(id: ConnectionId, reason: 'superseded' | 'cancelled' | 'generation'): void;   // identity-guarded: if (active.get(id) === handle) active.delete(id)
```

IPC shapes of `sso:startLoopback`, `sso:awaitCallback(port)`, `sso:cancelLoopback(port)` are unchanged; `port` is now a cross-check against `active.get(sender.ref.connectionId)?.port`, refused with the handler's existing refusal shape on mismatch. `state`, `code`, PKCE, redirect URI and the MFA proof path are untouched (#90).

- [ ] **Step 1: Write the failing tests**:
  - `ssoLoopback.test.ts`: `startLoopback` twice from A → the first handle's server is closed and its promise rejects `'cancelled'`, `loopbackCount() === 1`; the old handle's `finally` does **not** delete the new entry (identity guard — simulate the old settle after the new start); A and B each start → 2 entries, B's cancel leaves A's intact.
  - `sso.test.ts`: `awaitCallback(portOfA)` from B → refused; `cancelLoopback(wrongPort)` from A → refused and A's handle still active; `advanceGeneration(A, 'document')` → A's handle closed, `pendingMFA.get(A)` and `pendingCompletion.get(A)` undefined, B untouched; `advanceGeneration(A, 'credential-start')` → A's handle **and** pending slots untouched (R11); settle logging: `oauth_timeout` → `console.debug` once, an unknown error → `console.warn` whose argument contains no `code=`, `state=` or `http`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/ssoLoopback.test.ts tests/unit/main/ipc/sso.test.ts` → FAIL.
- [ ] **Step 3: Implement**; keep every existing assertion in both suites green.
- [ ] **Step 4: Run to verify pass** → PASS; `npm run build:main` clean.
- [ ] **Step 5: Docs** — `docs/self-hosted-client.md`: add "OAuth callback ownership" (one ephemeral listener per connection, superseded on retry, closed on reload/close; never shared across connections).
- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/ipc/sso.ts desktop/tests/unit/main/ssoLoopback.test.ts desktop/tests/unit/main/ipc/sso.test.ts docs/self-hosted-client.md
git commit -m "refactor: key SSO loopback listeners by connection with supersede and guarded teardown"
```

---

### Task 4: Arbiter policy, handler gating, tray snapshots, `permission:changed`, lease wiring in `main.ts`

**Files:**
- Create: `desktop/src/main/capturePolicy.ts`
- Modify: `desktop/src/main/connectionSession.ts` (additive `ArbiterContext` 4th parameter on `CaptureArbiter.decide`; the **check** handler for `media` / `display-capture` also routes through the arbiter), `desktop/src/main/main.ts:2000-2005` (`media:getDesktopSources` holder gate), `desktop/src/main/ipc/audiocap.ts:129-160` (`handleAudiocapStart` holder gate), `desktop/src/main/audiocapHost.ts` (+`audiocapCaptureActive()`), `desktop/src/main/ipc/trayStatus.ts:87-112` (snapshot map; `tray:setStatus` admission → `connection-bound`; display `trayOwner() ?? foreground()`), `desktop/src/main/ipc/channelClassification.ts` (`tray:setStatus` class), `desktop/src/main/tray.ts` (`tray:action` routing to `trayOwner() ?? foreground()`), `desktop/src/main/permissionManager.ts:255` (also deliver to the holder), `desktop/src/main/main.ts` (`initCaptureLease(deps)` after the shell window exists; `installCaptureLeaseArbiter()`; `clearHandoffForQuit()` in both quit hooks at `:1927` and `:1939`)
- Modify: `.claude/rules/domains/native-audio.md`, `.claude/rules/domains/electron.md` (Sender-frame rows for the lease-gated handlers; forced-end rule)
- Test: `desktop/tests/unit/main/capturePolicy.test.ts`, `desktop/tests/unit/main/connectionSession.test.ts` (extend), `desktop/tests/unit/main/audiocapIpc.test.ts` (extend), `desktop/tests/unit/main/ipc/trayStatusIpc.test.ts` (rewrite the #86 admission row), `desktop/tests/unit/main/tray.test.ts` (extend), `desktop/tests/unit/main/permissionManager.test.ts` (extend), `desktop/tests/unit/main/main.test.ts` (quit hooks + init order)

**Interfaces:**
- Consumes: Task 2 `isHolder`, `isFree`, `legacyAcquire`, `holderRef`, `initCaptureLease`, `shutdownCaptureLeaseForQuit`; Task 3 `runCaptureCeremony`, `tryAcquireModal`, `consumeCaptureCeremonyToken`; #86 `CaptureArbiter`, `setCaptureArbiter`, `defaultCaptureArbiter`, `bindingFor`, `recordFor`, `refOf`, `foreground()`, `trayOwner`/`setTrayOwner`, `sendToConnection`, `registerIpc`, `CHANNEL_CLASSES`; `desktopCapturer`, `killAudiocapCapture`.
- Produces:

```ts
// connectionSession.ts — additive
export interface ArbiterContext { phase: 'request' | 'check'; role: BindingRole | null; isMainFrame: boolean }
export interface CaptureArbiter { decide(ref: ConnectionRef | null, permission: string, details: unknown, ctx?: ArbiterContext): boolean }   // #86's two tests still pass (ctx optional, default arbiter ignores it)
// capturePolicy.ts
export const CAPTURE_CHECK_POLICY: 'bound-primary-main-frame' | 'holder';   // from Task 0 row 1 — cite results/macos-arm64.md in a comment
export const CAPTURE_PERMISSIONS: readonly ['media', 'display-capture'];
export function captureLeaseArbiter(fallback: CaptureArbiter): CaptureArbiter;
   // request: ref null | role !== 'primary' | !isMainFrame | stale → false; isHolder → true; ONLY under policy 'bound-primary-main-frame': legacyAcquire(ref) → true (§5.2 — the legacy gate is dropped on the T0-FAIL branch); else false
   // check: policy 'bound-primary-main-frame' → role === 'primary' && isMainFrame && current; policy 'holder' → isHolder   (ref null, incl. the service-worker case, is already false)
   // other permissions → fallback.decide(…)
export function installCaptureLeaseArbiter(): () => void;   // setCaptureArbiter(captureLeaseArbiter(defaultCaptureArbiter))
// audiocapHost.ts — additive, read-only
export function audiocapCaptureActive(): boolean;
// ipc/trayStatus.ts
export function traySnapshotFor(id: ConnectionId): TrayStatusSnapshot | null;  export function dropTraySnapshot(id: ConnectionId): void;
export function traySnapshotCount(): number;  export function displayedTrayConnection(): ConnectionId | null;   // trayOwner()?.connectionId ?? foreground()?.connectionId ?? null
```

Decision recorded here (R15 vs #86 T7B): #86 admits `tray:setStatus` from the tray owner only; R15 needs every primary's snapshot stored so the tray is not stale when a lease frees. **R15 wins**: `tray:setStatus` becomes `connection-bound`, snapshots are stored per connection (rate limit per connection), and only `displayedTrayConnection()`'s snapshot is applied. The #86 row "admitted from the foreground primary only" is rewritten to "stored for any primary; applied only for `displayedTrayConnection()`".

- [ ] **Step 1: Write the failing arbiter table** (`capturePolicy.test.ts`): `it.each` over {holder, non-holder, unbound, pip, subframe, stale, legacy-free-foreground, legacy-free-background, legacy-during-handoff} × {`media`, `display-capture`} × {request, check}; expected per §3.5 with both `CAPTURE_CHECK_POLICY` values exercised by stubbing the constant's module (the three legacy rows expect `false` under `'holder'`); `geolocation` → `false` and `notifications` → `true` still via the fallback; `setDisplayMediaRequestHandler` never called on any session (spy on every fake session from `connectionSession.test.ts`'s mocks). In `connectionSession.test.ts`: the check handler for `media` calls `captureArbiter().decide(ref, 'media', details, { phase: 'check', … })`; `webContents === null` → `false` without calling the arbiter's holder path.
- [ ] **Step 2: Write the failing handler tests**: `main.test.ts`/a new `getDesktopSources` row — non-holder → resolves `undefined` and `desktopCapturer.getSources` **not** called; holder → called. `audiocapIpc.test.ts`: non-holder `audiocap:start` → the same `AudiocapStartResult` value `handleAudiocapStart` returns today for an untrusted sender (read it at `ipc/audiocap.ts:129-160`; no new variant) and no `fork`; holder → proceeds; `audiocapCaptureActive()` false after `killAudiocapCapture()` and `audiocapProbeResult()` unchanged by it (A9). `trayStatusIpc.test.ts`: A and B each `tray:setStatus` → both stored (`traySnapshotCount() === 2`); `applyTraySnapshot` called with the displayed connection's snapshot only; `setTrayOwner(refA)` then B's update → stored, not applied; `dropTraySnapshot(A)` → count 1. `tray.test.ts`: `tray:action 'leave-voice'` delivered via `sendToConnection(trayOwner() ?? foreground())`. `permissionManager.test.ts`: `permission:changed` sent to the requester and, when `holderRef()` differs, to the holder; never to a third connection; `permission:request` and `permission:openSettings` from a **background holder** stay refused (R14 pin — not widened). `main.test.ts`: `initCaptureLease` runs after `createShellWindow` and before the first `openConnectionView`; `before-quit` and `will-quit` each call `shutdownCaptureLeaseForQuit()` (pin alongside the existing `destroyPipWindowsForQuit` pins); the lease's generation listener runs `dropTraySnapshot(id)` for the advanced connection.
- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/unit/main` → FAIL on the new rows.
- [ ] **Step 4: Implement** `capturePolicy.ts`, the additive `ArbiterContext`, both handler gates, the tray snapshot map and routing, holder delivery, `audiocapCaptureActive`, and the `main.ts` wiring (`initCaptureLease({ …, crashAndReload: (r) => { r.webContents.forcefullyCrashRenderer(); r.webContents.reload(); }, runCeremony: (from, to, signal) => shellWindow() ? runCaptureCeremony(shellWindow(), getService(…from), getService(…to), signal) : Promise.resolve('stay'), tryAcquireModal: () => tryAcquireModal('capture'), consumeCeremonyToken: consumeCaptureCeremonyToken, … })`). Set `CAPTURE_CHECK_POLICY` from Task 0.
- [ ] **Step 5: Run to verify pass** — `npx vitest run tests/unit/main` PASS (including every #86 suite); `npm run build:main` clean; `npm run lint` clean.
- [ ] **Step 6: Docs** — native-audio.md: `audiocap:start` requires the capture lease; the handoff kill is `killAudiocapCapture` (probe spared). electron.md § Sender-frame validation: rows for `capture:acquire`, `capture:release`, `media:getDesktopSources` (holder), `audiocap:start` (holder), `tray:setStatus` (stored per connection, displayed for the tray owner); forced-end rule: a non-acking holder is ended with `forcefullyCrashRenderer()` + `reload()`, never a bare `reload()` (the `beforeunload` veto precedent at `PipWindow.tsx:102-115`).
- [ ] **Step 7: Commit**

```bash
git add desktop/src/main desktop/tests/unit/main .claude/rules/domains/native-audio.md .claude/rules/domains/electron.md
git commit -m "feat: gate media permissions, desktop sources, audiocap and tray on the capture lease"
```

---

### Task 6: IPC contract v35 — registry rows, preload `electron.capture.*`, history, `mainResourceCounts()`

**Files:**
- Create: `desktop/src/main/mainResourceCounts.ts`
- Modify: `desktop/src/main/ipcContract.ts:328` (`IPC_CONTRACT_VERSION = 35`; v35 history entry after the v34 entry; `export type { CaptureIntent, CaptureAcquireResult, CaptureLeaseState, CaptureLeaseRevoked } from '../shared/captureLease'`), `desktop/src/main/ipc/channelClassification.ts` (+`capture:acquire`, `capture:release` → `connection-bound`), `desktop/src/main/main.ts` (register both handlers through `registerIpc`), `desktop/src/preload/preload.ts` (bridge `capture` namespace beside `onTrayAction` at `:456`; Window type at the `onTrayAction` declaration `:940`)
- Modify: `.claude/rules/domains/electron.md` (new "### IPC contract v35 — capture lease (#87)" after the v34 section; § Accepted risk paragraph)
- Test: `desktop/tests/unit/main/preloadCaptureBridge.test.ts` (new; pattern of `preloadTrayBridge.test.ts`), `desktop/tests/unit/main/ipcContract.test.ts:21` (34 → 35), `desktop/tests/unit/main/mainResourceCounts.test.ts`, `desktop/tests/unit/main/ipc/channelClassification.test.ts` (snapshot gains two rows), `desktop/tests/unit/main/captureIpc.test.ts` (new; handler admission)

**Interfaces:**
- Consumes: Task 1 constants + guards; Task 2 `acquire`, `release`, `captureLeaseCounts`; Task 4 `traySnapshotCount`, `audiocapCaptureActive`; Task 5 `loopbackCount`; #86 `registerIpc`, `CHANNEL_CLASSES`, `MAX_LIVE_CONNECTIONS`.
- Produces:

```ts
// preload — electron.capture
acquire(input: CaptureAcquireInput): Promise<CaptureAcquireResult>;   // ipcRenderer.invoke('capture:acquire', input)
release(input: CaptureAcquireInput): Promise<boolean>;
onLeaseChanged(cb: (s: CaptureLeaseState) => void): () => void;      // validated-then-copied; REPLAYS the last validated push synchronously on subscribe (Review Focus 1)
onLeaseRevoked(cb: (r: CaptureLeaseRevoked) => void): () => void;    // validated-then-copied; no replay
// mainResourceCounts.ts
export interface MainResourceCounts { captureHolder: 0 | 1; handoffPending: 0 | 1; loopbacks: number; traySnapshots: number; audiocapCapture: 0 | 1 }
export function mainResourceCounts(): MainResourceCounts;   // every field ≤ MAX_LIVE_CONNECTIONS; read-only
```

- [ ] **Step 1: Write the failing tests**: `preloadCaptureBridge.test.ts` — `onLeaseChanged` drops `{ held: 'yes', mine: false }` and `{ held: true }`; delivers a copy (mutating the delivered object does not affect a second subscriber); a push received **before** subscription is replayed once to the first subscriber and to every later subscriber until superseded; `onLeaseRevoked` drops `{ reason: 'moved', extra: 1 }`; both unsubscribe functions remove the `ipcRenderer` listener; `acquire` forwards `{ intent }` to `invoke('capture:acquire')`. `captureIpc.test.ts` — `capture:acquire` from an unbound sender → `{ status: 'rejected', reason: 'untrusted-sender' }` (the `registerIpc` refusal); from a PiP → refused; `capture:release` from unbound → `false`. `ipcContract.test.ts` → `toBe(35)`, `toBe(19)` kept. `mainResourceCounts.test.ts` — baseline all zero; after one acquire `captureHolder === 1`; after release back to baseline.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/preloadCaptureBridge.test.ts tests/unit/main/captureIpc.test.ts tests/unit/main/ipcContract.test.ts tests/unit/main/mainResourceCounts.test.ts tests/unit/main/ipc/channelClassification.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the v35 history entry states: two invokes, two pushes, lease-gated semantics on `media:getDesktopSources`, `audiocap:start`, `tray:setStatus`, `tray:action` routing, `permission:changed` delivery, `sso:startLoopback` supersede, `sso:awaitCallback`/`sso:cancelLoopback` port cross-check; "The SERVER's spaIpcContract stays 19: the renderer feature-detects `typeof globalThis.electron?.capture?.acquire === 'function'`; a shell below 35 keeps today's behaviour. Capability, not demand."
- [ ] **Step 4: Run to verify pass** → PASS; `npx vitest run tests/integration/preload-sandbox-contract.test.ts` PASS; `npx vitest run tests/unit/main` PASS; `npm run build:main` clean.
- [ ] **Step 5: Docs** — electron.md: "### IPC contract v35 — capture lease (#87)" with the §3.9 table, the lease rules (exclusive; fresh acquire foreground-only; holder re-acquire anywhere; claims set; ack-or-crash; legacy gate and the T0 branch taken), and § Accepted risk: a compromised **foreground** renderer may acquire a **free** lease (explicitly or via the legacy gate) — same class as #86's foreground `app-global-mutate`.
- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/ipcContract.ts desktop/src/main/ipc desktop/src/main/main.ts desktop/src/main/mainResourceCounts.ts desktop/src/preload/preload.ts desktop/tests/unit/main .claude/rules/domains/electron.md
git commit -m "feat: add capture lease IPC channels and preload bridge for contract v35"
```

---

### Task 7A: Renderer lease semantics — client, `joinChannel`, release classification, revocation, store fields

**Files:**
- Create: `desktop/src/renderer/services/voice/captureLeaseClient.ts`, `desktop/src/renderer/services/voice/captureRevocation.ts`
- Modify: `desktop/src/renderer/services/voice/voiceService.ts:4075-4180` (`joinChannel`: acquire as the first await after `this.joinInFlight = true` at `:4100`, inside the existing try), `:4481-4500` (`leaveChannel` release after `cleanup()` when not `internalRebuild`), `:4530` (`emergencyCleanup(opts?: { keepCaptureLease?: boolean })`, release at the end unless kept), `:12257` (auth replaced — inherits release), `desktop/src/renderer/hooks/voice/useConnectionRecovery.ts:127` (`emergencyCleanup({ keepCaptureLease: true })`; the ticket-retraction path that abandons the rejoin releases), `desktop/src/renderer/stores/voice/voiceStore.ts` (state `:336` region, `initialState` `:634` region, actions `:775` region, `reset()` preserve list `:1196-1207`), `desktop/src/renderer/services/system/resetService.ts:154-157` (clear both preserved fields after `reset()`), `desktop/src/renderer/App.tsx` (install `captureRevocation` once at boot beside the existing service installs)
- Modify: `.claude/rules/domains/frontend.md` (Voice rules), `.claude/rules/domains/e2ee.md` § Media frame crypto, `desktop/docs/STATE_MANAGEMENT.md` (`voiceStore` fields + preserve semantics; store count unchanged)
- Test: `desktop/tests/unit/services/voice/captureLeaseClient.test.ts`, `desktop/tests/unit/services/voice/captureRevocation.test.ts`, `desktop/tests/unit/services/voiceService.captureLease.test.ts`, `desktop/tests/unit/services/voiceService.captureLeaseRelease.test.ts`, `desktop/tests/unit/hooks/useConnectionRecovery.captureLease.test.ts`, `desktop/tests/unit/stores/voiceStore.captureLease.test.ts`, `desktop/tests/unit/services/resetService.test.ts` (extend or create)

**Interfaces:**
- Consumes: Task 6 bridge `globalThis.electron?.capture`; Task 1 types; `advanceVoiceActionGeneration()` (`services/voice/voiceActionGeneration.ts`), `useConnectionStore.getState().setPendingVoiceRejoin(null)`, `voiceService.emergencyCleanup`, `teardownSharedE2EEState` (inside `emergencyCleanup`), `gracefulReset()`.
- Produces:

```ts
// captureLeaseClient.ts
export type CaptureLeaseView = 'none' | 'mine' | 'other';
export type CaptureFailureReason = CaptureRejectReason | 'held' | 'ipc-error';
export class CaptureLeaseError extends Error { readonly reason: CaptureFailureReason }
export function captureLeaseMessage(reason: CaptureFailureReason | 'unknown'): string;   // §3.8 copy table verbatim; 'held' is never shown for voice-join (held only answers device-test)
export function acquire(intent: CaptureIntent): Promise<CaptureAcquireResult | { status: 'rejected'; reason: 'ipc-error' }>;   // bridge absent → { status: 'granted' }; invoke throws → ipc-error
export function release(intent: CaptureIntent): Promise<boolean>;   // bridge absent → false, no-op
export function isAcquirePending(): boolean;  export function subscribeAcquirePending(cb: () => void): () => void;   // true while any acquire('voice-join') is unsettled (useSyncExternalStore source for controls + announcer)
export function leaseViewOf(s: CaptureLeaseState): CaptureLeaseView;   // mine → 'mine'; held && !mine → 'other'; else 'none'
export function subscribeLeaseState(cb: (v: CaptureLeaseView) => void): () => void;   // wraps onLeaseChanged
export function subscribeLeaseRevoked(cb: (r: CaptureLeaseRevoked) => void): () => void;
export const captureRevokedEvents: EventTarget;   // dispatches CustomEvent<'moved' | 'backgrounded'>('capture-revoked') for the device-test hooks
// captureRevocation.ts
export function installCaptureRevocationHandler(): () => void;
   // moved: setCaptureMovedNotice(true) FIRST → advanceVoiceActionGeneration() → setPendingVoiceRejoin(null) → voiceService.emergencyCleanup() → dispatch 'capture-revoked' → release('voice-join'), release('device-test') → setCaptureLease('none')
   // backgrounded: dispatch 'capture-revoked' → release('device-test') → setCaptureLease('none')
// voiceService.ts
emergencyCleanup(opts?: { keepCaptureLease?: boolean }): void;   // default releases 'voice-join' at the end
// voiceStore.ts
captureLease: CaptureLeaseView /* 'none' */; captureMovedNotice: boolean /* false */; captureDeclinedSeq: number /* 0 */;
setCaptureLease(v: CaptureLeaseView): void; setCaptureMovedNotice(v: boolean): void; bumpCaptureDeclined(): void;
```

Release classification for claim `voice-join` (§3.8 table, one test per site): **release** — `leaveChannel` without `internalRebuild` (`:4481`), `emergencyCleanup` default and therefore `:4744` (resume with no context), `:4831` (network-change resume failed while owner), `:10056` (`io server disconnect`), `:10086` (`reconnect_failed` without a reconnecting call), `:10099` (placement recovery failed), `:10933` (encrypt re-base failed closed), `:12257` (auth replaced; idempotent, main already cleared on credential reasons); **keep** — `useConnectionRecovery.ts:127` (`{ keepCaptureLease: true }`; the holder re-acquire path survives a background outage); **nothing to send** — `:12271` `beforeunload` (default release is harmless; the document's generation advance releases in main).

- [ ] **Step 1: Write the failing client + store tests**: `captureLeaseClient.test.ts` — bridge absent → `acquire` resolves `granted`, `release` resolves `false`; bridge throwing → `{ rejected: 'ipc-error' }`; `isAcquirePending()` true between call and settle, false after, subscribers notified twice; `leaseViewOf` three rows; `captureLeaseMessage` returns the exact §3.8 string for `busy`, `not-foreground`, `unavailable`, `superseded`, `untrusted-sender`, `ipc-error`, `unknown`. `voiceStore.captureLease.test.ts` — initial values; `reset()` preserves `captureLease: 'other'` and `captureMovedNotice: true`; `reset()` may wipe `captureDeclinedSeq`; `bumpCaptureDeclined` increments. `resetService.test.ts` — `gracefulReset()` leaves `captureLease === 'none'` and `captureMovedNotice === false`.
- [ ] **Step 2: Write the failing `joinChannel` tests** (`voiceService.captureLease.test.ts`, extending the mocking pattern of `voiceService.captureSeam.test.ts`): `acquire('voice-join')` is awaited **before** `authorizeVoiceJoin`, E2EE init and `getUserMedia` (call-order spies); each non-grant calls none of them and leaves `joinInFlight === false` afterwards; `declined` → resolves, `setJoinError` not called, `captureDeclinedSeq` incremented; `granted` → `captureMovedNotice` becomes `false`; `busy` / `not-foreground` / `unavailable` / `superseded` / `untrusted-sender` / `ipc-error` → `setJoinError` with `captureLeaseMessage(reason)`; `internalRebuild: true` → acquire still called (holder re-acquire is cheap) and no `advanceVoiceActionGeneration` (existing behaviour).
- [ ] **Step 3: Write the failing release-site tests** (`voiceService.captureLeaseRelease.test.ts`, `it.each` over the sites above by driving each condition: `leaveChannel()` vs `leaveChannel({ internalRebuild: true })` (release vs not); `emergencyCleanup()` → `release('voice-join')` once; `emergencyCleanup({ keepCaptureLease: true })` → not called; `resumeAfterReconnect` with `activeChannelId === null`; network-change resume failure while owner; media socket `disconnect('io server disconnect')`; `reconnect_failed` with state not `'reconnecting'`; placement recovery `.catch`; encrypt re-base final failure; auth `authGeneration` change at `:12257`). `useConnectionRecovery.captureLease.test.ts`: outage with a rejoin ticket → `emergencyCleanup` called with `{ keepCaptureLease: true }`; the ticket-retraction path (`.catch` at `:130` when a ticket was minted but no teardown happened) → no release; an abandoned rejoin (ticket cleared without rejoin) → `release('voice-join')`.
- [ ] **Step 4: Write the failing revocation tests** (`captureRevocation.test.ts`): `moved` → order asserted by a shared call log: `setCaptureMovedNotice(true)` → `advanceVoiceActionGeneration` → `setPendingVoiceRejoin(null)` → `emergencyCleanup` → `'capture-revoked'` dispatched with `detail === 'moved'` → `release('voice-join')` and `release('device-test')` → `setCaptureLease('none')`; no `joinChannel` afterwards (no auto-rejoin); `backgrounded` → no `emergencyCleanup`, `'capture-revoked'` with `detail === 'backgrounded'`, `release('device-test')` only; a `capture:lease` push with `{ held: false, mine: false }` and **no** prior `moved` leaves `captureMovedNotice` false (Review Focus 3).
- [ ] **Step 5: Run to verify failure** — `npx vitest run tests/unit/services/voice/captureLeaseClient.test.ts tests/unit/services/voice/captureRevocation.test.ts tests/unit/services/voiceService.captureLease.test.ts tests/unit/services/voiceService.captureLeaseRelease.test.ts tests/unit/hooks/useConnectionRecovery.captureLease.test.ts tests/unit/stores/voiceStore.captureLease.test.ts tests/unit/services/resetService.test.ts` → FAIL.
- [ ] **Step 6: Implement**; `release` calls in `voiceService` are `void captureLeaseClient.release('voice-join')` (fire-and-forget, never awaited inside cleanup).
- [ ] **Step 7: Run to verify pass** → PASS; `npx vitest run tests/unit/services tests/unit/stores tests/unit/hooks` PASS (every existing `voiceService.*.test.ts` green); `npm run typecheck` clean.
- [ ] **Step 8: Docs** — frontend.md (Voice): join acquires the lease first; `declined` is silent; revocation sets the notice before cleanup and never auto-rejoins; the three `voiceStore` fields and the `reset()` preserve rule; the generic copy table (§3.8, verbatim). e2ee.md § Media frame crypto: the media key context exists only in the lease holder's document and is destroyed (`teardownSharedE2EEState` inside `emergencyCleanup`, or process death) before another document is granted. STATE_MANAGEMENT.md: `voiceStore` fields, preserve semantics, store count unchanged.
- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer/services desktop/src/renderer/hooks/voice/useConnectionRecovery.ts desktop/src/renderer/stores/voice/voiceStore.ts desktop/src/renderer/App.tsx desktop/tests/unit .claude/rules/domains/frontend.md .claude/rules/domains/e2ee.md desktop/docs/STATE_MANAGEMENT.md
git commit -m "feat: acquire the capture lease before voice join and release it on every call-ending path"
```

---

### Task 7B: Renderer surfaces — device-test hooks, join-control hint/pending, banner, announcer, contrast, visual check

**Files:**
- Create: `desktop/src/renderer/components/Voice/CaptureMovedBanner.tsx`, `desktop/src/renderer/components/Voice/CaptureMovedBanner.css`, `desktop/src/renderer/components/Voice/CaptureLeaseAnnouncer.tsx`
- Modify: `desktop/src/renderer/hooks/device/useMicTest.ts:138-145,:430` (acquire before `getUserMedia`; `stoppedReason`), `desktop/src/renderer/hooks/device/useCameraTest.ts:24-50` (same), `desktop/src/renderer/services/voice/mediaCapabilities.ts:290` (`enumerateWebcamCapabilities` acquires `device-test`; non-grant → `[]`, releases after), `desktop/src/renderer/components/Settings/AudioConfigSection.tsx:170-185` (held line + `stoppedReason` row), `desktop/src/renderer/components/Settings/VideoConfigSection.tsx` (camera test row), join controls: `desktop/src/renderer/components/Voice/VoiceView.tsx`, `desktop/src/renderer/components/DirectMessages/DMChatArea.tsx`, plus every other `joinChannel(` caller found by `grep -rn "joinChannel(" desktop/src/renderer/components desktop/src/renderer/hooks`, `desktop/src/renderer/App.tsx:679` (`{!isPipWindow && <CaptureMovedBanner />}` directly after `<UpdateBanner />`; `<CaptureLeaseAnnouncer />` beside it), **T0 row 1 FAIL branch only:** `desktop/src/renderer/components/Voice/DeviceSelector.tsx:50` (acquire `device-test` before `enumerateDevices`)
- Modify: `.claude/rules/domains/frontend.md` (banner placement after `UpdateBanner`; `aria-disabled` pending pattern; "connection" terminology note), `docs/self-hosted-client.md` ("Voice and capture across connections"; terminology note for #88)
- Test: `desktop/tests/unit/hooks/useMicTest.captureLease.test.ts`, `desktop/tests/unit/hooks/useCameraTest.test.ts` (extend), `desktop/tests/unit/services/voice/mediaCapabilities.captureLease.test.ts`, `desktop/tests/unit/components/Settings/AudioConfigSection.captureLease.test.tsx`, `desktop/tests/unit/components/Voice/JoinControl.captureLease.test.tsx` (one `describe` per control), `desktop/tests/unit/components/Voice/CaptureMovedBanner.test.tsx`, `desktop/tests/unit/components/Voice/CaptureLeaseAnnouncer.test.tsx`, `desktop/tests/unit/styles/contrast-pairs.test.ts` (extend), `desktop/tests/unit/renderer/App.layout.test.tsx` (extend: banner order)

**Interfaces:**
- Consumes: Task 7A `acquire`, `release`, `isAcquirePending`, `subscribeAcquirePending`, `captureRevokedEvents`, store fields; Task 0 `BANNER_VISIBILITY_SIGNAL`; `.voice-join-error-notice__dismiss` (`VoiceJoinErrorNotice.css:49-70`) as the Dismiss button pattern; #3394 live-region pattern (`MediaPolicyNotice.tsx`).
- Produces:

```ts
// useMicTest.ts / useCameraTest.ts — additive
stoppedReason: 'held' | 'backgrounded' | null;   // set by acquire → 'held' or by 'capture-revoked' (backgrounded); cleared on next Start and on unmount
// copy (exact, §3.8)
export const CAPTURE_HINT = "Your microphone is in a call on another connection. Joining here will ask before ending that call.";
export const DEVICE_TEST_HELD = "Your microphone is in a call on another connection. Leave that call to test it here.";
export const DEVICE_TEST_BACKGROUNDED = "Your test stopped when you switched to another connection. Start it again to keep testing.";
export const JOIN_PENDING_SR = "Joining voice…";  export const JOIN_DECLINED_SR = "Staying on your current call.";
export const CAPTURE_MOVED_BANNER = "Your call ended because your microphone moved to another connection.";  // button "Dismiss"
// CaptureMovedBanner.tsx: reads captureMovedNotice; role="status"; text set only once visible (Task 0 signal); Dismiss → setCaptureMovedNotice(false) + focus rule
// CaptureLeaseAnnouncer.tsx: mounts a visually hidden polite region when captureDeclinedSeq or isAcquirePending changes; text one rAF later; module-level lastAnnouncedSeq
```

CSS (`CaptureMovedBanner.css`, exact values §3.8): wrapper `background: var(--bg-secondary); color: var(--text-primary); border-bottom: 1px solid var(--border-color); padding: calc(8px * var(--sp,1)) calc(12px * var(--sp,1)); gap: 8px; font-size: calc(13px * var(--font-scale, 1)); line-height: 1.4; overflow-wrap: anywhere;` Dismiss min 24×24 px, wraps to its own right-aligned line below 480 px; keyframe `capture-moved-banner-enter` 150 ms ease-out opacity + `translateY(-4px)`; `@media (prefers-reduced-motion: reduce)` (opacity only) **last** in the file; no exit animation. Device-test row: `role="status"`, `background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px`. Focus ring `outline: 2px solid var(--state-focused); outline-offset: 2px`.

- [ ] **Step 1: Write the failing hook + probe tests**: `useMicTest.captureLease.test.ts` — `startTest` calls `acquire('device-test')` before `getUserMedia`; `held` → `getUserMedia` not called, `stoppedReason === 'held'`, `isTesting` false; `granted` → test runs, `stopTest` → `release('device-test')`; a `'capture-revoked'` event with `detail: 'backgrounded'` while testing → tracks stopped, `stoppedReason === 'backgrounded'`, `release` called; next `startTest` clears `stoppedReason`. Same rows for `useCameraTest`. `mediaCapabilities.captureLease.test.ts` — `enumerateWebcamCapabilities` acquires first; `held` → `[]` and no `getUserMedia`; `granted` → probes then releases.
- [ ] **Step 2: Write the failing component tests**: `AudioConfigSection.captureLease.test.tsx` — with `captureLease: 'other'` the held line is visible before any click and Test is **not** natively disabled; `stoppedReason: 'backgrounded'` shows `DEVICE_TEST_BACKGROUNDED` in a `role="status"` row. `JoinControl.captureLease.test.tsx` (per control) — `aria-describedby` points at a node with `CAPTURE_HINT` only when `'other'`; `title` attribute absent; while pending: `aria-busy="true"`, `aria-disabled="true"`, no `disabled` attribute, a second click/Enter does not call `joinChannel` again (Review Focus 4), `document.activeElement` is still the control after the promise settles as `declined`. `CaptureMovedBanner.test.tsx` — renders nothing when the flag is false; text empty until the visibility signal (stub `document.visibilityState` or dispatch the `capture:lease` push per Task 0), then `CAPTURE_MOVED_BANNER`; Dismiss clears the flag and moves focus to the next tabbable after the banner; with no tabbable, to `.app[tabindex="-1"]`; never `document.body`. `CaptureLeaseAnnouncer.test.tsx` — region absent until `bumpCaptureDeclined()`; text `JOIN_DECLINED_SR` after one rAF; a second bump with the same seq is not re-announced; pending → `JOIN_PENDING_SR`; not a descendant of `MediaPolicyNotice`'s region. `App.layout.test.tsx` — `CaptureMovedBanner` is the next sibling of `UpdateBanner` and absent when `isPipWindow`.
- [ ] **Step 3: Write the failing contrast rows** in `contrast-pairs.test.ts`: the banner wrapper pair (`--text-primary` on `--bg-secondary`) and the device-test row pair (`--text-primary` on `--bg-tertiary`) are discovered by the existing pair scan (assert the selectors appear in the collected pairs); add `--state-focused` vs `--bg-secondary` and vs `--bg-tertiary` as explicit non-text pairs at ≥ 3:1 across all 15 schemes × dark/light and the `data-high-contrast` block.
- [ ] **Step 4: Run to verify failure** — `npx vitest run tests/unit/hooks tests/unit/components/Settings tests/unit/components/Voice tests/unit/styles tests/unit/renderer/App.layout.test.tsx tests/unit/services/voice/mediaCapabilities.captureLease.test.ts` → FAIL.
- [ ] **Step 5: Implement**. If a `--state-focused` pair fails a scheme, add a per-scheme ring override in the component CSS (no new token). **T0 row 1 FAIL branch:** also make `DeviceSelector.tsx:50` acquire `device-test` before `enumerateDevices` and release after.
- [ ] **Step 6: Run to verify pass** → PASS; `npx vitest run tests/unit` PASS (incl. `VoiceAudioSection.test.tsx`); `npm run lint && npm run typecheck` clean.
- [ ] **Step 7: Visual verification (A10)** — `npm run dev` with `saas` + one local self-hosted connection (#86 dev Menu). For `settingsStore.theme` ∈ **dark, light, system** (system: capture in whichever it resolves to and note the OS setting), capture: pending join control; the hint node shown in the a11y inspector; both device-test rows; banner at rest, hover, focus; each error string including the longest wrapped; then a scripted pass over all 15 colour schemes × dark/light + `data-high-contrast` + one 200 % zoom pass using the `tests/e2e/visual-regression.spec.ts` harness pattern (renderer-only, screenshots not baselines). The native ceremony captured on macOS including keyboard reach to Join (Full Keyboard Access or VoiceOver). Save to `/private/tmp/claude-501/-Users-markd--claude-spares-spare-kf1ERt/fc2240ee-4ea7-4102-ad6a-1a3c11301f6e/scratchpad/visual/87/<theme>-<surface>.png`; Windows/Linux: NOT CAPTURED, reason stated in the PR body.
- [ ] **Step 8: Docs** — frontend.md: banner placement directly after `UpdateBanner` (`{!isPipWindow && …}`), `aria-disabled` + `aria-busy` pending pattern, hint via `aria-describedby`, terminology "connection" until #88. `docs/self-hosted-client.md`: "Voice and capture across connections" (one voice session at a time; the join prompt and its two outcomes; the other connection sees you leave; the dialog is OS-styled; terminology note for #88).
- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer desktop/tests/unit .claude/rules/domains/frontend.md docs/self-hosted-client.md
git commit -m "feat: add capture lease hint, device-test rows, moved banner and announcer"
```

---

### Task 8: e2e `captureArbitration.spec.ts`, ADR-0052, release gate, remaining docs, final verification

**Files:**
- Create: `desktop/tests/e2e/captureArbitration.spec.ts`, `docs/adr/0052-exclusive-capture-lease.md`
- Modify: `desktop/tests/e2e/electronFixture.ts` (#86 T10; add `legacyCaptureView`, `vetoUnload(view)`, `injectCeremony(response)`, `leaseCounts()` helpers), `desktop/playwright.electron.config.ts` (`testMatch` gains `captureArbitration\.spec\.ts`), `desktop/tests/README.md:111` (13 → 14 e2e specs; the no-fake-UI rule), the `v1.0.0` release-classification checklist (locate with `grep -rln "classify-release\|release-classification" docs .github`; if none exists in Desktop, record the gate in the ADR and PR body and file a Release-Ops follow-up)
- Reference: `docs/adr/0043-per-process-screen-share-audio-capture.md` (format), Task 0 results

**Interfaces:**
- Consumes: everything above; #86 fixture `test.extend<{ app; userData; planes: { a; b } }>()`, `startStubPlane`; Task 3 `_setShowMessageBoxForTesting` reached through `app.evaluate(({ }, p) => require(p)._setShowMessageBoxForTesting(async () => ({ response: p.response })), { path, response })` (Node's require cache returns the live singleton in the built main); Task 6 `mainResourceCounts()` via `app.evaluate`.
- Produces: fixture helpers — `injectCeremony(response: 0 | 1): Promise<void>`; `vetoUnload(view): Promise<void>` (`page.evaluate` installs a `beforeunload` veto); `legacyCaptureView(serviceId)` (the #86 T10 legacy-SPA mechanism with the `capture` bridge namespace removed — this is also the **hostile holder**: a legacy document never acks); `trackStates(view): Promise<('live' | 'ended')[]>`; `leaseCounts(): Promise<MainResourceCounts>`.

- [ ] **Step 1: Extend the fixture** — assert at start that `process.argv` of the launched app contains `--use-fake-device-for-media-stream` and **not** `--use-fake-ui-for-media-stream`; add the helpers above.
- [ ] **Step 2: Write the failing spec** — one `test` per §7 e2e row:
  - `B getUserMedia while A holds rejects NotAllowedError`.
  - `injected Join: A acks or is gone before B is granted; B tracks live after; A banner flag set` (poll `leaseCounts()` and A's `voiceStore.captureMovedNotice` via `page.evaluate`; assert the main-side event order through a `capture:lease` log captured by `app.evaluate` listeners).
  - `injected Stay: A unaffected; B control idle` (A tracks still `live`; B's control has no `aria-busy`).
  - `hostile holder (legacy view + beforeunload veto) is crashed and reloaded at 5 s, then B granted` (`render-process-gone` with `reason: 'killed'` observed; B `granted` after).
  - `A reload releases the lease` (`leaseCounts().captureHolder === 0` after `reload`).
  - `three services: at most one document has live tracks at any sampled instant; audiocapCapture only in the holder` (sample every 250 ms across a Join handoff).
  - `50x loopback start/cancel churn on B leaves A untouched and counts return to baseline`.
  - `legacy view captures when free and foreground; refused when background`.
- [ ] **Step 3: Run to verify failure, then pass** — `cd desktop && npm run build && npm run test:e2e:electron` → PASS on macOS arm64 (first run FAILs until the fixture helpers are wired). Record the output path in the PR body.
- [ ] **Step 4: Write ADR-0052** in the ADR-0043 format: first line `> ADR number provisional — re-grep docs/adr across all org checkouts before merge.`; title `ADR-0052: Exclusive capture lease and owner-bound main resources`; `**Status:** Proposed`; Deciders: Mark; Issue Desktop#87 (child of Self-Hosted#59); Spec path; Related: #86 (ADR-0051), #88, #90, ADR-0043, ADR-0035. Sections: Context (§1), Decision (D1, D2, D3, D5–D8, Option C), Options rejected (dossier A general arbiter; Option B renderer-themed dialog with its §4 cost), Reconciliation (R1–R16, Q1–Q4, F1–F14 by number, one line each), T0 results (the macOS table verbatim; Windows/Linux `NOT MEASURED` with reason; the §5.2 branch taken and `CAPTURE_CHECK_POLICY`; the banner signal), Accepted risks (free-lease acquire by a compromised foreground renderer; unthemed native dialog; F13 crash path loses the banner for legacy/hostile holders; crash-reporter noise `reason=killed`), Release gate (R16: no tag ships #86 without #87), Consequences, Verification (unit + e2e file names).
- [ ] **Step 5: Docs** — `desktop/tests/README.md:111` → 14 e2e specs; add the no-fake-UI rule under the Electron e2e paragraph. Release checklist: add "No release tag contains #86 (ADR-0051) without #87 (ADR-0052)". Re-check every §8 row landed: ADR (here), self-hosted-client.md (T5, T7B), electron.md (T3, T4, T6), frontend.md (T7A, T7B), e2ee.md (T7A), native-audio.md (T4), tests/README.md (here), STATE_MANAGEMENT.md (T7A), ipcContract.ts history (T6). Generated rule mirrors: none in Desktop (state so in the PR body). Run `./scripts/update-claude-md-counts.sh` if present. **T0 row 1 FAIL branch only:** add to `docs/self-hosted-client.md` and the ADR that the lease-aware remote SPA build must deploy **before** shell 35 is released and that the SPA deploy runbook records a rollback floor at that build (§5.2).
- [ ] **Step 6: Full verification** — `npm run lint && npm run typecheck && npm run build:main && npx vitest run --coverage` (new-code coverage ≥ 80 %), `npm run test:e2e:electron`. Mutation spot-check (restore after each): remove the `isHolder` check in `capturePolicy` request branch → `capturePolicy.test.ts` red; remove `killAudiocapCapture` from the handoff → `captureLease.test.ts` red; make `tray:setStatus` apply every snapshot → `trayStatusIpc.test.ts` red; drop the `not-foreground` check → the lease matrix red. `git diff --stat origin/feature/86-isolate-connection-contexts -- desktop/package-lock.json desktop/src/renderer/services/voice/mediaEncryption.ts desktop/src/main/guardedRequest.ts` → empty (A5, A8). Re-grep `docs/adr` across every org checkout for `0052`.
- [ ] **Step 7: Commit**

```bash
git add desktop/tests/e2e desktop/playwright.electron.config.ts desktop/tests/README.md docs/adr/0052-exclusive-capture-lease.md
git commit -m "test: add capture arbitration e2e spec and ADR-0052"
```

---

## Acceptance criteria (spec §9; verified before the PR is marked ready)

| # | Criterion | Where proven |
|---|---|---|
| A1 | No loopback collision; at most one ephemeral loopback per connection | Task 5 units; Task 8 churn |
| A2 | Concurrent SSO ceremonies cannot overwrite/replay/consume each other | Task 5 (port cross-check, identity-guarded deletes, filtered teardown) |
| A3 | Hostile service cannot start capture (incl. background), steal a session, or receive another's media/keys | Task 2 matrix; Task 4 arbiter table; Task 8 `NotAllowedError` + three-service |
| A4 | Churn stays bounded; other connections preserved | Task 6 `mainResourceCounts`; Task 8 churn baseline |
| A5 | Structural E2EE, TLS, TURN unchanged | Task 8 Step 6 empty diffs; e2ee suites green |
| A6 | Consent precedes any move; Stay default and silent; previous holder's capture ends before the grant | Task 3 options test; Task 2 handoff ordering; Task 8 Join/veto tests |
| A7 | Contract 35 / SPA floor 19; legacy SPA and legacy shell work | Task 6 `ipcContract.test.ts`; Task 7A bridge-absent rows; Task 8 legacy view |
| A8 | No new dependency; sandbox pins; registry classification complete | Task 8 empty lockfile diff; `preload-sandbox-contract`; Task 6 snapshot |
| A9 | ADR-0043 preserved: handoff never reaps the probe | Task 4 `audiocapProbeResult` unchanged test |
| A10 | Accessible surfaces; visual verification in all 30 combinations + high contrast + 200 %; native dialog captured per platform (macOS; others NOT CAPTURED) | Task 7B tests + Step 7 captures |
| A11 | Docs to update — every §8 row in the PR | Tasks 3, 4, 5, 6, 7A, 7B, 8 doc steps |
| A12 | Quality gate: 0 new blocker/critical, 0 new high-confidence hotspots, ≥ 80 % new-code coverage | SonarCloud PR decoration (`Hosted/docs/ci/quality-gate-definition.md`; Desktop has no local copy) |

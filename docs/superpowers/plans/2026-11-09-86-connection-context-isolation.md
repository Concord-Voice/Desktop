# Connection Context Isolation (Desktop #86) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CVNet (`saas`) and any number of self-hosted services run concurrently in one shell, each in its own sandboxed renderer document on its own Chromium `Session` with its own credential custody, so that no renderer, payload or service response can select another connection's origin, cookies, keys or privileged IPC authority.

**Architecture:** One `BaseWindow`; one `WebContentsView` per live connection; `saas` stays on `session.defaultSession`, each self-hosted service on `session.fromPath(<userData>/profiles/<sha256(origin)>/session)`. The main process is the trusted shell and the only authority: every IPC handler resolves its connection from a `WeakMap<WebContents, binding>` (never from a payload or URL), goes through `registerIpc(channel, class, handler)`, and reaches credential state only through that connection's `ProfileCustody` instance produced by `createProfileCustody(serviceId, apiOrigin)`. A per-connection monotonic `Generation` revokes every main-held `OwnerBinding` on document change, renderer loss, credential start/end and dispose.

**Tech Stack:** Electron 45.0.0 (`BaseWindow`, `WebContentsView`, `session.fromPath`, `MessageChannelMain` reserved for #89), TypeScript, Vitest ^5.0.3 (unit), Playwright ^1.64.1 `_electron` (e2e), ESLint flat config (`desktop/eslint.config.mjs`), Zustand ^5.0.16 (untouched — one document per connection).

**Spec:** `docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md` — read it first; this plan argues from it. Section references below (§n) are to the spec.

## Global Constraints

- `IPC_CONTRACT_VERSION` goes **33 → 34** (`desktop/src/main/ipcContract.ts:328`); `SPA_MIN_CONTRACT` **stays 19** (`:361`). Nothing else bumps either number.
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` on **every** webContents (connection views, PiP, dev). Never gate on `app.isPackaged`.
- `desktop/src/preload/preload.ts` and everything it imports from `desktop/src/shared/` import only `electron` and pure TS — `tests/integration/preload-sandbox-contract.test.ts` must stay green.
- `import './pinUserDataPath'` stays line 3 of `desktop/src/main/main.ts`; every new file (sessions, `connections.json`, prefs) lives beneath `app.getPath('userData')`.
- No TLS change of any kind: `setCertificateVerifyProc`, `verifyLinuxSignature.ts`, `verifyWindowsSignature.ts`, `guardedRequest.ts` untouched. `tokenManager` refresh/logout stay on `net.fetch` with `credentials: 'omit'`.
- `saas` runs on `session.defaultSession`; root custody files (`secure-token.dat`, `token-meta.json`, `secure-e2ee.dat`, `machine-id.json`, `active-profile.json`) are **never renamed, copied or deleted**. `self-hosted-approvals.json` v1 unchanged; only `commitSelfHostedApproval` mints origin trust.
- Composite keys are always `${serviceId}\0${localId}`; `ConnectionId` is 128-bit random base64url, minted in main, never persisted; `Generation` is a safe integer ≥ 1, strictly monotonic per connection.
- Generation bumps **only** on: main-frame `did-start-navigation`, `render-process-gone`/`destroyed`, custody `credential-start`, `credential-end`, dispose. Not on refresh rotation, not on outage/reconnect.
- Exported names are fixed by the spec and consumed by #87 — use them exactly: `ConnectionRef`, `bindOwner`, `isOwnerCurrent`, `requireOwner`, `onGenerationAdvanced`, `createProfileCustody`, `registerIpc`, `captureArbiter`/`setCaptureArbiter`, `trayOwner`/`setTrayOwner`, channels `connection:{whoAmI,generation,create,activate,preferenceScope}`.
- Commits: Conventional Commits with a **bare type** (`feat:`, `test:`, `docs:`, `refactor:`, `chore:`) — the commit-msg hook rejects `type(scope):`. At least one commit per task. Never stage `.claude/state/`.
- Docs ship with the code that changed them (§7 rows are inside the task that changes the behaviour). Desktop has no generated mirror of `.claude/rules/domains/*`; if one exists at execution time, re-sync it in the same commit, otherwise say "no mirror in Desktop" in the PR body.
- Test commands run from `desktop/`: `npx vitest run <path>`; `npm run lint`; `npm run typecheck`; `npm run build:main` (tsc for `src/main` — vitest alone does not typecheck main). ADR number 0051 is **provisional**: re-grep `docs/adr` across every org checkout immediately before merge (highest in use on 2026-11-09: 0050).
- T0 runs only on the executor's machine (macOS arm64). Windows x64 and Linux x64 rows are recorded as **NOT MEASURED** with the reason. The ADR must not claim a measurement that was not taken.

## Review Focus

Input classes the spec implies but no spec'd test exercises; each has a test added to the owning task below.

1. **Window resize / maximize / full-screen with several child views** — the foreground view must fill the content bounds after every geometry change and hidden views must not paint over it. (Test added to Task 4.)
2. **`connections.json` names a service whose `profiles/<dirKey>/session` directory cannot be created** (read-only or synced folder) — the shell must still open `saas`, drop that entry with a warning, and not crash before first paint. (Task 4.)
3. **Sleep/resume with two authenticated connections** — `powerMonitor 'resume'` must call `onSystemResume()` on **every** live custody instance, or B's token silently stops refreshing after a lid close. (Task 7B.)
4. **A deep link arrives while no `saas` connection is live** (user only has a self-hosted service open) — it must be queued through the v25 carry and delivered to the `saas` primary when it opens, never to a self-hosted view. (Task 7B.)
5. **Closing the `BaseWindow` while a self-hosted connection is live** — every child `webContents` must be closed explicitly on `closed`; a child view that outlives its window is an orphan renderer with a live websocket. (Task 4.)

---

## File Structure

New main-process files, one responsibility each:

| File | Responsibility |
|---|---|
| `desktop/src/shared/connectionIdentity.ts` | Branded identity types, guards, codecs, `compositeKey` (pure; imported by preload and renderer) |
| `desktop/src/main/connectionRegistry.ts` | In-memory services/connections/bindings/foreground; `advanceGeneration`; `onGenerationAdvanced` listener list |
| `desktop/src/main/connectionCapability.ts` | `OwnerBinding` + `bindOwner`/`isOwnerCurrent`/`requireOwner`; re-exports `onGenerationAdvanced` (#87's import surface) |
| `desktop/src/main/ipc/connectionSender.ts` | `requireConnectionSender` + admission helpers + `crossCheckApiBase` |
| `desktop/src/main/connectionSession.ts` | `configureConnectionSession` factory, `sessionForService`, `captureArbiter` hook, navigation gate, per-service KLIPY injector |
| `desktop/src/main/shellWindow.ts` | `BaseWindow` composition, views, `foregroundWebContents`, `sendToConnection`, `broadcastToPrimaries`, dev `Menu` |
| `desktop/src/main/connectionsFile.ts` | `connections.json` v1 codec (read-validate / atomic FIFO write) |
| `desktop/src/main/connectionMigration.ts` | P0 derive + P1 persist |
| `desktop/src/main/ipc/registry.ts` | `registerIpc(channel, class, handler)` + admission per class |
| `desktop/src/main/ipc/channelClassification.ts` | Checked-in `CHANNEL_CLASSES` table |
| `desktop/src/main/ipc/connection.ts` | `connection:*` handlers |
| `desktop/src/main/preferenceOwnership.ts` | `accountKeyFor`, `preferenceScopeFor`, `prefsDirFor` |
| `desktop/src/renderer/services/system/bootConnection.ts` | Reads `electron.connection.whoAmI()` once; legacy / connection / unavailable |
| `desktop/src/renderer/components/Auth/ConnectionUnavailable.tsx` | Fatal "connection unavailable" screen |

Modified: `tokenManager.ts` (closure factory), `main.ts` (composition, handlers, quit path), `ipc/sso.ts`, `ipc/audiocap.ts`, `ipc/trayStatus.ts`, `ipc/windowControls.ts`, `ipc/frameValidation.ts`, `ipcContract.ts`, `preload/preload.ts`, `selfHostedProfile.ts`, `windowState.ts`, `eslint.config.mjs`, `runtimeServerBase.ts`, `AuthFlow.tsx`, `ServerInput.tsx`, docs per §7.

**Sequence:** T0 → T1 → {T2, T3, T5} → T4 → T6 → T7A → T7B → T8 → T9 → T10. (§5's sequence line omits T4; its deps are T0, T2, T3 and T7B consumes `sendToConnection` from it, so it sits between the parallel group and T6/T7.) Task 7 is split into 7A (registry infrastructure + new channels + v34) and 7B (migration of the 77 existing registrations to the registry and binding-derived semantics) because a reviewer can reject the handler-semantics migration while approving the wrapper, and each half carries its own test cycle.

---

### Task 0: Footprint + composition spike (`desktop/spikes/connection-footprint/`, not CI)

**Files:**
- Create: `desktop/spikes/connection-footprint/README.md`, `desktop/spikes/connection-footprint/main.mjs`, `desktop/spikes/connection-footprint/results/macos-arm64.md`, `desktop/spikes/connection-footprint/results/windows-x64.md`, `desktop/spikes/connection-footprint/results/linux-x64.md`
- Reference: `desktop/spikes/s2-windows-loopback/` (precedent for the directory shape)

**Interfaces:**
- Consumes: Electron 45 `BaseWindow`, `WebContentsView`, `session.fromPath`, `app.getAppMetrics()`, `webContents.getOSProcessId()`, `webContents.setBackgroundThrottling`.
- Produces: `results/*.md` tables Task 4 and Task 10 copy into the ADR; the measured value for `MAX_LIVE_CONNECTIONS` (Task 2 default 4 is provisional) and the `backgroundThrottling` decision (§9 item 4).

- [ ] **Step 1: Write `main.mjs`** — plain ESM Electron entry (outside tsc/eslint/vitest globs). It creates a `BaseWindow`, then 0/1/2/3 `WebContentsView`s (view 0 on `defaultSession`, others on `session.fromPath(join(app.getPath('userData'), 'spike', 'profiles', String(i), 'session'))`), each loading `http://localhost:3001` (Vite dev renderer) with the real preload's `webPreferences` from `buildBrowserWindowConfig`. Accepts `--views=N --throttle=true|false --state=cold|login-idle|logged-in-idle --minutes=10`. Every 30 s it matches `app.getAppMetrics()` to each view's `getOSProcessId()` and appends `{ t, pid, type, memory.workingSetSize, cpu.percentCPUUsage }` plus `whenReady→did-finish-load` ms per view to `results/raw-<platform>-<arch>.jsonl`. On exit prints the `du -sk` of each `session/` dir.
- [ ] **Step 2: Write the `README.md`** — how to run (`cd desktop && npm run dev:renderer` in one shell; `npx electron spikes/connection-footprint/main.mjs --views=3 ...` in another), the platform rows list copied from §5 T0 (drag region in child view, `titleBarOverlay` hit-testing Windows/X11, macOS `hiddenInset` traffic lights, Wayland framed chrome, hidden-view timer throttling vs websocket heartbeat, child webContents survival on `BaseWindow` close), and the §9 thresholds (>150 MB working set per idle logged-in connection; >400 ms cold start per added connection; >1% idle CPU per hidden throttled view).
- [ ] **Step 3: Run on macOS arm64** — `--views=0,1,2,3` × `--state=cold|login-idle|logged-in-idle` × `--throttle=true|false` (logged-in-idle for 10 min against a local control plane). Record the per-connection delta table, cold-start delta, `session/` disk, and the hidden-view throttling row (did the websocket heartbeat miss under intensive throttling: yes/no, interval observed) in `results/macos-arm64.md`. Record the macOS platform rows by manual check (`hiddenInset` traffic lights overlap the child view? drag region `-webkit-app-region: drag` works inside a child view? child webContents destroyed on `BaseWindow.close()`?).
- [ ] **Step 4: Write `results/windows-x64.md` and `results/linux-x64.md`** with every row set to `NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09`. Do not fabricate a number. List which ADR claims therefore stay open (overlay hit-testing, Wayland chrome, content protection on Windows).
- [ ] **Step 5: Decide and record** at the bottom of `results/macos-arm64.md`: `MAX_LIVE_CONNECTIONS` (≥3; stays 4 unless the delta at 3 exceeds threshold), `backgroundThrottling` default for hidden views (true unless heartbeat misses were observed), and whether any threshold was exceeded (if yes: STOP, report to the orchestrator — it reopens the within-A fallback per §2 before Task 4).
- [ ] **Step 6: Commit**

```bash
git add desktop/spikes/connection-footprint
git commit -m "chore: add connection footprint spike with macOS arm64 measurements"
```

---

### Task 1: Identity types, guards, codecs (`shared/connectionIdentity.ts`)

**Files:**
- Create: `desktop/src/shared/connectionIdentity.ts`
- Modify: `desktop/src/main/selfHostedProfile.ts:30-34` (add `serviceIdForApiBase`, `dirKeyForApiBase` beside `profileIdForApiBase`)
- Test: `desktop/tests/unit/shared/connectionIdentity.test.ts`, `desktop/tests/unit/main/selfHostedProfile.test.ts` (extend)

**Interfaces:**
- Consumes: `profileIdForApiBase(apiBase): string`, private `hashOrigin`/`originForApiBase` in `selfHostedProfile.ts`.
- Produces (verbatim from §3.1, plus guards):

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ServiceId = Brand<string, 'ServiceId'>; export type ServiceKind = 'saas' | 'selfhost';
export type AccountKey = Brand<string, 'AccountKey'>; export type ConnectionId = Brand<string, 'ConnectionId'>;
export type Generation = Brand<number, 'Generation'>;
export interface AccountId { readonly serviceId: ServiceId; readonly accountKey: AccountKey }
export interface ConnectionRef { readonly connectionId: ConnectionId; readonly generation: Generation }
export interface ConnectionIdentity extends ConnectionRef { readonly serviceId: ServiceId; readonly kind: ServiceKind; readonly apiOrigin: string }
export type GenerationReason = 'document' | 'renderer-gone' | 'credential-start' | 'credential-end' | 'disposed';
export interface PreferenceScope { readonly serviceId: ServiceId; readonly accountKey: AccountKey }
export const SAAS_SERVICE_ID: ServiceId; export const CONNECTION_ID_BYTES = 16;
export function isServiceId(v: unknown): v is ServiceId;      // 'saas' | /^selfhost-[0-9a-f]{16}$/
export function isConnectionId(v: unknown): v is ConnectionId; // base64url, exactly 22 chars, no padding
export function isGeneration(v: unknown): v is Generation;     // Number.isSafeInteger(v) && v >= 1
export function isAccountKey(v: unknown): v is AccountKey;     // /^[0-9a-f]{16}$/
export function serviceKindOf(id: ServiceId): ServiceKind;
export function compositeKey(serviceId: ServiceId, localId: string): string; // `${serviceId}\0${localId}`
export function parseConnectionIdentity(v: unknown): ConnectionIdentity | null; // exact keys only; any extra/missing key → null
// selfHostedProfile.ts
export function serviceIdForApiBase(apiBase: string): ServiceId;  // profileIdForApiBase, branded
export function dirKeyForApiBase(apiBase: string): string;        // full sha256 hex of canonical origin ('' for saas)
```

- [ ] **Step 1: Write the failing tests** in `tests/unit/shared/connectionIdentity.test.ts`:
  - `isServiceId` accepts `'saas'`, `'selfhost-0123456789abcdef'`; rejects `'selfhost-0123456789ABCDEF'`, `'selfhost-0123456789abcde'`, `''`, `42`. <!-- pragma: allowlist secret -->
  - `isConnectionId` accepts a 22-char base64url string; rejects 21/23 chars, `+`, `/`, `=`.
  - `isGeneration` accepts `1`, `Number.MAX_SAFE_INTEGER`; rejects `0`, `1.5`, `-1`, `NaN`, `2**53`.
  - `compositeKey('saas', 'u1') !== compositeKey('selfhost-…', 'u1')` and both contain `'\0'`; `compositeKey(a, 'x\0y')` cannot equal `compositeKey(a + '\0x', 'y')` — assert the function throws on a `localId` containing `'\0'`.
  - `parseConnectionIdentity` round-trips a valid object; returns `null` for an extra key, a missing `apiOrigin`, a non-origin `apiOrigin` (`'https://a.example/path'`), `kind` disagreeing with `serviceId`.
  - In `selfHostedProfile.test.ts`: `serviceIdForApiBase('https://api.concordvoice.chat') === 'saas'`; two origins differing only by path map to one id; `dirKeyForApiBase` is 64 hex chars for a self-hosted origin and `''` for saas.
- [ ] **Step 2: Run to verify failure** — `cd desktop && npx vitest run tests/unit/shared/connectionIdentity.test.ts tests/unit/main/selfHostedProfile.test.ts` → FAIL (module not found / export missing).
- [ ] **Step 3: Implement** `shared/connectionIdentity.ts` (no imports; preload-safe) and the two `selfHostedProfile.ts` exports.
- [ ] **Step 4: Run to verify pass** — same command → PASS; `npx vitest run tests/integration/preload-sandbox-contract.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/shared/connectionIdentity.ts desktop/src/main/selfHostedProfile.ts desktop/tests/unit/shared/connectionIdentity.test.ts desktop/tests/unit/main/selfHostedProfile.test.ts
git commit -m "feat: add branded connection identity types and guards"
```

---

### Task 2: Registry, owner-binding primitive, `requireConnectionSender`

**Files:**
- Create: `desktop/src/main/connectionRegistry.ts`, `desktop/src/main/connectionCapability.ts`, `desktop/src/main/ipc/connectionSender.ts`
- Modify: `desktop/src/main/ipc/frameValidation.ts:75-90` (add `isPermittedFrameUrlForKind`)
- Test: `desktop/tests/unit/main/connectionRegistry.test.ts`, `desktop/tests/unit/main/connectionCapability.test.ts`, `desktop/tests/unit/main/ipc/connectionSender.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `isPermittedFrameUrl(url, remoteSpaOrigin)`; `ProfileCustody` type from Task 5 (declare as `import type` — Task 5 lands in parallel; until it does, declare `ProfileCustody` as an opaque `interface ProfileCustody {}` placeholder in `connectionRegistry.ts` and replace in Task 5).
- Produces:

```ts
// connectionRegistry.ts
export const MAX_LIVE_CONNECTIONS = 4;   // provisional; set from Task 0 results
export interface ServiceRecord { serviceId: ServiceId; kind: ServiceKind; origin: string; dirKey: string; session: Session; custody: ProfileCustody }
export type ConnectionState = 'loading' | 'ready' | 'disposed';
export interface ConnectionRecord { connectionId: ConnectionId; serviceId: ServiceId; generation: Generation; view: WebContentsView | null; webContents: WebContents; pips: Set<WebContents>; state: ConnectionState }
export type BindingRole = 'primary' | 'pip';
export interface SenderBinding { connectionId: ConnectionId; role: BindingRole }
export type RegisterServiceRefusal = 'invalid-origin' | 'not-approved' | 'service-id-collision';
export function registerService(origin: string, deps: { makeSession(service: Omit<ServiceRecord,'session'|'custody'>): Session; makeCustody(serviceId: ServiceId, origin: string): ProfileCustody; isValidatedSelfHostedApiBase(origin: string): boolean }): { ok: true; service: ServiceRecord } | { ok: false; reason: RegisterServiceRefusal }
export function getService(id: ServiceId): ServiceRecord | undefined;  export function serviceForOrigin(origin: string): ServiceRecord | undefined
export function mintConnectionId(): ConnectionId   // crypto.randomBytes(16).toString('base64url')
export function openConnection(serviceId: ServiceId, webContents: WebContents, view: WebContentsView | null): { ok: true; record: ConnectionRecord } | { ok: false; reason: 'limit' | 'already-open' | 'unknown-service' }
export function bindSender(wc: WebContents, connectionId: ConnectionId, role: BindingRole): void
export function bindingFor(wc: WebContents): SenderBinding | undefined;  export function recordFor(id: ConnectionId): ConnectionRecord | undefined
export function refOf(record: ConnectionRecord): ConnectionRef
export function advanceGeneration(id: ConnectionId, reason: GenerationReason): Generation   // the ONLY mutator; synchronous
export function onGenerationAdvanced(l: (id: ConnectionId, from: Generation, to: Generation, reason: GenerationReason) => void): () => void
export function setForeground(id: ConnectionId | null): void;  export function foreground(): ConnectionRecord | null
export function disposeConnection(id: ConnectionId): void   // advanceGeneration('disposed') → state 'disposed' → clear foreground if it was this one → delete
export function liveConnections(): ConnectionRecord[];  export function primaries(): WebContents[]
export function _resetConnectionRegistryForTesting(): void
// connectionCapability.ts
export type CapabilityKind = 'audiocap' | 'sso-loopback' | 'tray' | 'capture-lease';
export interface OwnerBinding { readonly kind: CapabilityKind; readonly ref: ConnectionRef }   // class instance; private constructor → unforgeable
export function bindOwner(kind: CapabilityKind, ref: ConnectionRef): OwnerBinding
export function isOwnerCurrent(b: OwnerBinding): boolean            // b instanceof OwnerBindingImpl && recordFor(id)?.generation === b.ref.generation
export function requireOwner(event: IpcMainEvent | IpcMainInvokeEvent, b: OwnerBinding): ConnectionRecord | null   // sender binding.connectionId === b.ref.connectionId ∧ main frame ∧ isOwnerCurrent
export { onGenerationAdvanced } from './connectionRegistry';
// ipc/connectionSender.ts
export type SenderRefusal = 'untrusted-sender' | 'not-foreground' | 'wrong-owner' | 'not-saas' | 'not-primary';
export interface ConnectionSender { record: ConnectionRecord; service: ServiceRecord; custody: ProfileCustody; ref: ConnectionRef; frame: WebFrameMain; role: BindingRole }
export function requireConnectionSender(event: IpcMainEvent | IpcMainInvokeEvent, opts?: { roles?: BindingRole[] }, remoteSpaOrigin?: string | null): ConnectionSender | null
export function requireForegroundPrimary(event, remoteSpaOrigin?): ConnectionSender | null
export function requireSaasPrimary(event, remoteSpaOrigin?): ConnectionSender | null
export function crossCheckApiBase(sender: ConnectionSender, supplied: unknown): boolean   // undefined → true; else originForApiBase(supplied) === sender.service.origin
// frameValidation.ts
export function isPermittedFrameUrlForKind(url: string, kind: ServiceKind, remoteSpaOrigin: string | null): boolean  // saas → isPermittedFrameUrl; selfhost → app://concord or http://localhost:* only
```

- [ ] **Step 1: Write the failing registry tests** (`connectionRegistry.test.ts`, electron `session`/`WebContents` mocked as plain objects):
  - `registerService` same origin twice returns the same record; a second origin whose `serviceIdForApiBase` is forced (mock) to equal the first's → `{ ok:false, reason:'service-id-collision' }` and `serviceByOrigin` unchanged.
  - self-hosted origin with `isValidatedSelfHostedApiBase` false → `'not-approved'`; `'not a url'` → `'invalid-origin'`.
  - `openConnection` for an unknown service → `'unknown-service'`; twice for one service → `'already-open'`; the `MAX_LIVE_CONNECTIONS + 1`th → `'limit'`.
  - `mintConnectionId()` passes `isConnectionId` and 1000 mints are distinct.
  - `advanceGeneration` returns strictly increasing values starting at 2 (records start at 1); listeners receive `(id, from, to, reason)`; unsubscribe stops delivery.
  - `bindingFor` keyed by object identity: two distinct objects with equal `id` fields do not share a binding; a PiP bound with role `'pip'` resolves to the opener's `connectionId`.
  - `disposeConnection` fires `'disposed'`, clears foreground when it was foreground, and `recordFor` returns `undefined` afterwards.
- [ ] **Step 2: Write the failing capability tests** (`connectionCapability.test.ts`):
  - `isOwnerCurrent` true right after `bindOwner`; false after `advanceGeneration`; false for a hand-built `{ kind, ref }` object literal (not an instance).
  - `requireOwner` null when sender is bound to another connection, when `senderFrame.parent !== null`, when `senderFrame` is null, when binding is stale; returns the record otherwise.
  - listener-after-revocation: inside an `onGenerationAdvanced` listener, `isOwnerCurrent(oldBinding) === false`.
  - aborted-navigation ceiling (§3.9): bump `'document'` then simulate the navigation aborting — the binding stays revoked (`isOwnerCurrent` false).
- [ ] **Step 3: Write the failing sender-matrix tests** (`connectionSender.test.ts`) — one `it` per row: unregistered webContents; subframe sender; null `senderFrame`; `https://spa.concordvoice.chat/` frame inside a self-hosted view; `spa-cache://concord/` inside a self-hosted view; PiP of A with `roles: ['primary']`; PiP of A acting as B (`crossCheckApiBase(pipSender, B.origin)` false); background primary via `requireForegroundPrimary`; self-hosted primary via `requireSaasPrimary` → all `null`/`false`. (The spec's "`requireShellSender` placeholder removed" has no counterpart in the tree — nothing to delete; do not add one.) Positive: `app://concord/` main frame in a self-hosted view → sender with `custody === service.custody`. `crossCheckApiBase(sender, 'https://b.example:8443/api/')` false for A, true for B, true for `undefined`.
- [ ] **Step 4: Run to verify failure** — `npx vitest run tests/unit/main/connectionRegistry.test.ts tests/unit/main/connectionCapability.test.ts tests/unit/main/ipc/connectionSender.test.ts` → FAIL.
- [ ] **Step 5: Implement the three modules and `isPermittedFrameUrlForKind`**. `advanceGeneration` is one synchronous block: write new generation → fire listeners (revocation is implicit — `isOwnerCurrent` compares against the record, so every older binding is stale before any listener runs).
- [ ] **Step 6: Run to verify pass** — same command → PASS; `npm run build:main` → clean.
- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/connectionRegistry.ts desktop/src/main/connectionCapability.ts desktop/src/main/ipc/connectionSender.ts desktop/src/main/ipc/frameValidation.ts desktop/tests/unit/main/connectionRegistry.test.ts desktop/tests/unit/main/connectionCapability.test.ts desktop/tests/unit/main/ipc/connectionSender.test.ts
git commit -m "feat: add connection registry, owner-binding primitive and sender admission"
```

---

### Task 3: Per-connection session factory (`connectionSession.ts`)

**Files:**
- Create: `desktop/src/main/connectionSession.ts`
- Reference (bodies move here in Task 4, do not edit yet): `desktop/src/main/main.ts:1560-1600` (`protocol.handle('app')`, `protocol.handle(SPA_CACHE_SCHEME)`), `:1657-1735` (permission request/check/device handlers, `select-hid-device`, KLIPY `onBeforeSendHeaders`), `:3196-3260` (`web-contents-created` gate)
- Test: `desktop/tests/unit/main/connectionSession.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2 `bindingFor`, `recordFor`, `getService`; `resolveAppProtocolPath`, `handleCacheProtocolRequest`, `SPA_CACHE_SCHEME`; `isPermittedFrameUrlForKind`.
- Produces:

```ts
export interface CaptureArbiter { decide(ref: ConnectionRef | null, permission: string, details: unknown): boolean }
export const defaultCaptureArbiter: CaptureArbiter   // ref === null → false; permission === 'geolocation' → false; else true
export function captureArbiter(): CaptureArbiter;  export function setCaptureArbiter(a: CaptureArbiter): () => void   // #87 hook
export interface ConnectionSessionDeps { isPackaged: boolean; bundleRoot: string; getLiveDir(): string | null; remoteSpaOrigin(): string | null; bindingFor(wc: WebContents): SenderBinding | undefined; recordFor(id: ConnectionId): ConnectionRecord | undefined; getService(id: ServiceId): ServiceRecord | undefined }
export function sessionForService(kind: ServiceKind, dirKey: string, userDataRoot: string): Session   // saas → session.defaultSession; selfhost → session.fromPath(join(userDataRoot,'profiles',dirKey,'session'))
export function configureConnectionSession(ses: Session, service: ServiceRecord, deps: ConnectionSessionDeps): void   // exactly once per Session (WeakSet)
export function installNavigationGate(contents: WebContents, deps: ConnectionSessionDeps): void   // will-navigate + setWindowOpenHandler; unbound → deny
export function sessionFetchFor(service: ServiceRecord): (url: string, init?: RequestInit) => Promise<Response>   // service.session.fetch
export function assertDefaultSessionIsSaas(live: Iterable<WebContents>, bindingFor: (wc: WebContents) => SenderBinding | undefined): void   // throws on the R1 invariant breach
export function _resetConnectionSessionForTesting(): void
```

- [ ] **Step 1: Write the failing tests** (`connectionSession.test.ts`, `electron` mocked: `session.defaultSession`, `session.fromPath` returning distinct fake sessions with spy `protocol.handle`, `setPermissionRequestHandler`, `webRequest.onBeforeSendHeaders`):
  - `configureConnectionSession` twice on one session registers handlers once.
  - `app` scheme handled on every session; `SPA_CACHE_SCHEME` handled only when `service.kind === 'saas'`.
  - permission request from an unbound webContents → callback `false`; bound + `'geolocation'` → `false`; bound + `'media'` → `true`; after `setCaptureArbiter({ decide: () => false })` bound `'media'` → `false`; the returned unsubscribe restores the default.
  - KLIPY: `onBeforeSendHeaders` filter is `[`${service.origin}/api/v1/klipy/media*`]`; the callback adds `Authorization` only when `service.custody.getCachedAccessToken()` is non-null and the request URL origin equals `service.origin`; B's origin inside A's session gets no header.
  - `select-hid-device` listener attached once per session (WebAuthn in self-hosted views).
  - `sessionForService('saas', '', root) === session.defaultSession`; `sessionForService('selfhost', 'abc', root)` calls `session.fromPath('<root>/profiles/abc/session')`.
  - navigation gate: unbound contents → `event.preventDefault()`; saas-bound → permitted targets are `isPermittedFrameUrl` set; selfhost-bound → `app://concord` and `http://localhost:*` only; external `https://` → externalized not navigated.
  - defaultSession invariant: `assertDefaultSessionIsSaas(liveContents, bindingFor)` throws if any `wc.session === session.defaultSession && binding.serviceId !== 'saas'`, and does not throw for the `saas` primary and its PiPs.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/connectionSession.test.ts` → FAIL.
- [ ] **Step 3: Implement** — port the handler bodies from the `main.ts` regions above verbatim into the factory, parametrised by `service` and `deps`; do not delete them from `main.ts` yet (Task 4 does).
- [ ] **Step 4: Run to verify pass** → PASS; `npm run build:main` clean.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/connectionSession.ts desktop/tests/unit/main/connectionSession.test.ts
git commit -m "feat: add per-connection session factory with capture arbiter hook"
```

---

### Task 5: `tokenManager` closure factory (runs in parallel with Tasks 2, 3)

**Files:**
- Modify: `desktop/src/main/tokenManager.ts:84-134` (module `let`s → instance fields), `:260` (`readActiveApiBase`), `:344` (`deleteFiles` default), `:959` (`clearTokens` fallback chain), `:1090,:1146,:1159` (`apiBase !== inMemoryApiBase` comparisons), `:1233-1255` (`_resetForTesting`, `_flushDiskWritesForTesting`)
- Modify: `desktop/src/main/main.ts` — every `tokenManager` call site (grep `from './tokenManager'`) becomes `custodyForApiBase(<apiBase currently in scope>).<fn>(…)`; transitional, removed in Task 7B
- Modify: `desktop/src/main/connectionRegistry.ts` — replace the `ProfileCustody` placeholder with `import type { ProfileCustody } from './tokenManager'`
- Modify: `.claude/rules/domains/electron.md:1225-1237` (§ Token Storage), `.claude/rules/domains/e2ee.md:84-92` (§ Key Material)
- Test: `desktop/tests/unit/services/tokenManager.test.ts` (parametrise), `desktop/tests/unit/services/tokenManager.crossInstance.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `ServiceId`, `serviceIdForApiBase`.
- Produces:

```ts
export interface ProfileCustody {
  readonly serviceId: ServiceId; readonly apiOrigin: string;
  // the 23 current exports, same parameter/return types, minus any `apiBase` parameter that only selected the profile:
  getCachedAccessToken; getApiBaseOrigin; setProactiveRefreshCallback; stopProactiveRefresh; onSystemResume;
  storeRefreshToken; reserveCredentialOwner; credentialOwnerIsCurrent; storeRefreshTokenIfOwner; restoreRefreshToken;
  performRefresh; performLogout; clearTokens; clearTokensIfOwner; releaseCredentialReservation;
  storeE2EEKeys; storeE2EEKeysIfOwner; restoreE2EEKeys; getCredentialCustodyState; getPersistedApiBase; getCapabilities;
  _resetForTesting; _flushDiskWritesForTesting;
  onCredentialEvent(l: (phase: 'credential-start' | 'credential-end', owner: CredentialOwner | null) => void): () => void;  // R6 trigger; not fired by refresh rotation
}
export function createProfileCustody(serviceId: ServiceId, apiOrigin: string): ProfileCustody
export function custodyFor(serviceId: ServiceId, apiOrigin: string): ProfileCustody        // get-or-create cache; the registry's makeCustody
export function custodyForApiBase(apiBase: string): ProfileCustody                            // TRANSITIONAL: custodyFor(serviceIdForApiBase(apiBase), originForApiBase(apiBase)); deleted in Task 7B
export function _resetAllCustodyForTesting(): void
```

- [ ] **Step 1: Parametrise the existing suite** — wrap `tokenManager.test.ts` in `describe.each([['saas', 'https://api.concordvoice.chat'], ['selfhost-A', 'https://a.example'], ['selfhost-B', 'https://b.example:8443']])`; each `beforeEach` does `custody = createProfileCustody(serviceIdForApiBase(origin), origin)` and every former module call becomes `custody.<fn>`. File paths asserted in the suite come from `profilePathsForApiBase(origin)`.
- [ ] **Step 2: Write the failing cross-instance tests** (`tokenManager.crossInstance.test.ts`): 
  - `A.clearTokens()` leaves `B.getCachedAccessToken()` and B's files on disk intact (fixture tree under a temp `userData`).
  - A's proactive timer fires `A`'s callback only (B's `setProactiveRefreshCallback` spy not called).
  - same `CredentialOwner` number minted in A and B: `B.storeE2EEKeysIfOwner(ownerFromA, …)` and `B.clearTokensIfOwner(ownerFromA)` are refused (`false`) — fences never compare across instances.
  - removed fallback: with `inMemoryApiBase` empty and `active-profile.json` pointing at `saas`, `selfhostA.clearTokens()` deletes **nothing** under the root (byte-identical root files).
  - `onCredentialEvent` fires `'credential-start'` on `storeRefreshToken`/`reserveCredentialOwner` success, `'credential-end'` on `clearTokens`/`clearTokensIfOwner(true)`/`performLogout`; **not** on `performRefresh` rotation.
  - `custodyFor(id, origin)` returns the same instance twice; `_resetAllCustodyForTesting` clears it.
- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/unit/services/tokenManager.test.ts tests/unit/services/tokenManager.crossInstance.test.ts` → FAIL (`createProfileCustody` not exported).
- [ ] **Step 4: Implement the factory** — move lines 84-134 into the closure as instance fields; port all 23 bodies verbatim (only `inMemoryApiBase` reads become `apiOrigin`; `deleteFiles` takes no parameter and uses `profilePathsForApiBase(apiOrigin)`; the `inMemoryApiBase || readActiveApiBase() || DEFAULT_PROFILE_API_BASE` chain at `:959` and the default at `:344` are deleted). `active-profile.json` is still written where it is written today; it is never read for authorisation (`readActiveApiBase` survives only for `getPersistedApiBase`). Update `main.ts` call sites to `custodyForApiBase(...)` and existing `vi.mock('…/tokenManager')` factories in `tests/unit/main/*.test.ts` to expose `custodyForApiBase` returning the mocked function set.
- [ ] **Step 5: Run to verify pass** — the two suites PASS; `npx vitest run tests/unit/main` PASS; `npm run build:main` clean.
- [ ] **Step 6: Docs** — electron.md § Token Storage: add the #1618 paragraph "one `ProfileCustody` instance per service (`createProfileCustody`), session + custody per service, cross-profile fallback chain removed"; e2ee.md § Key Material: "in-memory E2EE key material is per-service custody state; `clearTokens` clears one instance".
- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/tokenManager.ts desktop/src/main/main.ts desktop/src/main/connectionRegistry.ts desktop/tests/unit/services desktop/tests/unit/main .claude/rules/domains/electron.md .claude/rules/domains/e2ee.md
git commit -m "refactor: make token custody a per-service closure factory"
```

---

### Task 4: `BaseWindow` composition and connection views

**Files:**
- Create: `desktop/src/main/shellWindow.ts`
- Modify: `desktop/src/main/main.ts:1318-1365` (createWindow → `createShellWindow`), `:1457-1480` (close handler on `BaseWindow`), `:1522` (`attachTrayResetHooks` per view), `:1560-1600` and `:1657-1735` (delete — moved to Task 3 factory; call `configureConnectionSession` per service instead), `:1926-1975` (quit hooks: `destroyPipWindowsForQuit` + close every child webContents), `:2128-2155` (`app:setContentProtection` on `BaseWindow`), `:2919-3030` (PiP: `webPreferences.session = owner.session`, bind role `'pip'`), `:3196` (`web-contents-created` → `installNavigationGate`), every `mainWindow.webContents` consumer (27 sites — grep `mainWindow\.webContents\|mainWindow?\.webContents`)
- Modify: `desktop/src/main/windowState.ts:87` (`attachWindowState(win: BaseWindow)`), `desktop/src/main/connectionRegistry.ts:MAX_LIVE_CONNECTIONS` (Task 0 value)
- Modify: `.claude/rules/domains/frontend.md` (Platform-behavior register rows from Task 0)
- Test: `desktop/tests/unit/main/shellWindow.test.ts`, `desktop/tests/unit/main/quitLifecycle.deadlock.test.ts` (re-point mocks at `BaseWindow`), `desktop/tests/unit/main/main.test.ts:25-77` (mock `BaseWindow` + `WebContentsView`; keep the audiocap ordering pins green)

**Interfaces:**
- Consumes: Task 0 results; Task 2 registry; Task 3 `sessionForService`, `configureConnectionSession`, `installNavigationGate`; Task 5 `custodyFor`; `buildBrowserWindowConfig`, `loadWindowState`, `applyContentProtectionAtCreation`, `wireAudiocapRendererLoss`, `attachTrayResetHooks`, `resetDeepLinkDelivery`.
- Produces:

```ts
export function createShellWindow(deps: ShellDeps): BaseWindow
export function shellWindow(): BaseWindow | null
export function openConnectionView(serviceId: ServiceId, url: string): Promise<{ ok: true; record: ConnectionRecord } | { ok: false; reason: 'limit' | 'already-open' | 'unknown-service' | 'session-unavailable' }>
   // order (§3.9, #3394): openConnection+bindSender → wireAudiocapRendererLoss → attachTrayResetHooks → did-start-loading reset → generation hooks → loadURL
export function activateConnection(serviceId: ServiceId): boolean        // setForeground + setVisible; false if unknown/not live
export function foregroundWebContents(): WebContents | null;  export function foregroundView(): WebContentsView | null
export function sendToConnection(ref: ConnectionRef, channel: string, ...args: unknown[]): boolean   // false (no-op) unless recordFor(ref.connectionId)?.generation === ref.generation and webContents alive
export function broadcastToPrimaries(channel: string, ...args: unknown[]): void
export function disposeConnectionView(connectionId: ConnectionId): void   // advanceGeneration('disposed') → clear foreground → destroy PiPs → removeChildView → webContents.close()
export function layoutViews(): void                                        // foreground view bounds = contentBounds; others setVisible(false)
export function installDevConnectionMenu(): void                            // only when !app.isPackaged
```

- [ ] **Step 1: Write the failing `shellWindow.test.ts`** (electron mocked with `BaseWindow`, `WebContentsView`, fake sessions):
  - `openConnectionView` wires `wireAudiocapRendererLoss` and `attachTrayResetHooks` **before** `loadURL` (call-order assertion); binds the view's webContents as `'primary'`.
  - generation hooks: main-frame `did-start-navigation` → `advanceGeneration(id,'document')`; subframe navigation → no bump; `render-process-gone` → `'renderer-gone'`; custody `'credential-start'`/`'credential-end'` → bump with that reason.
  - `sendToConnection` with a stale ref → `false` and `webContents.send` not called; current ref → `true`.
  - `activateConnection` makes only the target visible; `layoutViews` after a `resize` event sets the foreground view bounds to `getContentBounds()` (Review Focus 1); after `maximize` and `enter-full-screen` likewise.
  - `openConnectionView` when `session.fromPath` throws → `{ ok:false, reason:'session-unavailable' }`, `console.warn` called, and the `saas` view is still created (Review Focus 2).
  - `disposeConnectionView` order: generation `'disposed'` fires before `removeChildView` before `webContents.close()`; PiPs in `record.pips` destroyed.
  - `BaseWindow 'closed'` closes every live child webContents (Review Focus 5); `'close'` with `isQuitting` true returns early (#1383 preserved).
  - `applyContentProtectionAtCreation` is called on the `BaseWindow` before the first `addChildView`/`loadURL` (call-order assertion).
  - PiP creation uses `webPreferences.session === owner.session` and binds role `'pip'` to the opener's connection; `sandbox`, `contextIsolation`, `!nodeIntegration` pinned on the PiP options.
  - defaultSession invariant: after opening `saas` + one self-hosted view, `assertDefaultSessionIsSaas(liveContents)` does not throw.
  - `installDevConnectionMenu` builds `Menu` items only when `app.isPackaged === false`.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/shellWindow.test.ts` → FAIL.
- [ ] **Step 3: Implement `shellWindow.ts`** and rewire `main.ts`: `createWindow` body becomes `createShellWindow` + `openConnectionView('saas', <existing saas URL resolution>)`; `session.defaultSession.*` blocks and both `protocol.handle` calls are deleted from `main.ts` in favour of `configureConnectionSession(service.session, service, deps)` at `registerService` time; `web-contents-created` delegates to `installNavigationGate`; each of the 27 `mainWindow.webContents` consumers is classified and replaced — pushes that address one connection use `sendToConnection(ref, …)`, tray/PiP/content-protection/window-state use `foregroundWebContents()`/`shellWindow()`, updater pushes use `broadcastToPrimaries`. Keep the classification as a comment block at the top of `shellWindow.ts` (the T4 checklist §5 asks for). `powerMonitor 'resume'` at `:1866` stays as is for now (Task 7B fans it out).
- [ ] **Step 4: Update `quitLifecycle.deadlock.test.ts` and `main.test.ts` mocks** to `BaseWindow`/`WebContentsView`; keep every existing assertion (the audiocap ordering pins, the `before-quit`/`will-quit`/`before-quit-for-update` `destroyPipWindowsForQuit` pins).
- [ ] **Step 5: Run to verify pass** — `npx vitest run tests/unit/main` → PASS; `npm run build:main` and `npm run typecheck` clean; `npm run lint` clean.
- [ ] **Step 6: Visual verification (A11)** — `npm run dev`; open `saas` plus one local self-hosted connection (dev `Menu` → Connections). For **each shipped theme** — `dark` and `light` (`settingsStore.theme`; `'system'` resolves to one of these — capture it once in whichever it resolves to and note the OS setting) — capture: normal, maximized, full-screen, after switching foreground connection, with a PiP open. Save to `/private/tmp/claude-501/-Users-markd--claude-spares-spare-kf1ERt/fc2240ee-4ea7-4102-ad6a-1a3c11301f6e/scratchpad/visual/86/<theme>-<state>.png` for the PR body. Check traffic lights (`hiddenInset`) do not overlap the child view and the drag region still works. Windows/Linux captures: NOT CAPTURED — record in the PR body with the reason, same rule as Task 0.
- [ ] **Step 7: Docs** — frontend.md: add the Task 0 rows (drag region, overlay hit-testing, traffic lights, Wayland chrome, hidden-view throttling, child survival on close — measured values for macOS; `NOT MEASURED` for Windows/Linux) to `## Platform-behavior register (post-#2866)` at `.claude/rules/domains/frontend.md:389`. Set `MAX_LIVE_CONNECTIONS` to the Task 0 value.
- [ ] **Step 8: Commit**

```bash
git add desktop/src/main/shellWindow.ts desktop/src/main/main.ts desktop/src/main/windowState.ts desktop/src/main/connectionRegistry.ts desktop/tests/unit/main .claude/rules/domains/frontend.md
git commit -m "feat: compose connection views in a BaseWindow with per-connection sessions"
```

---

### Task 6: Migration P0/P1 and `connections.json` v1

**Files:**
- Create: `desktop/src/main/connectionsFile.ts`, `desktop/src/main/connectionMigration.ts`
- Modify: `desktop/src/main/main.ts:169` (insert `runConnectionMigration(...)` immediately after `loadApprovedSelfHostedOrigins()`; before `createShellWindow` and any custody restore), `desktop/src/main/shellWindow.ts` (open a view per persisted entry at startup; write `lastForegroundAt` on `activateConnection`)
- Modify: `docs/self-hosted-client.md` (new "Connection model" section)
- Test: `desktop/tests/unit/main/connectionsFile.test.ts`, `desktop/tests/unit/main/connectionMigration.test.ts`

**Interfaces:**
- Consumes: Task 1 `serviceIdForApiBase`; `isValidatedSelfHostedApiBase` and `profilePathsForApiBase` from `selfHostedProfile.ts` (root `token-meta.json` and `active-profile.json` paths — read directly; never through a custody instance).
- Produces:

```ts
export const CONNECTIONS_FILE_VERSION = 1;  export const MAX_CONNECTIONS_ENTRIES = 16;
export interface ConnectionsFileEntry { serviceId: ServiceId; origin: string; addedAt: string; lastForegroundAt: string | null }   // exact keys; ISO-8601; no secrets
export interface ConnectionsFile { version: 1; connections: ConnectionsFileEntry[] }
export function connectionsFilePath(userDataRoot: string): string   // <root>/connections.json
export function readConnectionsFile(userDataRoot: string, deps: { isValidatedSelfHostedApiBase(origin: string): boolean }): ConnectionsFileEntry[]   // drops: wrong version, extra/missing keys, origin not re-canonicalising to serviceId, unapproved self-hosted origin, >16 entries (keeps first 16)
export function writeConnectionsFile(userDataRoot: string, entries: ConnectionsFileEntry[]): Promise<void>   // one FIFO writer; tmp + rename; mode 0o600
export function deriveInitialConnections(userDataRoot: string, deps): ConnectionsFileEntry[]   // P0
export function runConnectionMigration(userDataRoot: string, deps): { entries: ConnectionsFileEntry[]; derived: boolean }   // P0+P1 only when the file is absent; otherwise read
```

- [ ] **Step 1: Write the failing fixture-tree tests** — each test builds a temp `userData` tree, snapshots `sha256` of every pre-existing file, runs, and asserts the snapshot is unchanged (byte-identical legacy files, A9):
  - fresh tree → `[saas]`, `derived: true`, file written with `version: 1`.
  - root `token-meta.json` only (Remember-Me) → `[saas]`.
  - `active-profile.json` → approved origin X, no root meta → `[X]`.
  - both → `[X, saas]`.
  - corrupt `active-profile.json` → `[saas]`, no throw.
  - `active-profile.json` → unapproved origin → `[saas]` (dropped).
  - file already present → P0 skipped (`derived: false`), contents returned as-is after validation.
  - write failure (read-only dir) → returns derived entries, `console.warn`, no throw.
  - `readConnectionsFile`: entry with an extra key dropped; `lastForegroundAt` is never read by any admission path (assert `deriveInitialConnections` output and `registerService` inputs ignore it); 17 entries → 16.
  - `writeConnectionsFile` twice concurrently → second content wins, file mode `0o600`, no `.tmp` left behind.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/connectionsFile.test.ts tests/unit/main/connectionMigration.test.ts` → FAIL.
- [ ] **Step 3: Implement** both modules; wire `main.ts:169` and startup view opening in `shellWindow.ts` (one `openConnectionView` per validated entry, `saas` first; the entry with the latest `lastForegroundAt` is activated — layout only).
- [ ] **Step 4: Run to verify pass** → PASS; `npx vitest run tests/unit/main/pinUserDataPath.test.ts` PASS (first import unchanged).
- [ ] **Step 5: Docs** — `docs/self-hosted-client.md`: add "Connection model" (one view per service, `connections.json` v1 shape, `profiles/<sha256(origin)>/session`, new self-hosted connections start with default device-level UI settings until Self-Hosted#113, downgrade: older shell ignores `connections.json`, only self-hosted `session/` UI storage is lost).
- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/connectionsFile.ts desktop/src/main/connectionMigration.ts desktop/src/main/main.ts desktop/src/main/shellWindow.ts desktop/tests/unit/main/connectionsFile.test.ts desktop/tests/unit/main/connectionMigration.test.ts docs/self-hosted-client.md
git commit -m "feat: persist connections.json v1 with non-destructive P0 derivation"
```

---

### Task 7A: `registerIpc` registry, ESLint ban, classification table, `connection:*` channels, contract v34

**Files:**
- Create: `desktop/src/main/ipc/registry.ts`, `desktop/src/main/ipc/channelClassification.ts`, `desktop/src/main/ipc/connection.ts`
- Modify: `desktop/eslint.config.mjs:252-260` (main-scoped `no-restricted-syntax`: add selector banning `ipcMain.handle|on|once|handleOnce` outside `src/main/ipc/registry.ts`; add the virtual fixture path to `allowDefaultProject`), `desktop/src/main/ipcContract.ts:328` (`IPC_CONTRACT_VERSION = 34`; add `ConnectionCreateResult`, `ConnectionGenerationPush` types), `desktop/src/preload/preload.ts:73` (bridge `connection` namespace) and `:1072` (Window type), `desktop/src/main/main.ts` (register `connection:*`; push `connection:generation` from `onGenerationAdvanced`)
- Modify: `.claude/rules/domains/electron.md` (new "### IPC contract v34" after the v33 section at `:1042-1081`; § Sender-frame validation `:1171`; § Accepted risk `:1499`)
- Test: `desktop/tests/unit/main/ipc/registry.test.ts`, `desktop/tests/unit/main/ipc/channelClassification.test.ts`, `desktop/tests/unit/main/eslint-no-raw-ipcmain.test.ts`, `desktop/tests/unit/main/ipc/connection.test.ts`, `desktop/tests/unit/main/ipcContract.test.ts:14-22` (33 → 34), `desktop/tests/unit/main/preloadConnectionBridge.test.ts`

**Interfaces:**
- Consumes: Task 2 `requireConnectionSender`, `requireForegroundPrimary`, `requireSaasPrimary`; Task 4 `openConnectionView`, `activateConnection`, `sendToConnection`; Task 6 `writeConnectionsFile`; `probeSelfHostedServer`, `consumeCeremonyToken`, `commitSelfHostedApproval`.
- Produces:

```ts
// ipc/registry.ts
export type AdmissionClass = 'connection-bound' | 'app-global-read' | 'app-global-mutate' | 'saas-only' | 'pip-scoped' | 'exempt-low-stakes';
export type IpcMethod = 'handle' | 'on' | 'once' | 'handleOnce';
export function registerIpc<A extends unknown[], R>(channel: string, cls: AdmissionClass, handler: (sender: ConnectionSender, event: IpcMainEvent | IpcMainInvokeEvent, ...args: A) => R, opts?: { method?: IpcMethod; refusal?: (reason: SenderRefusal) => R }): void
   // admission per class: connection-bound → requireConnectionSender(roles:['primary']); app-global-read → any registered primary; app-global-mutate → requireForegroundPrimary; saas-only → requireSaasPrimary; pip-scoped → requireConnectionSender(roles:['pip','primary']); exempt-low-stakes → foreground primary, silent undefined otherwise
export function registeredChannels(): ReadonlyMap<string, AdmissionClass>;  export function _resetIpcRegistryForTesting(): void
// ipc/channelClassification.ts
export const CHANNEL_CLASSES: Readonly<Record<string, AdmissionClass>>   // every channel in the tree; constants resolved from `export const X = '<channel>'` in ipcContract.ts / shared/**
// ipc/connection.ts
export type ConnectionCreateResult = { status: 'opened'; serviceId: ServiceId } | { status: 'rejected'; reason: 'untrusted-sender' | 'not-foreground' | 'invalid-origin' | 'declined' | 'busy' | 'limit' | 'service-id-collision' }
export interface ConnectionGenerationPush { connectionId: ConnectionId; generation: Generation; reason: GenerationReason }
export function registerConnectionIpc(deps: { openConnectionView; activateConnection; probe; ceremony; writeConnections }): void
   // 'connection:whoAmI' via ipcMain.on + event.returnValue (sync map lookup; registered primary or PiP MAIN FRAME, origin allowed for kind; else null)
   // 'connection:create' app-global-mutate; single-flight per origin; probe → ceremony → consumeCeremonyToken → commitSelfHostedApproval → registerService → openConnectionView → activate
   // 'connection:activate' app-global-mutate → boolean
// preload bridge
electron.connection: { whoAmI(): ConnectionIdentity | null; create(origin: string): Promise<ConnectionCreateResult>; activate(serviceId: string): Promise<boolean>; onGenerationChanged(cb: (p: ConnectionGenerationPush) => void): () => void; preferenceScope(): Promise<PreferenceScope | null> }
   // whoAmI result cached from ONE ipcRenderer.sendSync('connection:whoAmI') at preload evaluation; onGenerationChanged delivers only generation > cached and updates the cache
```

- [ ] **Step 1: Write the failing registry tests** (`registry.test.ts`): one `it` per class × (admitted / refused) using fake events bound through Task 2's registry; refused `handle` returns `opts.refusal(reason)` or `{ status:'rejected', reason }` by default; refused `exempt-low-stakes` returns `undefined` and does not `console.warn`; `registeredChannels()` lists every registration; registering a channel absent from `CHANNEL_CLASSES` throws `Unclassified IPC channel: <name>`; registering with a class different from the table's throws; admission is synchronous (§3.9) — nulling `event.senderFrame` on the next microtask after invoking the wrapped handler does not change the `sender` the handler received, and the wrapper contains no `await` before the handler call.
- [ ] **Step 2: Write the failing classification audit** (`channelClassification.test.ts`): regex over `src/main/**/*.ts` for `registerIpc(` first arguments (literal or identifier resolved against `export const <Id> = '<channel>'` declarations in `src/main/ipcContract.ts` and `src/shared/**`); assert the set equals `Object.keys(CHANNEL_CLASSES)` exactly (both directions), and that no `ipcMain.(handle|on|once|handleOnce)(` text exists outside `src/main/ipc/registry.ts` and `connection:whoAmI`'s `ipcMain.on` inside `ipc/connection.ts`.
- [ ] **Step 3: Write the failing ESLint test** (`eslint-no-raw-ipcmain.test.ts`, pattern of `eslint-no-bare-anchor.test.ts`): lint `ipcMain.handle('x', () => 1)` at virtual path `src/main/__ipc-lint-fixture__.ts` → one `no-restricted-syntax` message; the same text at `src/main/ipc/registry.ts` path → zero.
- [ ] **Step 4: Write the failing `connection.test.ts`**: `whoAmI` returns the identity for a bound primary main frame, `null` for a subframe, unbound, or a `spa.concordvoice.chat` frame inside a self-hosted view; `create` from a background primary → `not-foreground`; second concurrent `create` for one origin → `busy`; declined ceremony → `declined` and `registerService` not called; collision → `service-id-collision`; post-ceremony re-check: if the origin was registered by another path while the ceremony ran, `create` returns `{ status:'opened', serviceId }` without a second `registerService`/`openConnectionView`; `activate` unknown → `false`; `onGenerationAdvanced` → `webContents.send('connection:generation', { connectionId, generation, reason })` on the record's own webContents only.
- [ ] **Step 5: Write the failing preload bridge test** (`preloadConnectionBridge.test.ts`, pattern of `preloadTrayBridge.test.ts`): `sendSync('connection:whoAmI')` called exactly once at load; `whoAmI()` returns the cached value; `onGenerationChanged` drops a push with `generation <= cached`, delivers `generation > cached`, and the returned function removes the `ipcRenderer` listener. Update `ipcContract.test.ts:21` to `toBe(34)`; keep `toBe(19)`.
- [ ] **Step 6: Run to verify failure** — `npx vitest run tests/unit/main/ipc tests/unit/main/eslint-no-raw-ipcmain.test.ts tests/unit/main/preloadConnectionBridge.test.ts tests/unit/main/ipcContract.test.ts` → FAIL.
- [ ] **Step 7: Implement** `registry.ts`, `channelClassification.ts` (classify all 77 existing channels now — the audit will fail until 7B migrates them; mark the table complete and let 7B's commit turn the audit green), `connection.ts`, the preload namespace, the ESLint selector, `IPC_CONTRACT_VERSION = 34`, and the `connection:generation` push wiring in `main.ts`.
- [ ] **Step 8: Run to verify pass** — the suites of Steps 1, 3, 4, 5 PASS; the classification audit (Step 2) is expected to still FAIL on "raw ipcMain outside registry" until Task 7B — record that in the commit body; `npm run lint` will also report the 76 raw sites (expected, fixed in 7B). `npx vitest run tests/integration/preload-sandbox-contract.test.ts` PASS.
- [ ] **Step 9: Docs** — electron.md: new "### IPC contract v34 — connection context isolation (#86)" section listing the five new channels (table from §3.7), the six admission classes, the `registerIpc` rule, and the three-CAS-domains table (`CredentialOwner` per custody instance / `Generation` per connection / `authGeneration` renderer); § Sender-frame validation: `registerIpc` is now the only registration path, `requireConnectionSender` the only path to custody, defaultSession ⇒ saas invariant; § Accepted risk: containment is per connection; foreground `app-global-mutate` exposure equals today's single-renderer exposure (#88 re-targets).
- [ ] **Step 10: Commit**

```bash
git add desktop/src/main/ipc desktop/src/main/ipcContract.ts desktop/src/preload/preload.ts desktop/src/main/main.ts desktop/eslint.config.mjs desktop/tests/unit/main .claude/rules/domains/electron.md
git commit -m "feat: add registerIpc admission registry and connection channels for contract v34"
```

---

### Task 7B: Migrate the 77 registrations to `registerIpc` and binding-derived semantics

**Files:**
- Modify: `desktop/src/main/main.ts` (48 sites, incl. `:2254` `app:setBadgeCount`, `:2404` `selfHosted:probeServer`, `:2521` `auth:storeRefreshToken`, `:2891` `auth:getMachineId`, `:1866` `powerMonitor 'resume'`, deep-link delivery `:393-1010`), `desktop/src/main/ipc/sso.ts` (11 sites; `:115` `active` loopback map; `credentials:'include'` at `:330,:450,:472,:549`; `pendingMFA`/`pendingCompletion`/sign-in generation module state), `desktop/src/main/ipc/audiocap.ts` (2), `desktop/src/main/ipc/trayStatus.ts` (1), `desktop/src/main/ipc/windowControls.ts:29,:44` (3), `desktop/src/main/ipc/attestation.ts` (2), `billing.ts`, `openExternal.ts`, `saveImage.ts`, `versionInfo.ts`, `desktop/src/main/permissionManager.ts` (4), `desktop/src/main/spaSelfHealMainFrame.ts` (1), `desktop/src/main/ipcContract.ts` (`SelfHostedProbeResult` additive variant), `desktop/src/main/tokenManager.ts` (delete `custodyForApiBase`)
- Test: `desktop/tests/unit/main/ipc/wrongOwner.test.ts` (new), `desktop/tests/unit/main/ipc/sso.test.ts`, `desktop/tests/unit/main/audiocapIpc.test.ts`, `desktop/tests/unit/main/ipc/trayStatusIpc.test.ts`, `desktop/tests/unit/main/ipc/windowControls.test.ts`, `desktop/tests/unit/main/deepLink.test.ts`, `desktop/tests/unit/main/main.test.ts`, existing per-handler suites

**Interfaces:**
- Consumes: Task 7A `registerIpc`, `CHANNEL_CLASSES`; Task 2 `crossCheckApiBase`, `bindOwner`, `isOwnerCurrent`, `requireOwner`; Task 3 `sessionFetchFor`; Task 4 `sendToConnection`, `broadcastToPrimaries`, `openConnectionView`, `activateConnection`; Task 5 `ProfileCustody`.
- Produces:

```ts
// ipcContract.ts — additive
export type SelfHostedProbeResult = <existing union> | { status: 'opened-in-connection'; serviceId: ServiceId }
// ipc/trayStatus.ts
export function trayOwner(): ConnectionRef | null;  export function setTrayOwner(ref: ConnectionRef | null): void   // #87 redirects to the lease holder; null → foreground primary
// ipc/sso.ts — module state keyed by ConnectionId
pendingMFA: Map<ConnectionId, …>; pendingCompletion: Map<ConnectionId, …>; signInGeneration: Map<ConnectionId, number>; LoopbackHandle gains owner: ConnectionRef
// main.ts — badge
badgeByConnection: Map<ConnectionId, number>;  app.setBadgeCount(Math.min(sum, MAX_BADGE_COUNT))
```

- [ ] **Step 1: Write the failing wrong-owner table** (`wrongOwner.test.ts`) — `it.each` over every channel taking `apiBase` (`sso:appleSignIn`, `sso:googleSignIn`, `sso:completeRegistration`, `sso:completeLink`, `sso:completeMFA`, `auth:getMachineId`, `auth:storeRefreshToken`, `selfHosted:probeServer`, plus every other `apiBase`-taking channel the migration grep finds — enumerate from source): sender bound to A supplies B's origin → `{ status:'rejected', reason:'wrong-owner' }` (or the channel's existing refusal shape) **and** `net.fetch`/`session.fetch` not called, no custody write queued (`_flushDiskWritesForTesting` resolves with nothing written), `consumeCeremonyToken` not called.
- [ ] **Step 2: Write the remaining failing tests**:
  - `sso.test.ts`: `pendingMFA` set by A is invisible to B's `sso:completeMFA`; `sso:awaitCallback`/`sso:cancelLoopback` from a non-owner connection refused; the four SSO fetches go through `sessionFetchFor(sender.service)` (spy) — for `saas` the init is byte-identical to today's `{ ...init, credentials:'include' }`.
  - `selfHosted:probeServer` from the `saas` view for an approved other origin → `{ status:'opened-in-connection', serviceId }` and `activateConnection` called; the `saas` view's URL unchanged (never re-homed).
  - `audiocapIpc.test.ts`: `audiocap:start` from any registered primary succeeds and the session is `bindOwner('audiocap', ref)`; `audiocap:stop`, `audiocap:port`, `audiocap:interrupted` from another connection refused; after `advanceGeneration` on the owner the pending `start`'s post-`await` effect is dropped (superseded request).
  - `trayStatusIpc.test.ts`: `tray:setStatus` admitted from the foreground primary only; after `setTrayOwner(refB)` admitted from B only; `trayOwner()` round-trips.
  - `app:setBadgeCount`: A=3, B=4 → `app.setBadgeCount(7)`; A disposed → `4`; 9000+9000 → `9999`.
  - `windowControls.test.ts`: `window:setTitleBarOverlayColor` / `window:setClientBehavior` from a background primary → silent no-op (`undefined`, no warn).
  - `deepLink.test.ts`: a deep link with no live `saas` connection is queued (`pendingDeepLinks`) and delivered on the first `saas` primary load, never to a self-hosted primary (Review Focus 4).
  - `main.test.ts`: `powerMonitor 'resume'` calls `onSystemResume()` on every live service's custody (Review Focus 3); updater pushes (`update:rollback`, `spa:versionChanged`, `audiocap:capability`) use `broadcastToPrimaries`; `auth:token-refreshed`, `permission:changed`, `invite:received`, `deeplink:friend-code`, `pip:*`, `app:configFetchFailed` use `sendToConnection`.
  - a static test asserting `custodyForApiBase` no longer exists in `src/main/**`.
- [ ] **Step 3: Run to verify failure** — `npx vitest run tests/unit/main` → FAIL on the new tests.
- [ ] **Step 4: Migrate** every `ipcMain.*` site to `registerIpc(channel, CHANNEL_CLASSES[channel], (sender, event, …) => …)`; replace payload `apiBase` with `sender.service.origin` after `crossCheckApiBase`; replace `custodyForApiBase(...)` with `sender.custody` and delete the helper; key `sso.ts` state by `sender.ref.connectionId`; move the four SSO fetches to `sessionFetchFor`; per-connection badge map; `trayOwner` hook; audiocap owner bindings; `powerMonitor` fan-out over `liveConnections()`; deep-link `saas`-only delivery through the existing v25 carry.
- [ ] **Step 5: Run to verify pass** — `npx vitest run tests/unit/main` PASS (including Task 7A's classification audit, now green); `npm run lint` clean (ESLint ban satisfied); `npm run build:main` clean; `npx vitest run tests/unit/services` PASS.
- [ ] **Step 6: Commit**

```bash
git add desktop/src/main desktop/tests/unit/main desktop/tests/unit/services
git commit -m "refactor: route every IPC handler through registerIpc with binding-derived origins"
```

---

### Task 8: Renderer boot contract

**Files:**
- Create: `desktop/src/renderer/services/system/bootConnection.ts`, `desktop/src/renderer/components/Auth/ConnectionUnavailable.tsx`
- Modify: `desktop/src/renderer/services/system/runtimeServerBase.ts:36-75` (`getApiBase` seeded from boot identity; `setRuntimeServerBase`/`resetRuntimeServerBase` throw `Error('runtimeServerBase is boot-immutable in connection mode')` when mode is `'connection'`), `desktop/src/renderer/components/Auth/AuthFlow.tsx:121-130` (`handleServerConnect` → `connection.create`, `handleBack` → `connection.activate('saas')` in connection mode; legacy branches unchanged), `desktop/src/renderer/components/Auth/ServerInput.tsx` (handle `status: 'opened-in-connection'` as a silent success), the App root that mounts `AuthFlow` (render `ConnectionUnavailable` when mode is `'unavailable'`)
- Modify: `.claude/rules/domains/frontend.md:14` ("~47 Zustand stores (v5.0.12)" → "45 Zustand stores (v5.0.16)"), `desktop/docs/STATE_MANAGEMENT.md:84` (42 → 45 stores; "43-module" → 46 incl. `colorSyncSuppression.ts`)
- Test: `desktop/tests/unit/renderer/bootConnection.test.ts`, `desktop/tests/unit/services/runtimeServerBase.test.ts` (extend or create), `desktop/tests/unit/components/Auth/AuthFlow.connection.test.tsx`, `desktop/tests/unit/components/Auth/ConnectionUnavailable.test.tsx`

**Interfaces:**
- Consumes: Task 7A bridge `window.electron.connection`; Task 1 `parseConnectionIdentity`, `ConnectionIdentity`.
- Produces:

```ts
export type BootConnection = { mode: 'connection'; identity: ConnectionIdentity } | { mode: 'legacy' } | { mode: 'unavailable' }
export function bootConnection(): BootConnection   // memoised; bridge absent → legacy; whoAmI() null or unparsable → unavailable
export function _resetBootConnectionForTesting(): void
```

- [ ] **Step 1: Write the failing tests**:
  - `bootConnection`: no `window.electron.connection` → `legacy`; `whoAmI()` returns `null` → `unavailable`; returns a valid identity → `connection` with `identity.apiOrigin`; returns an object with an extra key → `unavailable` (fail closed).
  - `runtimeServerBase`: in connection mode `getApiBase() === identity.apiOrigin`; `setRuntimeServerBase('https://x')` throws and `getApiBase()` unchanged; in legacy mode existing behaviour (existing tests still pass).
  - `AuthFlow.connection.test.tsx`: server-input submit calls `connection.create(url)` and not `setRuntimeServerBase`; back calls `connection.activate('saas')`; in legacy mode the old calls happen.
  - `ConnectionUnavailable`: renders the heading `Connection unavailable` and never reads `import.meta.env.VITE_API_*` (assert `getApiBase` not called).
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/renderer/bootConnection.test.ts tests/unit/services/runtimeServerBase.test.ts tests/unit/components/Auth` → FAIL.
- [ ] **Step 3: Implement**; no store refactor — each connection is a separate document (§3.10).
- [ ] **Step 4: Run to verify pass** → PASS; `npm run typecheck` clean; `npx vitest run tests/unit/stores/store-reset-coverage.test.ts` PASS (no new store).
- [ ] **Step 5: Count reconciliation** — run `find desktop/src/renderer/stores -name '*Store.ts' | wc -l` (expected 45) and `find desktop/src/renderer/stores -name '*.ts' -not -name '*.test.ts' | grep -vE 'index\.ts|types\.ts' | wc -l` (expected 46 incl. `colorSyncSuppression.ts`); write the actual numbers into frontend.md:14 and STATE_MANAGEMENT.md:84 — do not assume 45 if the count differs.
- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer desktop/tests/unit .claude/rules/domains/frontend.md desktop/docs/STATE_MANAGEMENT.md
git commit -m "feat: make renderer server base boot-immutable from the connection identity"
```

---

### Task 9: Preference ownership handles (`connection:preferenceScope`)

**Files:**
- Create: `desktop/src/main/preferenceOwnership.ts`
- Modify: `desktop/src/main/tokenManager.ts` (`ProfileCustody.getAccountKey(): AccountKey | null`, `setAccountKey(key)`; `token-meta.json` gains optional `accountKey` — additive, old readers ignore it), `desktop/src/main/ipc/connection.ts` (register `connection:preferenceScope`, class `connection-bound`), `desktop/src/main/ipc/channelClassification.ts`, `desktop/src/preload/preload.ts` (`connection.preferenceScope` already declared in 7A — wire the invoke), `desktop/src/main/ipcContract.ts` (`StoreRefreshTokenInput.serverUserId?: string` additive), `desktop/src/renderer/stores/auth/userStore.ts` (pass `serverUserId` on `auth:storeRefreshToken`)
- Test: `desktop/tests/unit/main/preferenceOwnership.test.ts`, `desktop/tests/unit/services/tokenManager.test.ts` (accountKey round-trip), `desktop/tests/unit/main/ipc/connection.test.ts` (preferenceScope rows)

**Interfaces:**
- Consumes: Task 1 `AccountKey`, `PreferenceScope`, `compositeKey`; Task 2 `ConnectionRecord`, `ServiceRecord`; Task 5 `ProfileCustody`. <!-- pragma: allowlist secret -->
- Produces:

```ts
export function accountKeyFor(serviceId: ServiceId, serverUserId: string): AccountKey   // sha256(compositeKey(serviceId, serverUserId)).hex.slice(0,16)
export function preferenceScopeFor(record: ConnectionRecord, service: ServiceRecord): PreferenceScope | null   // null until service.custody.getAccountKey() !== null
export function prefsDirFor(userDataRoot: string, dirKey: string, scope: PreferenceScope): string   // <root>/profiles/<dirKey>/prefs/<accountKey>/
```

- [ ] **Step 1: Write the failing tests**: `accountKeyFor('saas','u1') !== accountKeyFor('selfhost-…','u1')`; 16 lowercase hex; `preferenceScopeFor` null before login, scope after `custody.setAccountKey`; `prefsDirFor` path is beneath `<root>/profiles/<dirKey>/` and contains no origin or user id in clear; `connection:preferenceScope` → `null` for an unauthenticated connection, the scope for an authenticated one, refused for an unbound sender; `storeRefreshToken({ …, serverUserId })` persists `accountKey` in `token-meta.json` and a meta file without the field still restores.
- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/main/preferenceOwnership.test.ts tests/unit/services/tokenManager.test.ts tests/unit/main/ipc/connection.test.ts` → FAIL.
- [ ] **Step 3: Implement**. No renderer ever receives a path; the handler returns only `{ serviceId, accountKey }`.
- [ ] **Step 4: Run to verify pass** → PASS; classification audit PASS (new channel in the table); `npm run build:main` clean.
- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/preferenceOwnership.ts desktop/src/main/tokenManager.ts desktop/src/main/ipc desktop/src/main/ipcContract.ts desktop/src/preload/preload.ts desktop/src/renderer/stores/auth/userStore.ts desktop/tests/unit
git commit -m "feat: expose per-connection preference scope handles"
```

---

### Task 10: e2e isolation spec, ADR-0051, remaining docs

**Files:**
- Create: `desktop/tests/e2e/connectionIsolation.spec.ts`, `desktop/tests/e2e/electronFixture.ts`, `desktop/tests/e2e/fixtures/controlPlaneStub.ts`, `desktop/playwright.electron.config.ts`, `docs/adr/0051-connection-context-isolation.md`
- Modify: `desktop/package.json:36` (add `"test:e2e:electron": "playwright test -c playwright.electron.config.ts"`), `desktop/tests/README.md:111` ("12 e2e specs" → 13; new "Electron e2e" paragraph)
- Reference: `desktop/playwright.config.ts` (renderer-only; unchanged), `docs/adr/0043-per-process-screen-share-audio-capture.md` (format)

**Interfaces:**
- Consumes: everything above; `@playwright/test` `_electron`; Task 0 `results/*.md`.
- Produces: `electronFixture.ts` — `test.extend<{ app: ElectronApplication; userData: string; planes: { a: StubPlane; b: StubPlane } }>()`; `controlPlaneStub.ts` — `startStubPlane(port): Promise<StubPlane>` serving `/api/v1/client-config`, login, `/api/v1/auth/refresh`, a websocket echo, and a `Set-Cookie: plane=<port>` header; both planes return **identical** `userId` and `username`.

- [ ] **Step 1: Write `playwright.electron.config.ts`** — `testDir: './tests/e2e'`, `testMatch: /connectionIsolation\.spec\.ts/`, no `webServer`, `workers: 1`, `timeout: 120_000`.
- [ ] **Step 2: Write the fixture** — `_electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, HOME: tmp } })` after `npm run build` (macOS resolves `userData` beneath `$HOME/Library/Application Support`; the fixture asserts `app.evaluate(({ app }) => app.getPath('userData'))` starts with `tmp` before any test runs — if `pinUserDataPath` resolves elsewhere, fail loudly rather than pollute the real profile). The fixture pre-writes `connections.json` (Task 6 codec) and `self-hosted-approvals.json` for both planes into that tree using `appendApprovalRecord` — never a hand-written ledger — and exposes `app.evaluate` helpers `cookiesFor(serviceId)`, `sessionOf(webContentsId)`, `generationOf(serviceId)`. No production code path reads an e2e-only environment variable. Stub-plane surface: record the bundled SPA's requests against a local dev control plane once (login → idle), then implement exactly that set in `controlPlaneStub.ts`.
- [ ] **Step 3: Write the failing spec** — one `test` per §6 assertion:
  - `cookies set by A are absent from B's jar` (`ses.cookies.get({ name:'plane' })` per service).
  - `localStorage and BroadcastChannel do not cross` (write in A via `page.evaluate`; read in B → absent; `BroadcastChannel` message posted in A not received in B).
  - `app://concord loads in a fresh fromPath session` (B's view `did-finish-load` with `url.startsWith('app://concord')`).
  - `wrong-owner electron.* call via executeJavaScript is refused` (A invokes `sso.appleSignIn(planeB.origin)` → `wrong-owner`).
  - `superseded request is refused after its await` (start `audiocap:start` in A; `reload` A mid-invoke; result rejected; no capture running).
  - `logout in A leaves B authenticated with its websocket open`.
  - `stale push after A reload is dropped` (capture generation before reload; `sendToConnection(oldRef)` via `app.evaluate` returns false).
  - `PiP opened by A is on A's session`.
  - `outage injected on A bumps no generation and leaves B untouched` (stop plane A; B's websocket still open; A's `connection:generation` not pushed).
  - `legacy SPA path`: a view with `connection` bridge removed via `evaluateOnNewDocument` boots into legacy mode (A8).
  - `duplicate-id fixture`: both planes authenticate the same `userId`; A's and B's `userStore` show different `apiOrigin`s and notifications carry distinct composite keys (A2).
- [ ] **Step 4: Run to verify failure, then pass** — `cd desktop && npm run build && npm run test:e2e:electron` → every test PASS on macOS arm64 (first run FAILs until the fixture wiring is complete). Record the run output path in the PR body.
- [ ] **Step 5: Write ADR-0051** in the ADR-0043 format: title `ADR-0051: Connection context isolation — one BaseWindow, one WebContentsView per connection, one Session per service`; `**Status:** Proposed` (until Mark signs off); Date; Deciders: Mark; Issue: Desktop#86 (child of Self-Hosted#59); Spec path; Related: #87, #88, #89, #93, Self-Hosted#113, ADR-0020, ADR-0043. Sections: Sign-off (pending), Context (§1), Decision (§2 + §3 summary; the "one trusted shell" in #86 is the main-process composition, shell renderer arrives with #88, #89 projection target is main-brokered `MessageChannelMain` ports), Options considered (A1 chosen; A2, A3, dossier B rejected with §2 reasons), Footprint (the Task 0 macOS table verbatim; Windows/Linux rows `NOT MEASURED` with reason; the §9 thresholds and the chosen `MAX_LIVE_CONNECTIONS` and `backgroundThrottling` values), Accepted notes (shared `net.fetch` TLS/HSTS cache for credential-less main calls; foreground `app-global-mutate` exposure), Consequences, Verification (the §6 negative tests by file name). Add a first line: `> ADR number provisional — re-grep docs/adr across all org checkouts before merge.`
- [ ] **Step 6: Docs** — `desktop/tests/README.md:111` → "13 e2e specs"; add the "Electron e2e" paragraph (command, what it needs: `npm run build` first, no backend — stub planes are in-process). Re-check §7 rows are all landed: electron.md (T5, T7A), frontend.md (T4, T8), e2ee.md (T5), STATE_MANAGEMENT.md (T8), self-hosted-client.md (T6), tests/README.md (here), ADR (here). Mirrors: none in Desktop (state so in the PR body).
- [ ] **Step 7: Full verification** — `npm run lint && npm run typecheck && npx vitest run --coverage` (new-code coverage ≥ 80% per the coverage report) and `npm run test:e2e:electron`; mutation spot-check: temporarily remove the `crossCheckApiBase` call in one handler and the `isOwnerCurrent` check in `audiocap:stop` — the wrong-owner table and audiocap tests must go red; restore.
- [ ] **Step 8: Commit**

```bash
git add desktop/tests/e2e desktop/playwright.electron.config.ts desktop/package.json desktop/tests/README.md docs/adr/0051-connection-context-isolation.md
git commit -m "test: add Electron e2e connection isolation spec and ADR-0051"
```

---

## Acceptance criteria (from spec §8; verified before the PR is marked ready)

| # | Criterion | Where proven |
|---|---|---|
| A1 | CVNet + A + B concurrent with separate network/auth/key/storage/async ownership | Task 10 e2e |
| A2 | Identical service-local ids cannot collide | Task 1 `compositeKey` tests; Task 10 duplicate-id fixture |
| A3 | No payload/response selects another connection's authority | Task 7B wrong-owner table; Task 2 sender matrix; Task 7B `probeServer` re-home test |
| A4 | Logout/revoke/outage/late callbacks affect one connection | Task 5 cross-instance; Task 7B superseded; Task 10 outage-no-bump |
| A5 | Session-only creds in main memory; Remember Me via `safeStorage`; Linux refusal | Task 5 parametrised suite |
| A6 | No nodeIntegration / disabled sandbox / remote code / raw IPC / widened TLS | `preload-sandbox-contract`, `browserWindowConfig.test.ts`, Task 7A ESLint + audit, no diff in TLS files |
| A7 | ADR names mechanism with measured footprint + threshold | Task 10 ADR with Task 0 numbers |
| A8 | `IPC_CONTRACT_VERSION` 34, `SPA_MIN_CONTRACT` 19, legacy SPA works | Task 7A `ipcContract.test.ts`; Task 10 legacy path |
| A9 | `pinUserDataPath` first import; new files beneath root; legacy files byte-identical | `pinUserDataPath.test.ts`; Task 6 fixtures |
| A10 | `connections.json` cannot admit unapproved origin; collision refused | Task 6; Task 2 |
| A11 | Visual verification in every theme, attached to PR | Task 4 Step 6 captures (macOS; Windows/Linux NOT CAPTURED stated) |
| A12 | Docs to update — every §7 row in the PR | Tasks 4, 5, 6, 7A, 8, 10 doc steps |
| A13 | Quality gate: 0 new blocker/critical, 0 new high-confidence hotspots, ≥80% new-code coverage | SonarCloud PR decoration (`Hosted/docs/ci/quality-gate-definition.md`) |

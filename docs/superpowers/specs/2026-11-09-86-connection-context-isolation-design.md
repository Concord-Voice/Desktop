# Connection Context Isolation (Desktop #86) — Final Spec

**Intended repo path:** `docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md` (Desktop). Committed by the implementing agent; the architect's worktree was read-only.
**Issue:** Concord-Voice/Desktop#86 — child of Self-Hosted#59. **Scope:** #86 only. UI is #88, unified projections #89, capture arbitration #87.
**Status:** Final (Phase 2 reconciliation, 2026-11-09). ADR number 0051 provisional — re-grep `docs/adr` across every org checkout immediately before merge (highest in use on 2026-11-09: 0050).
**Evidence versions:** Electron **45.0.0** (`desktop/package-lock.json`; typings from the npm tarball, `electron.d.ts` lines cited below), Zustand ^5.0.16, Playwright ^1.64.1, Vitest ^5.0.3.

---

## 0. Reconciliation record

The system-engineer's technical approach overruled six Mode-2 decisions on evidence. Each is recorded here so no reviewer re-litigates it.

| # | Conflict | Mode-2 position | System-engineer position | Winner | Why |
|---|---|---|---|---|---|
| R1 | Where the CVNet (`saas`) connection runs | New `persist:conn-saas` partition; rename root custody files into `profiles/saas/` | `saas` stays on `session.defaultSession`; root custody files untouched | **System-engineer** | (a) `machineId.ts:37` regenerates a fresh UUID if `machine-id.json` is absent — a partial 4-file rename changes `X-Machine-Id`, which server theft-detection keys on. (b) `https://spa.concordvoice.chat` localStorage/IndexedDB cannot be exported without loading a remote page on the default session; every existing user would lose ~12 `persist` stores. (c) `verifyLinuxSignature.ts:50` requires main's `net.fetch` to stay bound to the default session's trust posture; leaving `defaultSession` as the `saas` session keeps that contract untouched. (d) Downgrade is zero-loss. The cost is one invariant (§3.3) enforced structurally and by test. |
| R2 | Self-hosted session storage | `session.fromPartition('persist:conn-<serviceId>')` | `session.fromPath(<userData>/profiles/<sha256(origin)>/session)` | **System-engineer** | `fromPath` confirmed in 45.0.0 (`electron.d.ts:13219`). Co-locates Chromium state with that service's custody files so #88's Forget is one directory; keeps the 64-bit-truncated `ServiceId` out of a storage key; path is beneath the ADR-0020 pinned root by construction. |
| R3 | Shell renderer document (`shell.html`) in #86 | Ship a thin bundled shell view | No shell document in #86; main process + `BaseWindow` is the trusted shell; dev switcher is a native `Menu` in development builds only | **System-engineer, with conditions** | No consumer exists in #86; a second Vite entry plus drag-region/titlebar ownership is a visual change needing frontend seats the scout ruled out. Conditions: the ADR states that "one trusted shell" in #86 is the main-process composition, that the shell renderer arrives with #88, and that #89's projection target is reserved as main-brokered `MessageChannelMain` ports (never DOM/renderer-to-renderer). |
| R4 | Owner-bound capability primitive | `mintCapability` → unguessable token held by renderer | `bindOwner`/`isOwnerCurrent`/`requireOwner` main-held binding; bearer tokens only for renderer↔renderer proof (PiP precedent) | **System-engineer** | No in-tree flow needs the renderer to hold a secret; a main-held binding checked against the sender's `WeakMap` entry has no bearer to leak. #87's capture lease consumes this. |
| R5 | `tokenManager` per-service shape | Add leading `serviceId` to every export | Closure factory `createProfileCustody(serviceId, apiOrigin)`; module `let`s become instance fields; bodies ported verbatim; cross-profile fallback chain removed | **System-engineer** | Most literal "port, do not redesign" of the v18/v19/v21 CAS + FIFO semantics; removes the `inMemoryApiBase \|\| readActiveApiBase() \|\| DEFAULT` chain that is the root of the electron.md § v25 `nuclearReset` cross-profile deletion class. |
| R6 | Generation bump triggers | login, restore, logout, revoke, refusal/outage reset, view reload | main-frame `did-start-navigation`, `render-process-gone`/`destroyed`, custody credential-start, credential-end, dispose; **not** refresh rotation, **not** outage/reconnect | **System-engineer** | Refresh rotation preserves `CredentialOwner` (C4). Outage/reconnect are renderer-local and change no authority; the AC "outage affects only the initiating connection" is satisfied by document separation and is tested without a bump. Bumping on every credential event would leave the preload's generation stale. |
| R7 | Handler count | "75 handlers" | 77 `ipcMain.handle\|on` sites in 13 files, ~66 literal + ~10 constant channel names | **System-engineer** (verified by grep) | T7's audit enumerates from source, not from this number. |
| R8 | Additions not in Mode 2 | — | `ServiceId` collision refusal; PiP windows on the **owner's** session; per-connection OS-badge aggregation; `whoAmI === null` in a v34 SPA fails closed | **Adopted** | All four are correctness fixes: `profileIdForApiBase` truncates SHA-256 to 64 bits (`selfHostedProfile.ts:33`); PiP at `main.ts:2983` has no partition today and `BroadcastChannel` is per storage partition; the badge is window-global today; a silent fallback to `API_BASE` would re-create the single-origin ambiguity #86 removes. |

Mode-2 decisions that stand unchanged: D1 identity model (as refined in §2), D2 sender identity = `webContents` binding not URL, D3 renderer `apiBase` demoted to cross-check, D8 renderer boot contract with legacy fallback, D9 preference ownership handles, D10 ADR with measured footprint, approach **A1** (`BaseWindow` + one `WebContentsView` per connection) as the realisation of dossier option A.

---

## 1. Problem statement

The shell is one `BrowserWindow` on `session.defaultSession` loading one renderer document pointed at one API base. Renderer: `runtimeServerBase` is a mutable module singleton. Main: `inMemoryRefreshToken / inMemoryApiBase / credentialGeneration` are process-wide singletons behind one `active-profile.json` pointer (`tokenManager.ts:84-132, 196-262`). The only per-service separation is directory hashing (`profiles/<sha256(origin)>/`). Cookies, cache, storage, service workers, permission grants, the KLIPY header injector (`main.ts:1714`), the four `credentials:'include'` SSO fetches (`ipc/sso.ts:328,450,467,541`) and all 77 IPC registrations are global; `isPermittedFrameUrl` answers "is this frame on *an* allowed origin", never *which connection*. CVNet + self-hosted A + self-hosted B therefore cannot run concurrently without one overwriting or borrowing another's custody, cookies, grants and IPC authority.

## 2. Decision (what ADR-0051 records)

**Mechanism:** one `BaseWindow`; one `WebContentsView` per live connection, each on its own Chromium `Session`; main process is the trusted shell and the sole authority. `saas` runs on `session.defaultSession`; each self-hosted service runs on `session.fromPath(<userData>/profiles/<sha256(origin)>/session)`. Every privileged effect resolves its connection from the sender `WebContents` binding, never from a payload or URL. Footprint is measured by the T0 spike and recorded in the ADR with the revisit threshold.

**Rejected realisations (recorded in ADR):** A2 headless connection workers + full shell UI (scope explosion into #88/#89/#90); A3 per-connection `utilityProcess` custody (rewrites v18/v19/v21 CAS semantics across a process boundary for marginal gain; this is dossier B's custody half); dossier B main broker (maintainer decision; may be reopened only by the spike exceeding the threshold in §9).

## 3. Design

### 3.1 Identity types — `desktop/src/shared/connectionIdentity.ts` (exported for #87–#93, Self-Hosted#113)

```ts
type ServiceId    = Brand<string,'ServiceId'>;     // profileIdForApiBase(): 'saas' | `selfhost-${hex16}`
type ServiceKind  = 'saas' | 'selfhost';
type AccountKey   = Brand<string,'AccountKey'>;    // hex16(sha256(serviceId + '\0' + serverUserId))
interface AccountId { readonly serviceId: ServiceId; readonly accountKey: AccountKey }
type ConnectionId = Brand<string,'ConnectionId'>;  // 128-bit random base64url, minted in main, runtime-only, never persisted
type Generation   = Brand<number,'Generation'>;    // safe integer >= 1, strictly monotonic per ConnectionId
interface ConnectionRef { readonly connectionId: ConnectionId; readonly generation: Generation }   // #87's lease key
interface ConnectionIdentity extends ConnectionRef { readonly serviceId: ServiceId; readonly kind: ServiceKind; readonly apiOrigin: string }
type GenerationReason = 'document' | 'renderer-gone' | 'credential-start' | 'credential-end' | 'disposed';
interface PreferenceScope { readonly serviceId: ServiceId; readonly accountKey: AccountKey }       // Self-Hosted#113 handle
```

Rules: exact-key codecs + guards (`isServiceId`, `isConnectionId`, `isGeneration`, `parseConnectionIdentity`); a composite key is always `${serviceId}\0${localId}` — a test locks that no store, queue, notification or dispatch key uses a service-local id bare. Three CAS domains stay distinct (C4): `CredentialOwner` (main, per custody instance), `Generation` (main, per connection), `authGeneration` (renderer lifecycle). The spec table in electron.md v34 section states the relationship.

### 3.2 Main registry — `desktop/src/main/connectionRegistry.ts`

- `services: Map<ServiceId, ServiceRecord>`, `serviceByOrigin: Map<origin, ServiceId>`. **Invariant:** a `ServiceId` already bound to a different origin is refused with `service-id-collision`. `ServiceRecord = { serviceId, kind, origin, dirKey, session, custody }`.
- `connections: Map<ConnectionId, ConnectionRecord>`; `ConnectionRecord = { connectionId, serviceId, generation, view, webContents, pips: Set<WebContents>, state }`. One connection per `ServiceId` in v1. `MAX_LIVE_CONNECTIONS` constant (provisional 4; ≥3 is required by the CVNet+A+B AC; final value set from the spike).
- `bindings: WeakMap<WebContents, { connectionId, role: 'primary' | 'pip' }>` — object-keyed; PiP webContents bind to the opener's connection.
- `foreground: ConnectionId | null`.
- `advanceGeneration(id, reason)` is the **only** mutator and is one synchronous block: bump → revoke every older `OwnerBinding` → fire listeners.
- `connections.json` (`version: 1`, exact keys, no secrets, ≤16 entries, one FIFO writer, atomic 0o600 temp + rename): `{ serviceId, origin, addedAt, lastForegroundAt }`. Re-validated on read: origin re-canonicalises to the same `serviceId` or the entry is dropped; a self-hosted entry is admitted only if `isValidatedSelfHostedApiBase(origin)` — the approvals ledger remains the only thing that mints trust. `lastForegroundAt` restores layout only; no admission path reads it (no "active-service preference authority").

### 3.3 Sessions — `desktop/src/main/connectionSession.ts`

`configureConnectionSession(ses, service)` applies exactly once per `Session` (`WeakSet<Session>`) and replaces every `session.defaultSession.*` site in `main.ts:1567-1735`:
1. Packaged: `ses.protocol.handle('app', …)`; `SPA_CACHE_SCHEME` registered on **`saas` only** (self-hosted views never load `spa-cache://` or `https://spa.concordvoice.chat`; C7).
2. Permission request/check/device handlers delegate to injectable `captureArbiter.decide(ref | null, permission, details)`; default reproduces today's policy (deny `geolocation`, allow the rest); **unbound webContents → deny**. #87 replaces the default.
3. `select-hid-device` (WebAuthn in self-hosted views).
4. KLIPY `webRequest.onBeforeSendHeaders` bound to **this** service's custody token and origin only.
5. `web-contents-created` navigation gate resolves the binding first; permitted targets come from the connection kind; unbound fails closed.

**Invariant (R1):** nothing except the `saas` primary view and its PiPs runs on `session.defaultSession`. Billing sheet keeps its own in-memory partition (`ipcContract.ts:306`). Test: for every live `WebContents`, `wc.session === session.defaultSession ⇒ binding.serviceId === 'saas'`.

Network ownership: renderer traffic is isolated by session with no code change. The four main-process `credentials:'include'` SSO sites move to `service.session.fetch` (byte-equivalent for `saas`). `tokenManager` refresh/logout (`:833,:945`, `credentials:'omit'`) stay on `net.fetch` — shared default network stack with no cookie-jar involvement; the ADR records this as an accepted shared TLS/HSTS cache for credential-less main calls. Probe stays on `guardedRequest`. No TLS change of any kind (C8).

### 3.4 Window composition

`BaseWindow` (content protection applied before any child loads) → `contentView` children: `WebContentsView[saas]` (defaultSession; remote SPA | `spa-cache` LKG | `app://concord` per existing pins), `WebContentsView[selfhost-*]` (own session; `app://concord` only, `localhost` in dev). Every connection view uses `buildBrowserWindowConfig` `webPreferences` unchanged (`sandbox`, `contextIsolation`, no `nodeIntegration`, same preload) plus `session`. PiP `BrowserWindow`s take `webPreferences.session = owner.session`. Every `mainWindow.webContents` consumer (tray, PiP, audiocap loss wiring, deep links, content protection, window state, updater pushes) is replaced by `foregroundView()` / `sendToConnection(ref, …)` / broadcast-to-primaries as classified in T7. Dev-only switcher: native `Menu`, not in packaged builds.

### 3.5 Custody — `tokenManager.ts` closure factory

`createProfileCustody(serviceId, apiOrigin)` returns an instance holding today's module state (`diskWrites` FIFO, `credentialGeneration`, `refreshOperation`, proactive timer, `reservedCredentialOwner`, staged + in-memory E2EE keys, `cachedAccessToken`). All 23 exported function bodies are ported verbatim; `deleteFiles` uses only instance paths; the cross-profile fallback chain is removed. `active-profile.json` is still written (semantics unchanged) so a downgraded shell restores the same profile; it is never read by authorisation. Custody clears only on logout/forget, never on quit; "queued writes are not drained at quit", Linux unprotected-ciphertext refusal, value-checked fences and synchronous publish are preserved per instance. Owner numbers may collide across instances — fences never compare across instances.

### 3.6 Migration (non-destructive; runs after `pinUserDataPath` side-effect and `userDataMigration`, before `createWindow` and any custody restore)

- **P0 derive (only if `connections.json` absent):** if `active-profile.json` names an approved self-hosted origin X → set `[X]`, plus `saas` if root `token-meta.json` holds Remember-Me credentials; else `[saas]`.
- **P1 persist:** write the file; its presence is the marker.
- **Nothing is renamed, copied or deleted.** `self-hosted-approvals.json` v1 untouched (C9). Legacy files stay where they are; anything new goes under `profiles/<dirKey>/`.
- **Rollback:** older shell ignores `connections.json`, restores from `active-profile.json` at unchanged paths; only self-hosted local UI storage in new `session/` dirs is lost.
- New self-hosted connections start with default device-level UI settings (12 `persist` stores + direct `localStorage` keys) until Self-Hosted#113. **Not** seeded from `saas` (would copy one service's data into another's storage and pre-empt SH#113).

### 3.7 IPC contract v34 (`IPC_CONTRACT_VERSION` 33 → 34; `SPA_MIN_CONTRACT` stays 19)

Registration moves behind `registerIpc(channel, class, handler)` in `main/ipc/registry.ts`; an ESLint `no-restricted-syntax` rule bans raw `ipcMain.handle|on|once|handleOnce` elsewhere. Classes: **connection-bound** (returns `ConnectionRecord` + that service's custody), **app-global-read** (any registered primary), **app-global-mutate** (foreground primary only: developer mode, hardware acceleration, relaunch, `update:*`, content protection, `permission:request/openSettings`), **saas-only** (deep links, `spaState`), **pip-scoped**, **exempt-low-stakes** (`window:setTitleBarOverlayColor`, `window:setClientBehavior` gain a foreground check, else silent no-op). A checked-in classification table is snapshot-compared against the registry; an unclassified channel fails the test.

New channels:

| Channel | Direction | Shape | Admission | Failure |
|---|---|---|---|---|
| `connection:whoAmI` | `sendSync`, once at preload evaluation | → `ConnectionIdentity \| null` | registered primary or PiP **main frame**, origin allowed for its kind | `null` → v34 SPA renders fatal "connection unavailable"; **never** falls back to `API_BASE`. Legacy path applies only when the bridge method is *absent*. |
| `connection:generation` | push | `{ connectionId, generation, reason }` | owner webContents only | preload accepts only `generation >` current |
| `connection:create` | invoke | `{ origin }` → `{ status:'opened', serviceId } \| { status:'rejected', reason }` | foreground primary main frame; single-flight per origin; reuses probe + ceremony + `selfHostedCeremonyBudget` | `untrusted-sender \| not-foreground \| invalid-origin \| declined \| busy \| limit \| service-id-collision` |
| `connection:activate` | invoke | `{ serviceId }` → `boolean` | foreground primary only | `false` |
| `connection:preferenceScope` | invoke | → `PreferenceScope \| null` | connection-bound | `null` until the connection has an authenticated account |

`sendSync` is the only primitive that yields a value before the first renderer module runs; the handler is a synchronous map lookup. `webPreferences.additionalArguments` was considered and rejected: it cannot carry the generation and would create a second source of identity truth. Preload imports only `electron` (`preload-sandbox-contract.test.ts` stays green). Bridge surface: `electron.connection.{whoAmI, create, activate, onGenerationChanged, preferenceScope}`.

Changed semantics, no shape change: every channel that takes `apiBase` (`sso:*`, `auth:getMachineId`, `auth:storeRefreshToken`, `selfHosted:probeServer`, rest per T7 audit) derives it from the binding; a supplied value must canonicalise to the same origin or the handler returns `{ status:'rejected', reason:'wrong-owner' }` (or its existing refusal shape). `selfHosted:probeServer` for another origin opens/activates that connection after the ceremony and returns `reason:'opened-in-connection'` — a legacy remote SPA in the `saas` view can never re-home that view. `sso.ts` module state (`pendingMFA`, `pendingCompletion`, sign-in generation) is keyed by `ConnectionId`; loopback handles record owner `ConnectionRef`; non-owner `awaitCallback`/`cancel` refused; port arbitration stays #87's. `app:setBadgeCount` per connection, main sums (clamped 9999). `tray:setStatus` admits the foreground primary; `trayOwner()` hook lets #87 redirect to the lease holder. `audiocap:*` is the in-tree proof of the owner-binding primitive: `start` from any registered primary, session owner-bound to `ConnectionRef`; `stop`, `audiocap:port`, `audiocap:interrupted` owner-only. Deep links `saas`-only, queued via the existing v25 carry if no `saas` connection exists. Every `mainWindow.webContents.send` becomes `sendToConnection(ref, channel, payload)` which no-ops unless `ref` is current (primary defence); preload monotonic check is defence in depth; updater pushes broadcast to every primary (grant nothing).

### 3.8 Owner-binding primitive — `desktop/src/main/connectionCapability.ts` (consumed by #87)

```ts
bindOwner(kind: CapabilityKind, ref: ConnectionRef): OwnerBinding            // main-only, unforgeable object identity
isOwnerCurrent(b: OwnerBinding): boolean                                     // ref.generation === record.generation
requireOwner(event: IpcMainInvokeEvent, b: OwnerBinding): ConnectionRecord | null  // sender binding ∧ main frame ∧ current
onGenerationAdvanced(l: (id, from, to, reason) => void): () => void          // fired AFTER revocation, synchronously
```

### 3.9 Concurrency rules

Handler prologue is synchronous (no `await` before reading `event.senderFrame`, resolving the binding, capturing `ref`); after **each** `await`, `isOwnerCurrent(ref)` before any effect (generalised `audiocapRendererLossEpoch` pattern). Stated ceiling: a main-frame navigation that starts then aborts revokes the still-live document's bindings — fails closed, regression-tested. View creation order: bind → wire `wireAudiocapRendererLoss`, `attachTrayResetHooks`, `did-start-loading` deep-link reset → `loadURL` (#3394 lesson). Dispose order: `advanceGeneration('disposed')` → clear foreground → destroy PiPs → `removeChildView` → `webContents.close()`. Quit path: `isQuitting` early return (#1383) preserved on `BaseWindow` `close`; `destroyPipWindowsForQuit()` in both quit hooks; no `await` on the quit path; child webContents closed explicitly on `closed`. `connection:create` single-flight per origin with post-ceremony registry re-check. KLIPY injector reads custody synchronously per request.

### 3.10 Renderer boot contract

`runtimeServerBase` becomes boot-time immutable: the document reads `electron.connection.whoAmI()` (cached from the preload's one `sendSync`); absent → legacy single-connection path (C3); `null` → fatal screen. `setRuntimeServerBase`/`resetRuntimeServerBase` runtime callers (login-screen Self-Hosted selector) become `connection.create(origin)` / `connection.activate(serviceId)`. No store refactor: each connection is a separate document, so all 45 Zustand singletons, `websocketService`, `e2eeService`, `messageQueue` are per-connection by construction. No new store.

### 3.11 Preference ownership handles (Self-Hosted#113)

`main/preferenceOwnership.ts`: `preferenceScopeFor(record): PreferenceScope | null`, `prefsDirFor(scope) = profiles/<dirKey>/prefs/<accountKey>/`. `accountKey` derives from the authenticated user id custody records at login (if `token-meta.json` does not already hold it, T9 adds the field additively). The preferences key is the existing per-profile `preferencesKeyBase64` in `secure-e2ee.dat`, reached only through connection-bound channels. No renderer ever receives a path or key handle for another service; no "active service" preference pointer exists.

## 4. Security section (stands alone for `@security-reviewer` + `@red-team`; Desktop has no `@e2ee-reviewer`)

**Hard constraints held:** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` on every webContents including PiP and dev; no `@electron/remote`; preload imports only `electron`; no new TLS code; `setCertificateVerifyProc` untouched; `pinUserDataPath.ts` stays `main.ts`'s first import; all data beneath the pinned root; session-only credentials/keys in main memory only, Remember Me via `safeStorage`, Linux unprotected ciphertext refused; `self-hosted-approvals.json` v1 unchanged; only `commitSelfHostedApproval` mints origin trust; renderer-influenced origins route through the egress guard.

**Threat model (compromised renderer in connection A, e.g. via a malicious self-hosted API payload exploiting the bundled SPA):**

| Target | Reachable? | Enforcement |
|---|---|---|
| A's own cookies/storage/token (via existing channels) | Yes — same as today | Session + binding |
| B's or `saas` cookies, cache, storage, service workers, permission grants | No | Separate `Session` objects |
| B's custody (refresh token, E2EE keys, machine id) | No | `requireConnectionSender` → A's `ProfileCustody` only; payload `apiBase` is a cross-check; `wrong-owner` refusal with no side effect |
| B's IPC pushes / audiocap port / tray / loopback | No | `sendToConnection` + `OwnerBinding`; sso state keyed by `ConnectionId` |
| Re-home the `saas` view to a self-hosted origin | No | `probeServer` → `opened-in-connection`; `saas` view admits remote SPA origin only for kind `saas` |
| Privileged `app-global-mutate` (relaunch, update install, OS permission prompt) | Only if A is foreground — identical to today's single-renderer exposure | Accepted risk, re-stated in electron.md § Accepted risk; #88's shell re-targets this class |
| Widen TLS trust / inject `ServiceId` collision via `connections.json` | No | No TLS surface; ledger-only admission; collision refused |

**Fail-closed defaults:** unbound webContents → no IPC authority, every permission denied, navigation gate denies; `whoAmI` null → fatal, never `API_BASE`; aborted navigation revokes bindings. **No secrets** in `connections.json`; `ConnectionId` never persisted.

## 5. Decomposition

| Task | Deliverable | Depends | Parallel |
|---|---|---|---|
| T0 | Footprint + composition spike `desktop/spikes/connection-footprint/` (not CI): `app.getAppMetrics()` per pid via `getOSProcessId()` for `BaseWindow` + 0/1/2/3 views, states cold / login-idle / logged-in-idle 10 min; delta per connection; cold start `whenReady`→each `did-finish-load`; `session/` disk; idle CPU with `backgroundThrottling` true vs false; platform rows: `-webkit-app-region` drag in child view, `titleBarOverlay` hit-testing (Windows/X11), macOS `hiddenInset` traffic lights, Wayland framed chrome, hidden-view timer throttling vs websocket heartbeat, child webContents survival on `BaseWindow` close. macOS arm64 required; Windows x64 + Linux x64 for overlay/Wayland/content-protection rows. **Gates the ADR and MAX_LIVE_CONNECTIONS; the only thing that may legitimately reopen option B.** | — | first |
| T1 | `shared/connectionIdentity.ts` + codecs/guards + collision tests | — | P |
| T2 | `connectionRegistry.ts`, `connectionCapability.ts`, `requireConnectionSender`, `requireShellSender` placeholder removed (no shell doc), wrong-owner negative tests | T1 | P with T3, T5 |
| T3 | `connectionSession.ts` factory (per-session `app://`, `spa-cache` saas-only, permission handlers + `captureArbiter` hook, HID, KLIPY per service, `ses.fetch` SSO adapter, nav gate) | T1 | P |
| T4 | `BaseWindow` composition, connection views, PiP on owner session, `foregroundView()`/`sendToConnection`, dev `Menu` switcher, consumer re-targeting checklist | T0, T2, T3 | — |
| T5 | `tokenManager` closure factory; parametrised custody tests; fallback chain removed | T1 | P |
| T6 | Migration P0/P1 + `connections.json` v1 + fixture-tree tests (byte-identical legacy files) | T5 | — |
| T7 | `ipc/registry.ts`, ESLint rule, classification table + audit test, apiBase cross-check on all channels, owner-stamped pushes, `IPC_CONTRACT_VERSION = 34`, preload `connection.*` | T2, T5 | — |
| T8 | Renderer boot contract, legacy fallback, fatal-null screen, selector → create/activate | T7 | — |
| T9 | `preferenceOwnership.ts` + `connection:preferenceScope` + tests | T2, T5 | P |
| T10 | e2e `tests/e2e/connectionIsolation.spec.ts` (add Playwright `_electron` fixture — `playwright.config.ts` has none today), ADR-0051 with measurements, docs (§7) | all | — |

Sequence inside the single Desktop PR: T0 → T1 → {T2, T3, T5} → T6 → T7 → T8 → T9 → T10. No server, Hosted or Self-Hosted change. #87 consumes `ConnectionRef`, `bindOwner`, `onGenerationAdvanced`, `captureArbiter`, `trayOwner` and takes contract 35.

## 6. Test strategy (replaces the AC's nonexistent `.codex/rules/tests.md`; conventions: `desktop/tests/README.md` + `.claude/rules/domains/{electron,frontend,e2ee}.md`)

**Unit (vitest, `tests/unit/`):** identity codecs + composite keys (identical `serverUserId`/username/display name across `saas`, A, B never collide in storage, queue, notification or dispatch keys); registry mint/bump/monotonicity, `WeakMap` binding, forced `ServiceId` collision refused, live cap; `requireConnectionSender` matrix (unregistered, subframe, null `senderFrame`, `spa.concordvoice.chat` frame inside self-hosted view, `spa-cache` inside self-hosted, PiP of A acting as B, background view on `app-global-mutate`); wrong-owner table — one test per `apiBase` channel supplying B's origin from A, asserting refusal **and** no fetch / no queued write / no ceremony; owner binding stale after bump, wrong connection, revoked on dispose, listener-after-revocation ordering, aborted-navigation ceiling; `tokenManager.test.ts` parametrised over `[saas, selfhost-A, selfhost-B]` plus cross-instance (clear A leaves B's memory+files intact; A's proactive timer never touches B; same owner number across A/B never crosses `storeE2EEKeysIfOwner`/`clearTokensIfOwner`; removed fallback cannot delete the default profile); session factory (once per `Session`, `app` per session, `spa-cache` saas-only, KLIPY adds no header for B's origin in A's session, unbound → deny, defaultSession ⇒ saas invariant); migration fixtures (fresh, saas-only, self-hosted active, both, corrupt pointer, unapproved origin dropped, file present → P0 skipped, write failure; byte-identical legacy files); static audit (ESLint rule + classification snapshot).
**Keep green:** `preload-sandbox-contract.test.ts`, `pinUserDataPath.test.ts` (first import), `quitLifecycle.deadlock` re-pointed at `BaseWindow`, `main.test.ts` audiocap ordering pins.
**Integration/e2e (real Electron, `tests/e2e/connectionIsolation.spec.ts`):** two fixture control planes on `127.0.0.1:A`/`:B` returning identical user ids and usernames, `isPackaged=false`. Assert: A's cookies absent from B's jar (`ses.cookies.get`); localStorage and `BroadcastChannel` do not cross; `app://concord` loads in a fresh `fromPath` session; wrong-owner `electron.*` calls via `executeJavaScript` refused; superseded request (reload A mid-invoke) refused after its `await`; logout/revoke in A leaves B authenticated with its websocket open; stale push after A reload dropped; PiP opened by A is on A's session; outage injected on A does not touch B and bumps no generation. Full CVNet+A+B against real control planes is #93's harness.
**Coverage:** ≥80% new code; every wrong-owner, generation and collision guard has a test that turns red when the guard is removed (mutation-checked).
**Visual:** `BaseWindow` composition screenshots in every shipped theme on each platform before the PR (org rule) — the chrome changes even though no new UI ships.

## 7. Docs to update (ship in the same PR)

| Doc | Change |
|---|---|
| `docs/adr/0051-connection-context-isolation.md` (re-grep number before merge) | ADR-0043 format; Status Proposed until Mark signs off; mechanism, rejected options A2/A3/B, footprint table + threshold + measured values, shared-net.fetch accepted note, shell-deferred-to-#88 note |
| `docs/self-hosted-client.md` | Connection model, `connections.json`, session paths, default-settings-until-SH#113, downgrade behaviour |
| `.claude/rules/domains/electron.md` | New "IPC contract v34" section (channels, classes, three CAS domains table); Token Storage #1618 paragraph (session + custody per service; fallback chain removed); Sender-frame section (admission classes, `registerIpc` wrapper, defaultSession invariant); Accepted-risk section (containment per connection; foreground `app-global-mutate` exposure) |
| `.claude/rules/domains/frontend.md:14` | "~47 Zustand stores (v5.0.12)" → "45 Zustand stores (v5.0.16)"; Platform-behavior register rows from T0 |
| `.claude/rules/domains/e2ee.md` § Key Material | Per-service in-memory custody; `clearTokens` per instance |
| `desktop/docs/STATE_MANAGEMENT.md:84` | 42 → 45 (recount the "43-module" phrase) |
| `desktop/tests/README.md` | New e2e spec + Electron fixture; e2e count 12 → 13 |
| Generated mirrors of the rule files | Re-synced |

## 8. Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | CVNet + self-hosted A + B run concurrently with separate network/auth/key/storage/async ownership | e2e `connectionIsolation.spec.ts` green |
| A2 | Identical service-local IDs/usernames/display names cannot collide in storage, queues, notifications, dispatch | identity composite-key tests + e2e duplicate-id fixture |
| A3 | A service response or renderer payload cannot select another connection's origin, credentials, keys, cookies or privileged IPC authority | wrong-owner table, `requireConnectionSender` matrix, `probeServer` re-home test |
| A4 | Logout, revoke, outage, refusal and late async callbacks affect only the initiating connection | cross-instance custody tests, superseded-request test, outage-no-bump e2e |
| A5 | Session-only credentials/keys stay in main memory; Remember Me retains `safeStorage`; Linux refusal preserved | parametrised `tokenManager` suite |
| A6 | No `nodeIntegration`, disabled sandbox/contextIsolation, remote service code, arbitrary IPC or widened TLS | `preload-sandbox-contract`, `browserWindowConfig` pins, ESLint registry rule, classification audit, no diff in TLS files |
| A7 | ADR-0051 names the mechanism with measured footprint and threshold; negative tests establish isolation | ADR merged with T0 numbers; §6 negative tests |
| A8 | `IPC_CONTRACT_VERSION` = 34; `SPA_MIN_CONTRACT` = 19 unchanged; legacy remote SPA works in `saas` view | `classify-release.yml`; e2e legacy-SPA path |
| A9 | `pinUserDataPath.ts` first import; all new files beneath pinned root; legacy custody files byte-identical after migration | `pinUserDataPath.test.ts`; migration fixtures |
| A10 | `connections.json` cannot admit an unapproved origin; `ServiceId` collision refused | registry tests |
| A11 | Visual verification of `BaseWindow` composition in every theme, all platforms, attached to PR | screenshots |
| A12 | **Docs to update** — every row in §7 lands in the implementing PR; store count reconciled to 45 | docs-reviewer |
| A13 | **Quality gate** (`docs/ci/quality-gate-definition.md`; absent in Desktop — org copy at `Hosted/docs/ci/quality-gate-definition.md`): 0 new blocker/critical issues, 0 new high-confidence security hotspots, ≥80% new-code coverage | SonarCloud PR decoration |

## 9. Open items for the maintainer (decisions needed, defaults stated)

1. **Footprint revisit threshold** (ADR records whichever is chosen): proposed — >150 MB incremental private working set per idle logged-in connection, or >400 ms added cold-start per added connection, or >1% idle CPU per hidden view with throttling on. Exceeding any reopens the within-A fallback (one `BrowserWindow` per connection) before any B discussion.
2. **`MAX_LIVE_CONNECTIONS`**: proposed 4, set from T0; must be ≥3.
3. **Foreground-only `app-global-mutate`** (background connection cannot raise OS prompts or install updates): accepted by architect; #87 may widen for the lease holder.
4. **`backgroundThrottling` on hidden views**: default true; if T0 shows websocket heartbeats miss under Chromium intensive throttling, set `false` per hidden connected view and record the measured cost.

## 10. Risk register (post-panel)

| Risk | L | I | Mitigation |
|---|---|---|---|
| Custody factory port regresses v18/v19/v21 | M | Critical | Verbatim bodies; parametrised suite; CODEOWNERS security review |
| Footprint exceeds threshold at 3 connections | M | High | T0 first; within-A fallback; ADR records |
| A handler left on URL-only trust | M | Critical | ESLint ban + classification snapshot; `requireConnectionSender` is the only path to custody |
| `app://` missing on a `fromPath` session | H if forgotten | High | Factory registers per session; e2e loads `app://concord` in fresh session |
| `mainWindow.webContents` consumer routes to wrong connection | H | High | Single accessor; grep-driven checklist in T4 |
| Hidden-view throttling starves websocket/heartbeat | M | Medium | T0 row; open item 4 |
| Chrome behaviours (drag region, overlay, Wayland, content protection) differ under `BaseWindow` | M | Medium | T0 platform rows; visual verification (A11) |
| ADR number collision | L | Low | Re-grep before merge |
| Legacy remote SPA sees unknown `opened-in-connection` reason | Certain for lagging SPAs | Low | View activates the new connection; SPA's generic error sits behind it; copy owned by frontend in #88 |

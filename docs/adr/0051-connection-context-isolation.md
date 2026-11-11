# ADR-0051: Connection context isolation — one BaseWindow, one WebContentsView per connection, one Session per service

> ADR number provisional — re-grep docs/adr across all org checkouts before merge.

**Status:** Proposed (until Mark signs off — see § Sign-off)
**Date:** 2026-11-11
**Deciders:** Mark (project lead)
**Issue:** Desktop#86 (child of Self-Hosted#59)
**Spec:** `docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md`
**Related:** #87 (capture arbitration), #88 (shell UI), #89 (unified projections), #93
(multi-plane test harness), Self-Hosted#113 (per-account preference ownership), ADR-0020
(pinned `userData` root), ADR-0043 (per-process screen-share audio — the first in-tree
consumer of the owner binding this ADR introduces)

## Sign-off

**Pending.** This ADR is Proposed. It flips to Accepted only on Mark's decision, recorded
here with its scope quoted, as ADR-0043 § Sign-off did. Text asserting approval without that
record does not count.

Four values in this ADR are the maintainer's to confirm (spec §9). Each has a default that the
branch already implements:

1. **The footprint revisit thresholds** in § Footprint (150 MB, 400 ms, 1 %).
2. **`MAX_LIVE_CONNECTIONS = 4`.**
3. **Foreground-only `app-global-mutate`** (§ Accepted notes, N2).
4. **`backgroundThrottling: true` for hidden views**, including which reading of "missed
   heartbeat" applies (§ Footprint, "The two chosen values").

**What a sign-off would NOT cover.** The logged-in-idle footprint row, every Windows and Linux
row, and the drag-region row are NOT MEASURED or NOT VERIFIED (§ Footprint). The four e2e
tests marked `test.fixme` and the restored-view defect are open (§ Known gaps). Accepting the
mechanism does not retire any of them.

## Context

Before #86 the shell was one `BrowserWindow` on `session.defaultSession`, loading one renderer
document pointed at one API base. The renderer's `runtimeServerBase` was a mutable module
singleton. In main, the refresh token, its API base and the credential generation were
process-wide singletons in `tokenManager.ts` behind one `active-profile.json` pointer. The only
per-service separation was directory hashing (`profiles/<sha256(origin)>/`).

Everything else was global: cookies, cache, storage, service workers, permission grants, the
KLIPY header injector, the cookie-bearing SSO fetches, and every IPC registration.
`isPermittedFrameUrl` answered "is this frame on *an* allowed origin", never "*which*
connection is this". CVNet (`saas`) plus self-hosted A plus self-hosted B therefore could not
run at the same time without one overwriting or borrowing another's custody, cookies, grants
and IPC authority.

Two facts shaped the decision.

1. **A renderer is the unit Chromium already isolates.** Separate `Session` objects give
   separate cookie jars, caches, storage partitions, service workers and permission state with
   no application code. Separate documents make every renderer singleton (the Zustand stores,
   `websocketService`, `e2eeService`, `messageQueue`) per-connection by construction.
2. **The existing custody semantics are load-bearing and hard-won.** The compare-and-set and
   FIFO rules in `tokenManager.ts` (IPC contracts v18, v19, v21) fence credential races. A
   design that moved them across a process boundary would rewrite them.

## Decision

### D1 — Mechanism: one `BaseWindow`, one `WebContentsView` per connection, one `Session` per service

Main is the trusted shell and the only authority. `desktop/src/main/shellWindow.ts` owns one
`BaseWindow` and one `WebContentsView` child per live connection.

- **Sessions** (`desktop/src/main/connectionSession.ts`, `sessionForService`). `saas` runs on
  `session.defaultSession`. Each self-hosted service runs on
  `session.fromPath(<userData>/profiles/<dirKey>/session)`, where `dirKey` is the SHA-256 of
  the service origin. The directory sits beside that service's custody files, beneath the
  ADR-0020 pinned root. `sessionForService` throws for an unknown kind and for a `dirKey` that
  is not a single `[0-9A-Za-z_-]+` path segment.
- **Invariant R1: nothing but `saas` runs on `defaultSession`.** `assertDefaultSessionIsSaas`
  runs over every live connection's primaries and PiPs after a view is bound and before it is
  wired or loaded. A breach disposes the new connection and closes its view.
- **Web preferences.** Every view takes `buildBrowserWindowConfig`'s preferences plus its
  service's `session`. `viewPreferences` then pins `sandbox: true`, `contextIsolation: true`
  and `nodeIntegration: false` last, so no caller-supplied preference can loosen them, and
  sets `backgroundThrottling: true`.
- **Foreground.** Exactly one view is the foreground. `layoutViews` gives it the content area
  and calls `setVisible(false)` on every other view, after every geometry and foreground
  change.
- **PiP windows** are `BrowserWindow`s built on their opener's session, never on a session the
  caller names. Only the foreground connection's bound primary may open one (`pip:open` is `app-global-mutate`), so a hidden view cannot raise an always-on-top window.
- **Content protection** is applied to the `BaseWindow` at creation, before any child view is
  added.
- **Explicit teardown.** A child view's `webContents` is not destroyed when its `BaseWindow`
  closes (measured, § Footprint platform rows). The `closed` handler disposes every live
  connection and closes each `webContents` explicitly.
- **Development switcher.** A native `Menu` built only when `app.isPackaged` is false. No
  connection-switching UI ships in packaged builds from #86.

**What "one trusted shell" means in #86.** The shell is the main-process composition
described above. There is no shell renderer document. The shell renderer arrives with #88.
#89's projection target is reserved as main-brokered `MessageChannelMain` ports, never DOM
access or renderer-to-renderer messaging. Nothing for #89 is built on this branch:
`MessageChannelMain` is used only by the ADR-0043 audiocap transport.

### D2 — Identity is the sender's `webContents` binding, never a payload or a URL

`desktop/src/shared/connectionIdentity.ts` defines the types: `ServiceId` (`'saas'` or
`selfhost-<hex16>`), `ConnectionId` (128-bit random, minted in main, runtime-only, never
persisted), `Generation` (monotonic per connection), `ConnectionRef` (`connectionId` +
`generation`) and `ConnectionIdentity`. A composite key is always
`${serviceId}\0${localId}`.

`desktop/src/main/connectionRegistry.ts` holds the services, the connections, the foreground,
and a `WeakMap` from `WebContents` to its binding (`primary` or `pip`).

- **A `ServiceId` already bound to a different origin is refused** with
  `service-id-collision`. `profileIdForApiBase` keeps 64 bits of the hash, so the collision is
  refused, not assumed impossible.
- **`advanceGeneration` is the only generation mutator.** A view advances its generation on a
  main-frame `did-start-navigation` that is not same-document (`document`), on
  `render-process-gone` (`renderer-gone`), on its custody's credential events
  (`credential-start`, `credential-end`), and on dispose (`disposed`). Refresh-token rotation
  and a network outage do not advance it: neither changes authority.
- **Owner binding** (`desktop/src/main/connectionCapability.ts`): `bindOwner`,
  `isOwnerCurrent`, `requireOwner`, `onGenerationAdvanced`. The binding is held in main and
  checked against the sender's registry entry, so there is no bearer token to leak. #87's
  capture lease consumes it.
- **Pushes.** `sendToConnection(ref, channel, …)` delivers only while `ref.generation` equals
  the record's generation at send time. `broadcastToPrimaries` carries updater and SPA-version
  pushes, which grant nothing.

### D3 — Every IPC registration goes through `registerIpc` with an admission class

`desktop/src/main/ipc/registry.ts` exports `registerIpc(channel, class, handler, opts)`.
Admission is synchronous and runs before the handler:

| Class | Admits | Refusal |
|---|---|---|
| `connection-bound` | any bound primary main frame; the handler receives that connection's record and custody | `untrusted-sender` |
| `app-global-read` | any bound primary main frame | `untrusted-sender` |
| `pip-scoped` | a bound primary or PiP main frame | `untrusted-sender` |
| `app-global-mutate` | the foreground connection's primary only | `untrusted-sender`, `not-foreground` |
| `saas-only` | the `saas` primary only | `not-saas` |
| `exempt-low-stakes` | the foreground primary; a refusal is a silent `undefined` | — |

- **One sanctioned exception.** `connection:whoAmI` is a raw `ipcMain.on` in
  `ipc/connection.ts`, because `sendSync` is answered through `event.returnValue` in the same
  tick. Its admission is `requireConnectionSender`, the check `registerIpc` runs, and
  `returnValue` is always set (`null` on a throw).
- **Static enforcement.** An ESLint `no-restricted-syntax` rule bans
  `ipcMain.handle|on|once|handleOnce` outside the registry. Every channel has a row in
  `ipc/channelClassification.ts` (`CHANNEL_CLASSES`), and a test compares that table with the
  registry.
- **Contract.** `IPC_CONTRACT_VERSION` is 34. `SPA_MIN_CONTRACT` stays 19.
- **New channels.** `connection:whoAmI` (one `sendSync` at preload evaluation),
  `connection:generation` (push to the owning primary), `connection:create`,
  `connection:activate` (both `app-global-mutate`) and `connection:preferenceScope`
  (`connection-bound`).
- **`apiBase` is a cross-check, not a selector.** A handler takes the origin from the sender's
  binding. `crossCheckApiBase` refuses a supplied value that canonicalises to another origin
  with `wrong-owner`, before any dial or custody call.
- **A view cannot be re-homed.** `selfHosted:probeServer` for another origin opens or
  activates that connection and answers `opened-in-connection`.
- **`connection:create` is stricter than the spec.** The spec says single-flight per origin.
  The code allows one create at a time for the whole app, because each probe runs an
  uncancellable DNS lookup on libuv's four-slot threadpool.

### D4 — Custody is one closure instance per service

`createProfileCustody(serviceId, apiOrigin)` in `desktop/src/main/tokenManager.ts` returns an
instance holding what used to be module state. `custodyFor` caches one instance per service
and throws `service-id-collision` when a cached id is bound to a different origin.

- **Every file path an instance touches derives from its own origin.** The cross-profile
  fallback chain (`inMemoryApiBase || readActiveApiBase() || DEFAULT`) is removed. The
  transitional routing shims that bridged the intermediate commits (`liveCustody`,
  `restoreTargetCustody`, `custodyForApiBase`) no longer exist in `desktop/src`.
- **Network ownership.** The cookie-bearing SSO requests in `ipc/sso.ts` go through
  `sessionFetchFor(sender.service)`, which is that service's `session.fetch`. Refresh and
  logout in `tokenManager.ts` stay on `net.fetch` with `credentials: 'omit'` (§ Accepted
  notes, N1).
- **SSO state** (`pendingCompletion`, `pendingMFA`) is keyed by `ConnectionId`. A loopback
  handle records its owner binding.
- **KLIPY header injection** is registered per session, for
  `<service.origin>/api/v1/klipy/media*` only.
- **The tray** belongs to `trayOwner()` if #87 has set one, else to the foreground primary.
- **The OS badge** is the sum of the per-connection counts, clamped to 9999.

### D5 — The renderer's server base is fixed at boot

`desktop/src/renderer/services/system/bootConnection.ts` reads
`electron.connection.whoAmI()`, which the preload cached from its one `sendSync`.

- **Absent bridge method** → the legacy single-connection path.
- **A valid identity** → connection mode. `setRuntimeServerBase` and `resetRuntimeServerBase`
  throw: the base is boot-immutable.
- **`null`, or anything `parseConnectionIdentity` refuses** → unavailable mode. The document
  mounts `ConnectionUnavailable` and its API base is `https://connection-unavailable.invalid`.
  It never falls back to the build-time `API_BASE`.

No store was refactored and no store was added.

### D6 — Persistence and migration are additive

`connections.json` (`desktop/src/main/connectionsFile.ts`) records which connections to
restore. It holds no secrets. A self-hosted entry is admitted only if the approvals ledger
already validates its origin: the ledger remains the only thing that mints trust.
`runConnectionMigration` (`desktop/src/main/connectionMigration.ts`) derives the first file
from the legacy pointer. Nothing is renamed, copied or deleted, so an older shell restores
from `active-profile.json` at unchanged paths. `pinUserDataPath` remains `main.ts`'s first
import.

The `saas` view always opens. Persisted entries add self-hosted views. The cap in D7
therefore counts `saas`: at most three self-hosted connections are live beside it.

### D7 — `MAX_LIVE_CONNECTIONS = 4` and `backgroundThrottling: true`

Both values and their measured basis are in § Footprint.

### D8 — Preference ownership handles for Self-Hosted#113

`desktop/src/main/preferenceOwnership.ts` derives a `PreferenceScope`
(`serviceId` + `accountKey`) from the sender's binding. `connection:preferenceScope` takes no
renderer arguments and answers `null` until the connection has an authenticated account. No
consumer exists yet.

## Options considered

**A1 — `BaseWindow` + one `WebContentsView` per connection. Chosen.** It uses Chromium's own
session and process isolation, keeps the custody semantics in main unchanged in kind, and
needs no store refactor.

**A2 — headless connection workers plus a full shell UI. Rejected.** Scope explosion into
#88, #89 and #90.

**A3 — per-connection `utilityProcess` custody. Rejected.** It rewrites the v18/v19/v21
compare-and-set semantics across a process boundary for marginal gain. This is the custody
half of dossier option B.

**Dossier B — a main broker. Rejected** by maintainer decision. It may be reopened only by the
footprint spike exceeding a threshold in § Footprint. The spike did not.

**Within-A fallback — one `BrowserWindow` per connection.** Not chosen. It is the first
fallback if a threshold is ever exceeded, ahead of any discussion of B.

Sub-decisions the design panel settled, with their evidence, are in spec §0 (R1–R8). The two
that shape the mechanism: `saas` stays on `defaultSession` because moving it would regenerate
the machine id, strand the remote SPA's local storage for every existing user, and break
downgrade; self-hosted services use `fromPath`, not `fromPartition`, so that one directory
holds a service's Chromium state and its custody files.

## Footprint

Source: `desktop/spikes/connection-footprint/results/macos-arm64.md` (Task 0). Host: Apple M5
Pro, 18 logical cores, 48 GB, macOS 27.2, Electron 45.0.0, darwin arm64, 2026-11-09. The
numbers are from the production bundle served over `app://`, which the maintainer ruled
decision-grade. The dev-renderer numbers (157–168 MB per connection) are not.

### macOS arm64 — per-connection delta (copied verbatim)

A cell with two values reads `throttle=true / throttle=false`. Memory figures are medians over
3 `login-idle` reps.

| added connection | Δ private footprint MB (login-idle) | that view's renderer footprint MB | Δ working set MB (login-idle; resident, includes shared pages) | Δ cold start ms, median of 2 (min-of-reps) | idle CPU of the added view, % one core |
|---|---|---|---|---|---|
| 1st (0→1 views; includes first-view process spin-up) | **45.9 / 46.3** | 36.6 / 36.5 | 182.4 / 178.8 | first view: 298 / 197 (242 / 175) | 0.02 / 0.01 (view 0, hidden by the screen lock) |
| 2nd (1→2) | **39.9 / 40.4** | 36.5 / 36.6 | 153.7 / 151.8 | −59 / +7 (−35 / +9) | 0.01 / 0.01 |
| 3rd (2→3) | **40.3 / 40.6** | 36.5 / 36.7 | 155.8 / 149.0 | +11 / +41 (+42 / +50) | 0.01 / 0.02 |

Total private footprint across all processes at login-idle is 56.0 MB with 0 views, 101.9
with 1, 141.9 with 2 and 182.2 with 3 (`throttle=true`).

### Revisit thresholds and their evaluation (copied verbatim)

Exceeding any threshold reopens the within-A fallback before any discussion of B (spec §9).

| threshold | production measurement | verdict |
|---|---|---|
| > 150 MB incremental private working set per idle **logged-in** connection | Logged-in: NOT MEASURED. Login-idle Δ `phys_footprint`: 45.9 / 46.3 MB (1st), 39.9 / 40.4 MB (2nd), 40.3 / 40.6 MB (3rd). The renderer alone is 36.5–37.3 MB. | **Not exceeded** on the login-idle proxy. A logged-in connection has about 104–110 MB of headroom before the threshold. The logged-in row must be measured on the post-T5/T7 build before the ADR records the number as final. |
| > 400 ms added cold start per added connection | −59 to +50 ms (medians and min-of-reps); first view 175–354 ms | **Not exceeded** |
| > 1 % idle CPU per hidden view, throttling on | 0.01–0.02 % of one core | **Not exceeded** |

### What was not measured

| platform / row | result |
|---|---|
| macOS arm64, `logged-in-idle` (the state the memory threshold is written for) | NOT MEASURED — no local control plane without secrets (2026-11-09) |
| macOS arm64, a fourth view | NOT MEASURED — the spike ran 0, 1, 2 and 3 views |
| macOS arm64, `-webkit-app-region: drag` inside a child view | NOT VERIFIED — needs a real OS drag with someone at the machine |
| Windows x64, every row (footprint, cold start, idle CPU, heartbeat, `titleBarOverlay` hit-testing, content protection, drag, close survival) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Linux x64, every row (footprint, cold start, idle CPU, heartbeat, `titleBarOverlay` hit-testing on X11, Wayland framed chrome, drag, close survival) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |

The spike's own row for the unmeasured state reads:

| run set | window | reps | host compressor (end of run) |
|---|---|---|---|
| `logged-in-idle` | **NOT MEASURED — no local control plane without secrets (2026-11-09)** | — | — |

The macOS numbers do not transfer to Windows or Linux. `windows-x64.md` and `linux-x64.md` in
the same directory list the claims that stay open and how to close them.

**Two caveats on the macOS numbers.** The screen was locked for the whole production matrix,
so every view, including the foreground one, was hidden and not painting. A visible foreground
view will cost more GPU and compositor memory. And the deltas are login-idle: a logged-in
connection holds a websocket, decrypted state and populated stores, and will cost more than
the 40–46 MB measured here.

### The two chosen values

**`MAX_LIVE_CONNECTIONS = 4`** (`desktop/src/main/connectionRegistry.ts`). Basis: the delta
for the third connection is 40.3 / 40.6 MB against a 150 MB threshold, and the delta is flat
from the second connection to the third. The floor of 3 that CVNet + A + B requires holds.
**Caveat:** the value rests on the login-idle proxy, and on a three-view measurement. The
logged-in-idle row is NOT MEASURED. Re-check the value against that row when a local control
plane makes it measurable; a logged-in connection has about 104–110 MB of headroom before the
threshold.

**`backgroundThrottling: true`** for every view (`viewPreferences` in
`desktop/src/main/shellWindow.ts`). Basis: in a 10-minute run with three hidden views,
Chromium's intensive wake-up throttling stretched the 30 s page heartbeat to 60 s (maximum
gap 60.0 s; 65.0 s in the dev run). No gap reached the 120 s control-plane presence window. In
the dev runs the protocol pong and inbound frames were answered within 2 ms against the 60 s
`pongWait`. Against the server deadlines, no heartbeat was missed. The measured cost of
`false` at login-idle is not distinguishable from noise (40.4 vs 39.9 MB; 0.01–0.02 % of one
core either way).
**Caveat:** if "missed" is read as "the 30 s client cadence was not held", the rule flips to
`false`. Deadline timers in hidden views, such as the access-token refresh with its 60 s lead,
are aligned to one-minute wake-ups; that also needs the logged-in-idle row, which is NOT
MEASURED.

### macOS platform rows

- **`hiddenInset` traffic lights:** verified. They draw above the child view, on
  `defaultSession` and on a `fromPath` session.
- **Child `webContents` on `BaseWindow.close()`:** not destroyed. Both children and their
  renderer pids outlived `closed`; an explicit `webContents.close()` destroys them. D1's
  explicit teardown exists because of this row.
- **Drag region inside a child view:** NOT VERIFIED (table above).

## Accepted notes

**N1 — Shared `net.fetch` TLS/HSTS cache for credential-less main calls.** Token refresh and
logout stay on `net.fetch` with `credentials: 'omit'`. They share the default network stack,
and therefore its TLS session and HSTS caches, across services. No cookie jar is involved.
Accepted: keeping main's `net.fetch` on the default session's trust posture is what Linux
update-signature verification relies on, and no TLS code changes on this branch.

**N2 — Foreground `app-global-mutate` exposure.** A compromised **foreground** document can
still reach developer mode, hardware acceleration, relaunch, `update:*`, content protection,
`permission:request` / `openSettings` and `connection:create` / `activate`. That is the set
the single renderer could reach before #86. A **background** document cannot. Accepted; #88's
shell re-targets this class, and #87 may widen it for a capture-lease holder.

## Accepted security findings and their fixes

Three findings were raised in review of this branch, accepted, and fixed on it.

**S-1 — A background connection could start system-audio capture, and a start from B silently
replaced A's live share (MEDIUM).** `audiocap:start` was `connection-bound`.
Fix, in `desktop/src/main/ipc/audiocap.ts`:

- `audiocap:start` is `app-global-mutate`: only the foreground connection's primary may start.
- A start while **another** connection owns a live share is refused with `protocol-fault`.
  Nothing is superseded. The owner restarting its own share is still allowed.
- `audiocap:stop` is `connection-bound` and owner-only through `requireOwner`: a stop from any
  other connection, from a PiP, or from a document whose generation has advanced is refused.

#87's capture lease later replaces the refusal with a consent handoff.

**S-2 — A PiP stayed admitted after the remote SPA was turned off or moved (MEDIUM, revocation
bypass).** A PiP was checked against its own pinned remote-SPA origin whenever any current
origin existed.
Fix, in `spaOriginForSender` (`desktop/src/main/ipc/connectionSender.ts`): a PiP is admitted
for the remote SPA only while the origin pinned when it was loaded **equals the current**
remote-SPA origin. A current origin of `null` admits no remote SPA for anyone. An unpinned or
mismatched PiP fails closed.

**S-3 — The S-2 fix stranded open PiPs.** A frameless PiP whose pin went stale could no longer
call its own `pip:close`.
Fix, in `desktop/src/main/main.ts`: `closePipsPinnedToStaleOrigin` is subscribed with
`onSpaStateChange`, and `setRemoteSpaState` is the only writer of the remote-SPA origin. Every
write destroys each PiP whose pin no longer equals the current origin.

### The development-build `saas` origin pin

The `saas` service's API origin is resolved once, in main, by `pinFirstPartyApiOrigin()`
(`desktop/src/main/firstPartyOrigin.ts`), then fixed for the life of the process.

- **Packaged builds** return the production origin and read no environment variable.
- **Unpackaged builds** take the origin of `getApiBaseUrl()`, for example
  `http://localhost:8080`. A malformed override pins production, which no local server
  answers.
- The function takes no argument, so neither a renderer nor an IPC payload can name the
  origin.

`profileIdForApiBase` maps both the production origin and the pinned origin to `saas`. In an
unpackaged build the `saas` profile directory stays origin-keyed: only the production origin
uses the profile root.

### Accepted classification changes

Each row is a security decision taken in review. The table of record is
`desktop/src/main/ipc/channelClassification.ts`.

| Channel | Class on this branch | Why |
|---|---|---|
| `audiocap:start` | `app-global-mutate` | S-1 |
| `media:getDesktopSources` | `app-global-mutate` | a hidden view must not enumerate capture sources |
| `clipboard:writeText` | `app-global-mutate` | a hidden view must not replace the clipboard |
| `tray:setStatus` | `connection-bound`, narrowed in the handler to the tray owner, else the foreground primary | effective admission with no owner is unchanged; #87 only calls `setTrayOwner` |
| `attestation:get-token`, `attestation:clear-token` | `connection-bound`, narrowed in the handler to `saas` | the token cache is minted for the `saas` control plane; a non-`saas` connection neither reads nor clears it |
| `permission:changed` (push) | sent to the requesting connection only | a status change is not broadcast to other connections |
| `window:getVersionString` | `app-global-read` | primaries only |
| `app:getVersion` | `pip-scoped` | PiP documents are admitted as well as primaries |
| `billing:open`, `spa:reloadLatest`, `spa:checkForUpdate`, `deeplink:*`, `invite:renderer-ready` | `saas-only` | first-party surfaces |
| `connection:create`, `connection:activate` | `app-global-mutate` | only the foreground may open or switch a connection |

## Known gaps on this branch

These are stated so that nobody reads the ADR as claiming more than the code does.

1. **A self-hosted view restored at startup boots its first document with
   `whoAmI() === null`.** The e2e fixture measured this on every cold start. The SPA starts in
   unavailable mode, and a reload gets a valid identity. The fixture reloads once and records
   a `product-defect` annotation. The cause is not established and the defect is not fixed.
2. **Four of the eleven e2e tests are `test.fixme`**, each with its measured reason in the
   spec file: `app://concord` in a fresh `fromPath` session (the unpackaged launch registers
   no `app://`), the superseded audiocap request, the legacy SPA path (`contextBridge` freezes
   `window.electron`, so the bridge key cannot be removed), and the duplicate-id fixture (the
   stub planes do not implement the post-login bootstrap). The legacy path and the composite
   keys are covered by unit tests only.
3. **Logged-in-idle footprint, Windows, Linux and the drag region** are NOT MEASURED or NOT
   VERIFIED (§ Footprint).
4. **Dead transitional exports.** `foregroundPrimaryHandle`, `saasPrimaryHandle` and
   `PrimaryHandle` remain in `shellWindow.ts` with no caller.
5. **`tests/**` is neither type-checked nor linted** in this repo. That predates #86.

## Consequences

**Accepted costs.** One renderer process per live connection, at about 40–46 MB of private
memory each at login-idle on macOS arm64. A hard cap of four live connections, three of them
self-hosted. Hidden views run under Chromium's background throttling. Device-level UI settings
are not shared between services: a new self-hosted connection starts from defaults until
Self-Hosted#113. Every new IPC channel now needs a classification row, and the audit test
fails without one.

**What becomes easier.** Forgetting a service is one directory. A compromised document is
contained to its own connection's custody, session and generation. #87, #88 and #89 build on
`ConnectionRef`, the owner binding and `sendToConnection` without touching custody.

**What becomes harder.** Any main-process code that wants "the window's `webContents`" must
now say which connection it means. Window chrome depends on how each OS composes a child view
with a frameless window, and two of three platforms are unmeasured.

**Downgrade.** An older shell ignores `connections.json` and restores from
`active-profile.json` at unchanged paths. Only self-hosted local UI storage in the new
`session/` directories is lost.

**To revisit.** The thresholds and both chosen values when the logged-in-idle row is measured.
The Windows and Linux rows before a release ships #86 on those platforms. N2 with #88.

## Verification

Unit and integration tests (Vitest), by file under `desktop/tests/`:

- **Identity and composite keys:** `unit/shared/connectionIdentity.test.ts`
- **Registry, generations, collision, live cap:** `unit/main/connectionRegistry.test.ts`
- **Owner binding:** `unit/main/connectionCapability.test.ts`
- **Sender admission matrix and the PiP origin pin (S-2):**
  `unit/main/ipc/connectionSender.test.ts`
- **Admission classes and the classification audit:** `unit/main/ipc/registry.test.ts`,
  `unit/main/ipc/channelClassification.test.ts`, `unit/main/eslint-no-raw-ipcmain.test.ts`
- **Wrong-owner table:** `unit/main/ipc/wrongOwner.test.ts`, `unit/main/ipc/sso.test.ts`
- **Connection channels and the preload bridge:** `unit/main/ipc/connection.test.ts`,
  `unit/main/preloadConnectionBridge.test.ts`, `unit/main/ipcContract.test.ts`
- **Sessions, R1, permission and navigation gates:** `unit/main/connectionSession.test.ts`
- **Window composition, teardown, restore:** `unit/main/shellWindow.test.ts`,
  `unit/main/quitLifecycle.deadlock.test.ts`, `unit/main/main.test.ts`
- **Custody per instance and across instances:** `unit/services/tokenManager.test.ts`,
  `unit/services/tokenManager.crossInstance.test.ts`
- **Audiocap ownership (S-1):** `unit/main/audiocapIpc.test.ts`
- **Tray and attestation narrowing:** `unit/main/ipc/trayStatusIpc.test.ts`,
  `unit/main/ipc/attestation.test.ts`
- **Persistence and migration:** `unit/main/connectionsFile.test.ts`,
  `unit/main/connectionMigration.test.ts`, `unit/main/pinUserDataPath.test.ts`
- **Preference ownership:** `unit/main/preferenceOwnership.test.ts`
- **First-party origin pin:** `unit/main/apiBaseUrl.test.ts`
- **Renderer boot contract:** `unit/renderer/bootConnection.test.ts`,
  `unit/services/runtimeServerBase.test.ts`
- **Hard constraints kept green:** `integration/preload-sandbox-contract.test.ts`,
  `unit/main/browserWindowConfig.test.ts`

End to end, in real Electron: `desktop/tests/e2e/connectionIsolation.spec.ts`, run with
`npm run test:e2e:electron` after `npm run build` (see `desktop/tests/README.md`). Two
in-process stub control planes return identical user ids. Seven tests run: cookie jars,
`localStorage` and `BroadcastChannel`, a wrong-owner `electron.*` call, logout in A leaving B
authenticated, a stale push after reload, the PiP session, and an outage on A that bumps no
generation. Four are `test.fixme` (§ Known gaps, item 2). The spec was written and run on
macOS arm64 only. Full CVNet + A + B against real control planes is #93's harness.

Not automated: the visual check of the `BaseWindow` composition in every shipped theme, and
the per-platform chrome rows in § Footprint.

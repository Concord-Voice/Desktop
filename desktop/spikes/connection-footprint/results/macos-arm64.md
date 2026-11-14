# Connection footprint spike: macOS arm64 results

> **Decision-grade result (production bundle): no §9 threshold is exceeded.** Each added
> connection costs **39.9–46.3 MB** of private memory (macOS `phys_footprint`) at login-idle,
> against a 150 MB threshold. Cold start rises by **≤ 50 ms** per added connection (400 ms
> threshold). A hidden view idles at **0.01–0.02 %** of one core (1 % threshold).
>
> **History.** The first pass measured the Vite dev renderer, which Step 1 prescribes. Its
> deltas of 157–168 MB per connection exceeded the threshold, so the pass stopped. The
> maintainer then ruled on 2026-11-09 that dev-renderer numbers are not decision-grade and
> ordered a re-measure on the production build. That re-measure is the section below. The
> dev numbers are kept further down as a labelled secondary table.

**At a glance:**

- Host: Apple M5 Pro, 18 logical cores, 48 GB, macOS 27.2 (26B123). Electron **45.0.0**,
  darwin arm64.
- Date: 2026-11-09. The production matrix ran 02:40–04:10 EST. The dev matrix ran 00:56–01:48
  EST, the superseded `vite preview` runs 01:48–02:05, and the platform checks at 01:48 and
  02:05.
- Harness: `../main.mjs`.
- Tables:
  - production: `node spikes/connection-footprint/analyze.mjs results/raw-darwin-arm64.jsonl --prefix=app- --exclude=app-hb-` (the 10-minute heartbeat run: `--prefix=app-hb-`)
  - dev: `--exclude=prod-,app-`
- Raw data: every run is in `raw-darwin-arm64.jsonl`, with run-id prefixes `app-` (production),
  none (dev), `prod-` (the superseded `vite preview` attempt), `platform-*` and
  `render-proof-*`.

**CPU unit.** Electron 45's `percentCPUUsage` is a share of all 18 cores on this host:
`cumulativeCPUUsage` delta ÷ wall time ÷ `percentCPUUsage` = 18.0. All CPU figures are
**% of one core**, taken from `cumulativeCPUUsage`, over the window from +60 s after load to
the end of the run.

## Production bundle (decision-grade)

### How the shipped renderer was loaded (`--renderer=app`)

`npm run build:preload && npm run build:main && npm run build:renderer` builds the bundle,
which is then served the way a packaged build serves it:

- **Scheme:** `protocol.registerSchemesAsPrivileged` is called before `ready` with the
  `main.ts` privileges (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`).
- **Handler:** the `main.ts` `app://` handler body, i.e. the compiled real
  `resolveAppProtocolPath` from `dist/main/appProtocol.js` plus
  `net.fetch(pathToFileURL(...))`, serving `dist/renderer`.
- **Per-session registration:** the handler is registered on **each view's session** through
  `ses.protocol.handle`. `main.ts`'s global `protocol.handle` covers `defaultSession` only, so a
  `fromPath` session has no `app://` until T3 registers it (spec §10 risk, confirmed).
- **Load:** each view loads `app://concord/index.html` with the packaged `webPreferences`
  from `buildBrowserWindowConfig({ isPackaged: true })` (`webSecurity` on), the real preload,
  and the built CSP, whose loopback `connect-src` entries are stripped.
- **One IPC handler:** `auth:restoreSession` returns `{ status: 'no_session' }`. That is the
  real handler's answer for a profile with no stored credential, and it holds no credential.

**Why the first production attempt was a blank shell.** CSP was not the cause; it only refused
the loopback API fetches, which do not gate the login screen. The cause was
`auth:restoreSession` having no handler:

- The invoke rejected, so `App.tsx`'s restore effect threw before `setIsRestoring(false)`, and
  only the title bar rendered.
- The dev renderer escaped the gate only because React StrictMode runs the effect twice, and
  the second run short-circuits on `restoreSessionCalled`.
- The scheme, the origin and the preload were all fine.

### Render proof (every view reached the login screen)

**DOM proof.** Every `app-` measurement run records each view's DOM at the end of the run.
The login-screen text was present and `location.href` was `app://concord/index.html` in
**every view of every run**: 2/2, 4/4 and 6/6 in the `cold` runs, and 3/3, 6/6 and 9/9 in the
`login-idle` runs, at 1, 2 and 3 views respectively, for both throttle values. The
`--check=render-proof` runs show the same for every view of the 1-, 2- and 3-view
compositions: 73 DOM elements each, login text present.

**Visual proof.** `results/macos-prod-offscreen-session0.png`, `...-session1.png` and
`...-session2.png` show the production login screen as painted on `defaultSession` and on two
`fromPath` sessions over `app://`.

**Why the visual proof is offscreen.** The `screencapture -x` window captures could not be
made. **The screen was locked from 02:38 at the latest**: the lock screen was captured, and is
not committed because it shows the account name. Chromium does not paint while the screen is
locked, so `screencapture -l` returned only the empty window background (six identical
images, deleted). `webContents.capturePage()` failed with "Current display surface not
available for capture". The visual was therefore taken from an offscreen window on each
session, with the same `webPreferences`, preload and handler. It shows the bundle's render on
each session kind, **not** the composed `BaseWindow`.

### Durations and host state

| run set | window | reps | host compressor (end of run) |
|---|---|---|---|
| `cold` (fresh profile) | **0.5 min** after all views loaded | 2 per (views, throttle) | 1.2–1.8 GB |
| `login-idle` (warm profile) | **3.0 min** | **3** per (views, throttle), medians | 1.2–1.7 GB |
| heartbeat (`login-idle`, 3 views, throttle true) | **10.0 min** | 1 | 1.9 GB |
| `logged-in-idle` | **NOT MEASURED — no local control plane without secrets (2026-11-09)** | — | — |

Logged-in remains impossible without secrets and real custody: the harness still registers no
`auth:storeRefreshToken`.

**Host state across the 82 host samples** (start and end of each of the 41 runs):

- Compressor: 1.2–1.9 GB. At the start of the dev matrix it was 19 GB.
- Free memory: 0.1–8.3 GB.
- 1-min load: 2.1–13.9.

**Screen locked for the whole production matrix**, which has two consequences:

- With `throttle=true`, **every** view, including foreground view 0, reported `hidden`. View 0
  is therefore a hidden, non-painting view in these numbers. A visible, painting foreground
  view will cost more GPU and compositor memory.
- The per-added-connection deltas are taken over background (hidden) views, which is the
  state background connections run in.

### Per-connection delta (headline, production)

A cell with two values reads `throttle=true / throttle=false`. Memory figures are medians
over 3 `login-idle` reps.

| added connection | Δ private footprint MB (login-idle) | that view's renderer footprint MB | Δ working set MB (login-idle; resident, includes shared pages) | Δ cold start ms, median of 2 (min-of-reps) | idle CPU of the added view, % one core |
|---|---|---|---|---|---|
| 1st (0→1 views; includes first-view process spin-up) | **45.9 / 46.3** | 36.6 / 36.5 | 182.4 / 178.8 | first view: 298 / 197 (242 / 175) | 0.02 / 0.01 (view 0, hidden by the screen lock) |
| 2nd (1→2) | **39.9 / 40.4** | 36.5 / 36.6 | 153.7 / 151.8 | −59 / +7 (−35 / +9) | 0.01 / 0.01 |
| 3rd (2→3) | **40.3 / 40.6** | 36.5 / 36.7 | 155.8 / 149.0 | +11 / +41 (+42 / +50) | 0.01 / 0.02 |

**Totals.** Private footprint across all processes at login-idle is 56.0 MB with 0 views,
101.9 with 1, 141.9 with 2 and 182.2 with 3 (`throttle=true`).

**Why the working-set column is not the threshold metric.** The resident delta of 149–182 MB
counts Electron's shared framework pages once per renderer process. The §9 threshold is about
*private* memory. On macOS that is `phys_footprint`, the metric the maintainer named.

**Per-rep cold loads (ms, all views loaded):**

| views | throttle=true | throttle=false |
|---|---|---|
| 1 | 354 / 242 | 219 / 175 |
| 2 | 270 / 207 | 223 / 184 |
| 3 | 249 / 250 | 234 / 254 |

### Hidden-view throttling vs heartbeat (production, 10.0 min, 3 views, `throttle=true`)

All three views were `hidden` (the screen was locked). Gaps are measured by main from the
page's `fetch('app://concord/__spike_probe')` beats:

```
view 0: 30.2, 30.0, 30.0, 29.9, 30.1, 29.9, 38.1, 60.0, 60.0, 60.0, 60.0, 60.0
view 1: 30.2, 30.0, 30.0, 30.0, 30.0, 29.9, 38.1, 60.0, 60.0, 60.0, 60.0, 59.9
view 2: 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 38.0, 60.0, 60.0, 60.0, 60.0, 60.0
```

- **The 30 s heartbeat becomes 60 s.** Intensive wake-up throttling starts about 3.5 min
  after hide. Each view has 5 gaps over 45 s, **0 over 120 s** (the control-plane presence
  window), and a maximum gap of **60.0 s**.
- **`throttle=false` holds the cadence.** All 3-minute runs held 30 s with either setting,
  because they are too short for intensive throttling.
- **Not measured in production.** The production CSP refuses the loopback WebSocket, so this
  mode has no protocol ping/pong or app-echo probe. In the dev runs both answered within 2 ms
  under the same throttling, and that is a Chromium property, not a bundle property.

### Idle CPU and disk (production)

- **Idle CPU:** each hidden view uses **0.01–0.02 %** of one core with either throttle
  setting; the total app uses 0.03–0.07 %. **The cost of `throttle=false` is not
  distinguishable from noise** at login-idle, in CPU or in footprint (40.4 vs 39.9 MB).
- **`session/` disk** (`du -sk`, end of login-idle): view 0 (`userData` root minus `spike/`)
  is 2,444 KB; each `fromPath` session is 1,892 KB.

### §9 threshold evaluation (production, decision-grade)

| threshold | production measurement | verdict |
|---|---|---|
| > 150 MB incremental private working set per idle **logged-in** connection | Logged-in: NOT MEASURED. Login-idle Δ `phys_footprint`: 45.9 / 46.3 MB (1st), 39.9 / 40.4 MB (2nd), 40.3 / 40.6 MB (3rd). The renderer alone is 36.5–37.3 MB. | **Not exceeded** on the login-idle proxy. A logged-in connection has about 104–110 MB of headroom before the threshold. The logged-in row must be measured on the post-T5/T7 build before the ADR records the number as final. |
| > 400 ms added cold start per added connection | −59 to +50 ms (medians and min-of-reps); first view 175–354 ms | **Not exceeded** |
| > 1 % idle CPU per hidden view, throttling on | 0.01–0.02 % of one core | **Not exceeded** |

**Is any threshold exceeded on production numbers? No.** The within-A fallback is not
reopened by this spike.

### Step 5: decisions (production, decision-grade)

1. **`MAX_LIVE_CONNECTIONS = 4`.** It stays 4: the delta at 3 is 40.3 / 40.6 MB, far under
   150 MB. The ≥ 3 floor holds. Task 2's provisional 4 is validated on the login-idle proxy.
   Re-check it against the logged-in row when T5/T7 make that row measurable.

2. **`backgroundThrottling` for hidden views = `true`.** Under intensive throttling the hidden
   heartbeat stretched from 30 s to **60 s (max 60.0 s; 65.0 s in the dev run)**. No gap
   reached the 120 s presence window. The protocol pong and the inbound frames (dev runs)
   were answered within 2 ms against the 60 s `pongWait`. Against the server deadlines,
   therefore, **no heartbeat was missed**, and the Step 5 rule keeps `true`.

   **If "miss" is read as the 30 s client cadence not being held, the rule flips to
   `false`**, and its measured cost at login-idle is not distinguishable from noise.

   Still open, and needing the logged-in row: deadline timers in hidden views (the
   access-token refresh, with the 60 s lead `token_renewal.go` relies on) are aligned to
   1-minute wake-ups.

3. **Threshold exceeded? No** (production). Task 0's gate is passed on production numbers,
   subject to the logged-in caveat in item 1.

---

## Dev renderer (secondary, NOT decision-grade)

These are the Vite dev renderer numbers that Task 0 Step 1 prescribed and that stopped the
first pass. The maintainer ruled them not decision-grade. They are kept because they show a
**4–5× inflation** of each renderer's private memory in dev mode: 150–176 MB against
36–37 MB in production. Anyone measuring later on a dev build must not compare the two. The
dev §9 verdict and Step 5 below are **superseded** by the production section.

### Durations actually used (ruling 3)

| state | sampling window | reps | sample interval |
|---|---|---|---|
| `cold` (fresh profile) | **0.5 min** after all views loaded (samples at load and +30 s) | 3 per (views, throttle) | 30 s |
| `login-idle` (warm profile, login screen) | **3.0 min** for views 0–2; **10.0 min** for views 3 (heartbeat row) | 1 | 30 s |
| `logged-in-idle` | **NOT MEASURED — no local control plane without secrets (2026-11-09)** | — | — |
| production bundle (supplement) | cold **0.5 min** × 2 reps; login-idle **3.0 min** | — | 30 s |

**Why `logged-in-idle` was not measured.** The Self-Hosted dev stack was not started, for
two reasons:

1. **The stack needs a `.env`.** Compose's `:?` guards require `POSTGRES_PASSWORD`,
   `JWT_SECRET` and `MINIO_ROOT_*`, and `concord-dev.sh up` creates `.env` by copying
   `.env.example` into that worktree. Ruling 7 forbids editing that worktree.
2. **A control plane would not have been enough.** This harness registers no custody IPC, and
   `Login.tsx` fails closed when `auth:storeRefreshToken` rejects. A login cannot complete in
   the spike without fake custody, and faking it is out of scope.

The row needs the post-T5/T7 build. `--state=logged-in-idle` exits 2 by design.

### Environment caveats (read before using any number)

**The host was loaded and under memory pressure.**

- Load average was 14.0 / 29.7 / 33.9 at the start and 5.9 / 8.8 / 13.2 at the end.
- 46–47 GB of 48 GB was in use, with **19 GB in the compressor**.
- A full-screen third-party app owned the display, and other agent sessions were running.

Three things follow:

- **`workingSetSize` (resident) is unstable under compression.** For example, the login-idle
  total working set *falls* from 664.7 MB at 2 views to 515.1 MB at 3 views. It also counts
  shared framework pages once per process. **The private-memory figure used for the
  threshold is therefore `phys_footprint`** (`footprint(1)`), which includes compressed
  pages and excludes shared clean pages.
- **The cold-start reps include contention outliers** (3227, 1946 and 1774 ms). Medians *and*
  min-of-reps are both given, and every rep is listed below.
- **Visibility was checked.** View 0 stayed `visible` through every idle run, so the window
  was not occluded. Views 1 and up were `hidden` with `throttle=true`. With `throttle=false`,
  every view reports `visible`, as Electron documents.

**CPU unit.** Electron 45's `percentCPUUsage` is a share of all 18 cores on this host:
`cumulativeCPUUsage` delta ÷ wall time ÷ `percentCPUUsage` = 18.0 across processes. All CPU
figures below are **% of one core**, taken from `cumulativeCPUUsage`, over the window from
+60 s after load to the end of the run.

### Per-connection delta (headline)

All figures use the dev renderer. A cell with two values reads `throttle=true / throttle=false`.

| added connection | Δ private footprint MB (login-idle) | Δ working set MB (cold, at load) | that view's renderer footprint MB (login-idle) | Δ cold start ms, median (min-of-reps) | idle CPU of the added hidden view, % one core |
|---|---|---|---|---|---|
| 1st (0→1 views; includes first-view process spin-up) | 203.4 / 216.0 | 432.7 / 425.2 | 162.0 / 175.3 | first view: 602 / 1242 (590 / 511) | — (foreground) |
| 2nd (1→2) | **168.4 / 160.5** | 297.5 / 299.1 | 151.3 / 153.7 | 174 / −630† (170 / 73) | 0.04 / 0.04 |
| 3rd (2→3) | **156.9** / 148.7 | 264.7 / 279.2 | 150.7 / 155.1 | 204 / 268 (197 / 197) | 0.01 / 0.01 |

† The `throttle=false` 1-view median (1242 ms) is inflated by contention: its reps were 511,
1946 and 1242 ms. Min-of-reps is the better estimate there.

**Per-rep cold loads (ms, all views loaded):**

| views | throttle=true r1/r2/r3 | throttle=false r1/r2/r3 |
|---|---|---|
| 1 | 3227 / 590 / 602 | 511 / 1946 / 1242 |
| 2 | 940 / 776 / 760 | 612 / 584 / 1211 |
| 3 | 1140 / 980 / 957 | 880 / 1774 / 781 |

**Hidden views load slower with throttling on.** With `throttle=true` the hidden views load
in about 960–980 ms against about 600 ms for the visible view. Loads run in parallel, so the
wall-clock cost per added connection stays around 200 ms.

### Hidden-view throttling vs websocket heartbeat

The 10.0-minute `login-idle` run, views 3, server-measured.

| | throttle=true | throttle=false |
|---|---|---|
| Hidden views' 30 s app heartbeat | 30.0 s ×5, then **65.0, 60.0, 60.0, 60.0, 60.0, 60.0 s** (intensive wake-up throttling from about 3–4 min after hide) | 30.0 s throughout (19 gaps) |
| Gaps > 45 s (30 s cadence not held) | **6 of 11 per hidden view** | 0 |
| Gaps > 120 s (control-plane presence window) | **0** | 0 |
| Protocol ping→pong RTT (server `pingPeriod` 54 s, `pongWait` 60 s) | max 1 ms | max 1 ms |
| App-frame echo RTT (page `onmessage`) | max 1 ms | max 5 ms (view 0), 1 ms (views 1–2) |
| Foreground view 0 | 30.0 s throughout | 30.0 s throughout |

**Did the heartbeat miss under intensive throttling?** It depends on the reading:

- **No, against the server's deadlines.** No application-frame gap exceeded the 120 s presence
  window. The network service answered protocol pongs within 1 ms, well inside `pongWait`
  (60 s). Inbound frames were handled without delay.
- **Yes, against the 30 s client cadence.** The **observed interval is 60 s (max 65.0 s)**.

The 3-minute runs are too short for intensive throttling, and they all held 30 s.

### Idle CPU and disk

- **Idle CPU per hidden view** (login screen): **0.01–0.04% of one core** with
  `throttle=true`, the same with `throttle=false`. The foreground view uses 0.00–0.05%; the
  browser process 0.01–0.02%. The cost of `throttle=false` at the login screen is not
  distinguishable from noise. Logged-in idle CPU is not measured.
- **`session/` disk** (`du -sk`, end of login-idle): view 0 (`userData` root minus `spike/`)
  is 75,888 KB; each `fromPath` session is 70,140 KB. Both are dominated by the HTTP and code
  caches of the dev server's unbundled modules. The production-bundle runs give
  10,160 / 4,452 KB. Neither represents a production `app://` session after login.

### §9 threshold evaluation (dev, SUPERSEDED)

| threshold | closest measurement | verdict |
|---|---|---|
| > 150 MB incremental private working set per idle **logged-in** connection | Logged-in: NOT MEASURED. Proxy: dev renderer, login-idle, Δ `phys_footprint` = 168.4 / 160.5 MB (2nd connection) and **156.9** / 148.7 MB (3rd). The renderer process alone is 150.7–175.7 MB. | **EXCEEDED on the prescribed measurement** (3 of the 4 N≥2 increments, including the default `throttle=true` at 3). A logged-in renderer does strictly more than the login screen, so for this renderer build the proxy is a lower bound. The production cost is unmeasured: it sits between the 37 MB blank-shell floor and the dev figure. |
| > 400 ms added cold start per added connection | median 174 / 204 ms (`throttle=true`), 268 ms (`throttle=false`, 2→3); min-of-reps 73–197 ms | not exceeded (noisy host; see the per-rep table) |
| > 1% idle CPU per hidden view, throttling on | 0.01–0.04% of one core (login screen) | not exceeded (logged-in idle not measured) |

### Step 5: decisions (dev, SUPERSEDED by the production section)

1. **Was any threshold exceeded? YES: memory, on the prescribed measurement.** Task 0 stops
   here. Per §2 and §9 this reopens the within-A fallback (one `BrowserWindow` per
   connection) before Task 4. That is for the orchestrator and maintainer to rule on.

   Observation for that ruling: the cost is almost entirely the per-connection **renderer
   process**, about 150–176 MB of the 157–168 MB increment. Within-A also runs one renderer
   per connection, so this measurement does not show that within-A would be cheaper. The
   figure that would settle the question is a production-bundle *logged-in* footprint, which
   needs the post-T5/T7 custody build and a control plane.

2. **`MAX_LIVE_CONNECTIONS`: not set by this spike.** Step 5 keeps it at 4 "unless the delta
   at 3 exceeds threshold", and on the prescribed measurement it does. The Task 2 default of
   4 therefore stays **provisional, not validated**, pending the ruling above. The ≥ 3 floor
   from §9 item 2 is unchanged. For scale: 3 dev-renderer connections measured 584.4 MB total
   footprint (`throttle=true`).

3. **`backgroundThrottling` for hidden views: `true`.** The rule in §9 item 4 and Step 5 is
   "true unless heartbeat misses were observed". With throttling on:
   - no application-frame gap crossed the 120 s presence window;
   - protocol pongs (`pongWait` 60 s) and inbound frames were answered within 1 ms;
   - the 30 s cadence stretched to **60 s (max 65.0 s)** from about 3–4 min after hide.

   The cost of `false` was not distinguishable from noise at the login screen (CPU) and was
   not separable in memory under compression.

   **If the orchestrator reads "miss" as the 30 s cadence not being held, the rule flips this
   to `false`.** The evidence above supports either reading. Also unmeasured: timers that
   carry a deadline, such as access-token refresh, are aligned to 1-minute wake-ups in hidden
   views. `token_renewal.go` relies on a 60 s client refresh lead, so a hidden throttled
   connection could renew late. That needs the logged-in row.


## macOS platform rows (manual, captured)

| row | result | evidence |
|---|---|---|
| `hiddenInset` traffic lights vs a full-bounds child view | **Verified.** The traffic lights draw *above* the child view, at the same position as in `BrowserWindow`. The child view extends under the title-bar band, as `hiddenInset` content does today. This holds for view 0 (`defaultSession`) and, after a foreground switch, for view 1 (`fromPath`). | `macos-hiddeninset-child-view.png` (window inactive, so grey lights), `macos-drag-strip-view0.png`, `macos-drag-strip-view1.png` (lights in colour over the red strip) |
| `-webkit-app-region: drag` works inside a child view | **NOT VERIFIED.** The strip renders in both child views (captures), but only a real OS drag exercises the native hit test. Synthetic `CGEvent` drags (`--drag=true`, with a `BrowserWindow` control) were **withheld**: a full-screen app owned the display, so the events would have landed in it. To verify, run `--check=platform --drag=true` with someone at the machine. | `macos-drag-strip-view0.png`, `macos-drag-strip-view1.png` |
| child webContents destroyed on `BaseWindow.close()` | **Not destroyed.** At +0 ms and +3000 ms after `closed`, both children report `isDestroyed() === false`, their renderer pids are alive, and `webContents.getAllWebContents().length === 2`. An explicit `webContents.close()` destroys them: `isDestroyed() === true`, the pids are gone, the count is 0, and `view.webContents` then reads `undefined`. This matches Electron's BaseWindow "Resource management" note. **T4 must close every view's webContents on `closed`.** | `raw-darwin-arm64.jsonl` run `platform-macos-2`. Run `platform-macos` hit a harness bug in the post-close probe (the `undefined` property); it was fixed and re-run, and both runs' lines are kept. |
| `titleBarOverlay` hit-testing | N/A on macOS (Windows/X11 only) | `windows-x64.md`, `linux-x64.md` |
| Wayland framed chrome | N/A on macOS | `linux-x64.md` |

## Superseded: first production attempt (`vite build` + `vite preview :3002`)

These are runs prefixed `prod-` in the raw JSONL. The renderer stalled at a blank shell: the title bar only, 32 DOM elements. **The root cause was the missing `auth:restoreSession` handler, not CSP** (see § How the shipped renderer was loaded). Its 33–38 MB per-renderer floor is close to the production login-screen figure (36–37 MB). The appendix keeps its tables; do not use them.

## Appendix A: analyzer output, production bundle (`app-` runs, decision-grade)

Source: `raw-darwin-arm64.jsonl` (runs prefixed `app-`, excluding `app-hb-`); per-rep rows in the CPU, heartbeat and disk tables are the 3 login-idle reps. The cold-state footprint deltas come from a 0.5-min window and 2 reps, so they are noisier than login-idle. Every `app-` run reports `login screen reached` in the memory table.

#### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)

| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |
|---|---|---|---|---|---|
| true | 0 | 2 | — | — | — |
| true | 1 | 2 | 298 | 298 | 298 |
| true | 2 | 2 | 238 / 239 | 239 | -59 |
| true | 3 | 2 | 250 / 250 / 250 | 250 | 11 |
| false | 0 | 2 | — | — | — |
| false | 1 | 2 | 197 | 197 | 197 |
| false | 2 | 2 | 203 / 204 | 204 | 7 |
| false | 3 | 2 | 241 / 242 / 244 | 244 | 41 |

#### Memory: workingSetSize (MB), sum over every app process

`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint | login screen reached (views, all reps) | host compressor GB (end, median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | true | 0 | 0.5,0.5 | 137.9 | 137.9 | 0.0 | 0.0 | 0.0 | — | 60.2 | — | — | — | 1.7 |
| cold | true | 1 | 0.5,0.5 | 434.1 | 176.1 | 66.6 | 47.6 | 143.8 | 296.2 | 135.2 | 75.0 | 41.0 | 2/2 | 1.8 |
| cold | true | 2 | 0.5,0.5 | 585.1 | 182.4 | 66.7 | 48.2 | 287.8 | 151.0 | 183.0 | 47.8 | 40.9 / 39.7 | 4/4 | 1.3 |
| cold | true | 3 | 0.5,0.5 | 746.0 | 189.7 | 66.9 | 49.0 | 440.4 | 160.9 | 227.9 | 44.9 | 40.9 / 41.9 / 38.8 | 6/6 | 1.2 |
| cold | false | 0 | 0.5,0.5 | 138.6 | 138.6 | 0.0 | 0.0 | 0.0 | — | 88.2 | — | — | — | 1.2 |
| cold | false | 1 | 0.5,0.5 | 433.1 | 175.5 | 66.5 | 47.5 | 143.6 | 294.5 | 140.0 | 51.8 | 40.8 | 2/2 | 1.2 |
| cold | false | 2 | 0.5,0.5 | 584.8 | 181.9 | 66.7 | 48.1 | 288.1 | 151.7 | 156.9 | 16.9 | 41.1 / 41.0 | 4/4 | 1.5 |
| cold | false | 3 | 0.5,0.5 | 748.4 | 189.1 | 66.9 | 48.9 | 443.5 | 163.6 | 208.5 | 51.5 | 39.0 / 39.1 / 39.1 | 6/6 | 1.6 |
| login-idle | true | 0 | 3.0,3.0,3.0 | 253.3 | 144.7 | 65.6 | 43.0 | 0.0 | — | 56.0 | — | — | — | 1.7 |
| login-idle | true | 1 | 3.0,3.0,3.0 | 435.7 | 172.9 | 66.9 | 47.0 | 148.5 | 182.4 | 101.9 | 45.9 | 36.6 | 3/3 | 1.3 |
| login-idle | true | 2 | 3.0,3.0,3.0 | 589.3 | 177.5 | 67.1 | 47.5 | 297.1 | 153.7 | 141.9 | 39.9 | 37.1 / 36.5 | 6/6 | 1.3 |
| login-idle | true | 3 | 3.0,3.0,3.0 | 745.2 | 183.3 | 67.3 | 48.0 | 446.7 | 155.8 | 182.2 | 40.3 | 37.3 / 37.0 / 36.5 | 9/9 | 1.2 |
| login-idle | false | 0 | 3.0,3.0,3.0 | 252.9 | 144.4 | 65.5 | 43.0 | 0.0 | — | 55.6 | — | — | — | 1.2 |
| login-idle | false | 1 | 3.0,3.0,3.0 | 431.7 | 172.8 | 66.9 | 47.0 | 145.0 | 178.8 | 101.8 | 46.3 | 36.5 | 3/3 | 1.5 |
| login-idle | false | 2 | 3.0,3.0,3.0 | 583.5 | 177.7 | 67.0 | 47.6 | 291.2 | 151.8 | 142.2 | 40.4 | 36.8 / 36.6 | 6/6 | 1.6 |
| login-idle | false | 3 | 3.0,3.0,3.0 | 732.5 | 180.6 | 67.3 | 48.0 | 436.3 | 149.0 | 182.8 | 40.6 | 36.6 / 36.8 / 36.7 | 9/9 | 1.6 |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core, median of reps

| throttle | views | reps | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|---|
| true | 0 | 3 | 120 | — | — | 0.01 | 0.00 | 0.00 | 0.01 |
| true | 1 | 3 | 120 | 0.02 | — | 0.01 | 0.00 | 0.00 | 0.03 |
| true | 2 | 3 | 120 | 0.00 | 0.01 | 0.02 | 0.00 | 0.00 | 0.04 |
| true | 3 | 3 | 120 | 0.00 | 0.02 / 0.01 | 0.02 | 0.00 | 0.00 | 0.05 |
| false | 0 | 3 | 120 | — | — | 0.01 | 0.00 | 0.00 | 0.01 |
| false | 1 | 3 | 120 | 0.01 | — | 0.02 | 0.00 | 0.00 | 0.04 |
| false | 2 | 3 | 120 | 0.01 | 0.01 | 0.02 | 0.00 | 0.00 | 0.04 |
| false | 3 | 3 | 120 | 0.02 | 0.01 / 0.02 | 0.02 | 0.00 | 0.00 | 0.07 |

#### Heartbeat probe (login-idle). App heartbeat = 30 s setInterval in the page; server-measured gaps.

| throttle | views | view | visibility seen | hb count | max hb gap s | gaps > 45 s | gaps > 120 s (presence window) | max pong RTT ms | max app echo RTT ms |
|---|---|---|---|---|---|---|---|---|---|
| true | 1 | 0 | hidden | 6 | 30.1 | 0 | 0 | — | — |
| true | 1 | 0 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 1 | 0 | hidden | 5 | 30.0 | 0 | 0 | — | — |
| true | 2 | 0 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 2 | 1 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 2 | 0 | hidden | 5 | 30.2 | 0 | 0 | — | — |
| true | 2 | 1 | hidden | 5 | 30.2 | 0 | 0 | — | — |
| true | 2 | 0 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 2 | 1 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 0 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 1 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 2 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 0 | hidden | 5 | 30.0 | 0 | 0 | — | — |
| true | 3 | 1 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 2 | hidden | 5 | 30.0 | 0 | 0 | — | — |
| true | 3 | 0 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 1 | hidden | 5 | 30.1 | 0 | 0 | — | — |
| true | 3 | 2 | hidden | 5 | 30.0 | 0 | 0 | — | — |
| false | 1 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 1 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 1 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 2 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 2 | 1 | visible | 6 | 30.2 | 0 | 0 | — | — |
| false | 2 | 0 | visible | 6 | 30.2 | 0 | 0 | — | — |
| false | 2 | 1 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 2 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 2 | 1 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 1 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 2 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 0 | visible | 6 | 30.0 | 0 | 0 | — | — |
| false | 3 | 1 | visible | 6 | 30.0 | 0 | 0 | — | — |
| false | 3 | 2 | visible | 6 | 30.0 | 0 | 0 | — | — |
| false | 3 | 0 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 1 | visible | 6 | 30.1 | 0 | 0 | — | — |
| false | 3 | 2 | visible | 6 | 30.1 | 0 | 0 | — | — |

#### Heartbeat gap sequence (s), throttle=true views=3 hidden views

- app-idle-v3-ttrue-r1 view 0: first@31s, 29.8, 30.1, 30.1, 30.0
- app-idle-v3-ttrue-r1 view 1: first@31s, 30.0, 30.1, 30.1, 30.0
- app-idle-v3-ttrue-r1 view 2: first@31s, 30.0, 30.1, 30.1, 30.0
- app-idle-v3-ttrue-r2 view 0: first@31s, 30.0, 30.0, 30.0, 30.0
- app-idle-v3-ttrue-r2 view 1: first@31s, 30.0, 29.9, 30.1, 29.9
- app-idle-v3-ttrue-r2 view 2: first@31s, 30.0, 30.0, 30.0, 30.0
- app-idle-v3-ttrue-r3 view 0: first@31s, 30.0, 29.9, 30.1, 30.0
- app-idle-v3-ttrue-r3 view 1: first@31s, 30.0, 30.0, 30.0, 30.1
- app-idle-v3-ttrue-r3 view 2: first@31s, 30.0, 30.0, 30.0, 30.0
- app-idle-v3-tfalse-r1 view 0: first@30s, 29.9, 30.1, 30.0, 30.0, 29.9
- app-idle-v3-tfalse-r1 view 1: first@30s, 29.9, 30.1, 30.0, 30.0, 29.9
- app-idle-v3-tfalse-r1 view 2: first@30s, 29.9, 30.1, 30.0, 30.0, 29.9
- app-idle-v3-tfalse-r2 view 0: first@31s, 30.0, 30.0, 30.0, 30.0, 29.8
- app-idle-v3-tfalse-r2 view 1: first@31s, 30.0, 30.0, 30.0, 30.0, 29.8
- app-idle-v3-tfalse-r2 view 2: first@31s, 30.0, 30.0, 30.0, 30.0, 29.8
- app-idle-v3-tfalse-r3 view 0: first@30s, 29.9, 30.1, 30.0, 30.0, 29.8
- app-idle-v3-tfalse-r3 view 1: first@30s, 29.9, 30.1, 30.0, 30.0, 29.8
- app-idle-v3-tfalse-r3 view 2: first@30s, 29.9, 30.1, 30.0, 30.0, 29.8

#### session/ disk (du -sk, KB) at end of login-idle runs

| throttle | views | per view (view 0 = userData root minus spike/) |
|---|---|---|
| true | 1 | 2444 |
| true | 1 | 2444 |
| true | 1 | 2444 |
| true | 2 | 2444 / 1892 |
| true | 2 | 2444 / 1892 |
| true | 2 | 2444 / 1892 |
| true | 3 | 2460 / 1892 / 1892 |
| true | 3 | 2444 / 1892 / 1892 |
| true | 3 | 2444 / 1892 / 1892 |
| false | 1 | 2444 |
| false | 1 | 2444 |
| false | 1 | 2444 |
| false | 2 | 2444 / 1892 |
| false | 2 | 2444 / 1892 |
| false | 2 | 2444 / 1892 |
| false | 3 | 2444 / 1892 / 1892 |
| false | 3 | 2444 / 1892 / 1892 |
| false | 3 | 2444 / 1892 / 1892 |

## Appendix B: analyzer output, production 10-minute heartbeat run (`app-hb-v3-ttrue-m10`)

Source: `raw-darwin-arm64.jsonl` (run `app-hb-v3-ttrue-m10`)

#### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)

| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |
|---|---|---|---|---|---|

#### Memory: workingSetSize (MB), sum over every app process

`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint | login screen reached (views, all reps) | host compressor GB (end, median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| login-idle | true | 3 | 10.0 | 746.3 | 183.8 | 67.4 | 47.9 | 447.2 | — | 182.6 | — | 36.5 / 36.9 / 37.1 | 3/3 | 1.9 |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core, median of reps

| throttle | views | reps | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|---|
| true | 3 | 1 | 540 | 0.00 | 0.01 / 0.00 | 0.02 | 0.00 | 0.00 | 0.04 |

#### Heartbeat probe (login-idle). App heartbeat = 30 s setInterval in the page; server-measured gaps.

| throttle | views | view | visibility seen | hb count | max hb gap s | gaps > 45 s | gaps > 120 s (presence window) | max pong RTT ms | max app echo RTT ms |
|---|---|---|---|---|---|---|---|---|---|
| true | 3 | 0 | hidden | 13 | 60.0 | 5 | 0 | — | — |
| true | 3 | 1 | hidden | 13 | 60.0 | 5 | 0 | — | — |
| true | 3 | 2 | hidden | 13 | 60.0 | 5 | 0 | — | — |

#### Heartbeat gap sequence (s), throttle=true views=3 hidden views

- app-hb-v3-ttrue-m10 view 0: first@31s, 30.2, 30.0, 30.0, 29.9, 30.1, 29.9, 38.1, 60.0, 60.0, 60.0, 60.0, 60.0
- app-hb-v3-ttrue-m10 view 1: first@31s, 30.2, 30.0, 30.0, 30.0, 30.0, 29.9, 38.1, 60.0, 60.0, 60.0, 60.0, 59.9
- app-hb-v3-ttrue-m10 view 2: first@31s, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 38.0, 60.0, 60.0, 60.0, 60.0, 60.0

#### session/ disk (du -sk, KB) at end of login-idle runs

| throttle | views | per view (view 0 = userData root minus spike/) |
|---|---|---|
| true | 3 | 2444 / 1892 / 1892 |

## Appendix C: analyzer output, dev renderer (secondary)

Source: `raw-darwin-arm64.jsonl` (runs excluding `prod-` and `app-`). These runs predate the render proof, so `login screen reached` reads "not recorded". A separate check found the dev login screen rendered (187 DOM elements).

#### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)

| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |
|---|---|---|---|---|---|
| true | 0 | 3 | — | — | — |
| true | 1 | 3 | 602 | 602 | 602 |
| true | 2 | 3 | 513 / 776 | 776 | 174 |
| true | 3 | 3 | 595 / 980 / 980 | 980 | 204 |
| false | 0 | 3 | — | — | — |
| false | 1 | 3 | 1242 | 1242 | 1242 |
| false | 2 | 3 | 596 / 612 | 612 | -630 |
| false | 3 | 3 | 862 / 880 / 880 | 880 | 268 |

#### Memory: workingSetSize (MB), sum over every app process

`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint | login screen reached (views, all reps) | host compressor GB (end, median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | true | 0 | 0.5,0.5,0.5 | 138.9 | 138.9 | 0.0 | 0.0 | 0.0 | — | 59.3 | — | — | — | — |
| cold | true | 1 | 0.5,0.5,0.5 | 571.6 | 174.5 | 69.1 | 61.0 | 267.0 | 432.7 | 255.6 | 196.3 | 144.9 | not recorded | — |
| cold | true | 2 | 0.5,0.5,0.5 | 869.1 | 174.9 | 95.0 | 63.3 | 536.0 | 297.5 | 400.1 | 144.6 | 151.0 / 137.8 | not recorded | — |
| cold | true | 3 | 0.5,0.5,0.5 | 1133.8 | 180.0 | 95.9 | 65.4 | 791.6 | 264.7 | 545.3 | 145.2 | 149.8 / 136.7 / 136.8 | not recorded | — |
| cold | false | 0 | 0.5,0.5,0.5 | 139.0 | 139.0 | 0.0 | 0.0 | 0.0 | — | 59.3 | — | — | — | — |
| cold | false | 1 | 0.5,0.5,0.5 | 564.1 | 169.2 | 67.3 | 60.9 | 266.9 | 425.2 | 257.9 | 198.6 | 152.2 | not recorded | — |
| cold | false | 2 | 0.5,0.5,0.5 | 863.2 | 174.8 | 85.0 | 69.4 | 531.4 | 299.1 | 400.8 | 142.9 | 145.4 / 140.3 | not recorded | — |
| cold | false | 3 | 0.5,0.5,0.5 | 1142.4 | 180.9 | 90.9 | 75.6 | 794.9 | 279.2 | 547.9 | 147.1 | 144.0 / 139.5 / 139.4 | not recorded | — |
| login-idle | true | 0 | 3.0 | 252.8 | 144.1 | 65.9 | 42.9 | 0.0 | — | 55.7 | — | — | — | — |
| login-idle | true | 1 | 3.0 | 365.2 | 129.7 | 60.8 | 48.2 | 126.4 | 112.4 | 259.1 | 203.4 | 162.0 | not recorded | — |
| login-idle | true | 2 | 3.0 | 664.7 | 149.6 | 65.8 | 51.6 | 397.6 | 299.6 | 427.6 | 168.4 | 175.6 / 151.3 | not recorded | — |
| login-idle | true | 3 | 10.0 | 515.1 | 130.9 | 57.9 | 48.1 | 278.1 | -149.6 | 584.4 | 156.9 | 175.7 / 151.6 / 150.7 | not recorded | — |
| login-idle | false | 0 | 3.0 | 238.1 | 135.3 | 62.1 | 40.7 | 0.0 | — | 55.6 | — | — | — | — |
| login-idle | false | 1 | 3.0 | 613.8 | 175.1 | 76.4 | 57.8 | 304.4 | 375.7 | 271.6 | 216.0 | 175.3 | not recorded | — |
| login-idle | false | 2 | 3.0 | 911.0 | 187.7 | 75.5 | 62.5 | 585.3 | 297.2 | 432.0 | 160.5 | 175.5 / 153.7 | not recorded | — |
| login-idle | false | 3 | 10.0 | 518.5 | 131.4 | 57.2 | 49.5 | 280.3 | -392.5 | 580.7 | 148.7 | 157.7 / 155.2 / 155.1 | not recorded | — |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core, median of reps

| throttle | views | reps | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|---|
| true | 0 | 1 | 120 | — | — | 0.02 | 0.01 | 0.00 | 0.02 |
| true | 1 | 1 | 120 | 0.05 | — | 0.02 | 0.01 | 0.00 | 0.08 |
| true | 2 | 1 | 120 | 0.00 | 0.04 | 0.02 | 0.00 | 0.00 | 0.07 |
| true | 3 | 1 | 540 | 0.00 | 0.01 / 0.01 | 0.02 | 0.00 | 0.00 | 0.05 |
| false | 0 | 1 | 120 | — | — | 0.01 | 0.00 | 0.00 | 0.01 |
| false | 1 | 1 | 120 | 0.00 | — | 0.02 | 0.00 | 0.00 | 0.03 |
| false | 2 | 1 | 120 | 0.00 | 0.04 | 0.02 | 0.00 | 0.00 | 0.07 |
| false | 3 | 1 | 540 | 0.00 | 0.01 / 0.01 | 0.02 | 0.00 | 0.01 | 0.06 |

#### Heartbeat probe (login-idle). App heartbeat = 30 s setInterval in the page; server-measured gaps.

| throttle | views | view | visibility seen | hb count | max hb gap s | gaps > 45 s | gaps > 120 s (presence window) | max pong RTT ms | max app echo RTT ms |
|---|---|---|---|---|---|---|---|---|---|
| true | 1 | 0 | visible,hidden | 6 | 30.2 | 0 | 0 | 2 | 1 |
| true | 2 | 0 | visible,hidden | 6 | 30.0 | 0 | 0 | 1 | 1 |
| true | 2 | 1 | hidden | 5 | 30.0 | 0 | 0 | 1 | 0 |
| true | 3 | 0 | visible,hidden | 20 | 30.0 | 0 | 0 | 1 | 1 |
| true | 3 | 1 | hidden | 12 | 65.0 | 6 | 0 | 1 | 1 |
| true | 3 | 2 | hidden | 12 | 65.0 | 6 | 0 | 1 | 1 |
| false | 1 | 0 | visible | 6 | 30.0 | 0 | 0 | 1 | 1 |
| false | 2 | 0 | visible | 6 | 30.0 | 0 | 0 | 1 | 3 |
| false | 2 | 1 | visible | 6 | 30.0 | 0 | 0 | 0 | 0 |
| false | 3 | 0 | visible | 20 | 30.0 | 0 | 0 | 1 | 5 |
| false | 3 | 1 | visible | 20 | 30.0 | 0 | 0 | 1 | 1 |
| false | 3 | 2 | visible | 20 | 30.0 | 0 | 0 | 1 | 1 |

#### Heartbeat gap sequence (s), throttle=true views=3 hidden views

- idle-v3-ttrue-m10 view 0: first@31s, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0
- idle-v3-ttrue-m10 view 1: first@32s, 30.0, 30.0, 30.0, 30.0, 30.0, 65.0, 60.0, 60.0, 60.0, 60.0, 60.0
- idle-v3-ttrue-m10 view 2: first@32s, 30.0, 30.0, 30.0, 30.0, 30.0, 65.0, 60.0, 60.0, 60.0, 60.0, 60.0
- idle-v3-tfalse-m10 view 0: first@31s, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0
- idle-v3-tfalse-m10 view 1: first@31s, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0
- idle-v3-tfalse-m10 view 2: first@31s, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0, 30.0

#### session/ disk (du -sk, KB) at end of login-idle runs

| throttle | views | per view (view 0 = userData root minus spike/) |
|---|---|---|
| true | 1 | 75888 |
| true | 2 | 75888 / 70140 |
| true | 3 | 75888 / 70140 / 70140 |
| false | 1 | 75888 |
| false | 2 | 75888 / 70140 |
| false | 3 | 75904 / 70140 / 70140 |

## Appendix D: analyzer output, superseded `vite preview` attempt (blank shell, do not use)

Source: `raw-darwin-arm64.jsonl` (runs prefixed `prod-`)

#### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)

| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |
|---|---|---|---|---|---|
| true | 0 | 2 | — | — | — |
| true | 1 | 2 | 257 | 257 | 257 |
| true | 2 | 2 | 264 / 272 | 272 | 15 |
| true | 3 | 2 | 291 / 296 / 297 | 297 | 25 |

#### Memory: workingSetSize (MB), sum over every app process

`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint | login screen reached (views, all reps) | host compressor GB (end, median) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | true | 0 | 0.5,0.5 | 138.4 | 138.4 | 0.0 | 0.0 | 0.0 | — | 58.9 | — | — | — | — |
| cold | true | 1 | 0.5,0.5 | 436.1 | 165.2 | 69.0 | 53.6 | 148.3 | 297.8 | 116.0 | 57.1 | 37.8 | not recorded | — |
| cold | true | 2 | 0.5,0.5 | 595.1 | 167.7 | 77.9 | 55.8 | 293.7 | 159.0 | 154.5 | 38.5 | 37.6 / 35.1 | not recorded | — |
| cold | true | 3 | 0.5,0.5 | 745.9 | 170.3 | 78.5 | 58.2 | 438.8 | 150.7 | 198.0 | 43.5 | 38.7 / 36.2 / 36.2 | not recorded | — |
| login-idle | true | 0 | 3.0 | 223.0 | 128.4 | 57.5 | 37.1 | 0.0 | — | 55.5 | — | — | — | — |
| login-idle | true | 1 | 3.0 | 353.3 | 138.8 | 63.6 | 45.9 | 105.0 | 130.3 | 108.4 | 52.9 | 37.1 | not recorded | — |
| login-idle | true | 2 | 3.0 | 584.0 | 168.1 | 74.4 | 54.3 | 287.1 | 230.7 | 146.8 | 38.4 | 37.0 / 35.1 | not recorded | — |
| login-idle | true | 3 | 3.0 | 563.3 | 143.8 | 63.5 | 47.0 | 309.1 | -20.6 | 183.7 | 36.9 | 36.9 / 33.2 / 35.2 | not recorded | — |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core, median of reps

| throttle | views | reps | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|---|
| true | 0 | 1 | 120 | — | — | 0.02 | 0.00 | 0.00 | 0.03 |
| true | 1 | 1 | 120 | 0.00 | — | 0.01 | 0.00 | 0.00 | 0.02 |
| true | 2 | 1 | 120 | 0.00 | 0.00 | 0.01 | 0.00 | 0.00 | 0.02 |
| true | 3 | 1 | 120 | 0.00 | 0.01 / 0.00 | 0.01 | 0.00 | 0.00 | 0.04 |

#### Heartbeat probe (login-idle). App heartbeat = 30 s setInterval in the page; server-measured gaps.

| throttle | views | view | visibility seen | hb count | max hb gap s | gaps > 45 s | gaps > 120 s (presence window) | max pong RTT ms | max app echo RTT ms |
|---|---|---|---|---|---|---|---|---|---|
| true | 1 | 0 |  | 0 | — | 0 | 0 | — | — |
| true | 2 | 0 |  | 0 | — | 0 | 0 | — | — |
| true | 2 | 1 |  | 0 | — | 0 | 0 | — | — |
| true | 3 | 0 |  | 0 | — | 0 | 0 | — | — |
| true | 3 | 1 |  | 0 | — | 0 | 0 | — | — |
| true | 3 | 2 |  | 0 | — | 0 | 0 | — | — |

#### Heartbeat gap sequence (s), throttle=true views=3 hidden views

- prod-idle-v3-ttrue-m3 view 0: 
- prod-idle-v3-ttrue-m3 view 1: 
- prod-idle-v3-ttrue-m3 view 2: 

#### session/ disk (du -sk, KB) at end of login-idle runs

| throttle | views | per view (view 0 = userData root minus spike/) |
|---|---|---|
| true | 1 | 10160 |
| true | 2 | 10160 / 4452 |
| true | 3 | 10160 / 4452 / 4452 |

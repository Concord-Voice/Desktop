# Connection footprint spike: macOS arm64 results

> **§9 THRESHOLD EXCEEDED: memory, on the prescribed measurement. Task 0 stops here.**
> The measurement is the Vite dev renderer, idle at the login screen. Each added connection
> costs **156.9–168.4 MB** of private memory (macOS `phys_footprint`) with
> `backgroundThrottling` true, against a 150 MB threshold. Per §2 and §9 this reopens the
> within-A fallback before Task 4. That decision belongs to the orchestrator and maintainer.
> See § Step 5.

**At a glance:**

- Host: Apple M5 Pro, 18 logical cores, 48 GB, macOS 27.2 (26B123). Electron **45.0.0**,
  darwin arm64.
- Date: 2026-11-09. The dev matrix ran 00:56–01:48 EST, the production-bundle runs
  01:48–02:05, and the platform checks at 01:48 and 02:05.
- Harness: `../main.mjs`; tables made with
  `node spikes/connection-footprint/analyze.mjs results/raw-darwin-arm64.jsonl --exclude=prod-`
  (the dev runs) and `--prefix=prod-` (the production-bundle runs).
- Raw data: every run, including the warm-up and one failed platform run, is in
  `raw-darwin-arm64.jsonl`. The warm-up went to a scratch file and is not in it.
- Renderer: the Vite dev server on `:3001`, as Step 1 prescribes, with the real preload and
  the real `buildBrowserWindowConfig` `webPreferences`. View 0 uses `defaultSession`; views
  1–2 use `session.fromPath`. View 0 is in the foreground; views 1 and up are hidden with
  `setVisible(false)`.

## Durations actually used (ruling 3)

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

## Environment caveats (read before using any number)

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

## Per-connection delta (headline)

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

## Hidden-view throttling vs websocket heartbeat

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

## Idle CPU and disk

- **Idle CPU per hidden view** (login screen): **0.01–0.04% of one core** with
  `throttle=true`, the same with `throttle=false`. The foreground view uses 0.00–0.05%; the
  browser process 0.01–0.02%. The cost of `throttle=false` at the login screen is not
  distinguishable from noise. Logged-in idle CPU is not measured.
- **`session/` disk** (`du -sk`, end of login-idle): view 0 (`userData` root minus `spike/`)
  is 75,888 KB; each `fromPath` session is 70,140 KB. Both are dominated by the HTTP and code
  caches of the dev server's unbundled modules. The production-bundle runs give
  10,160 / 4,452 KB. Neither represents a production `app://` session after login.

## macOS platform rows (manual, captured)

| row | result | evidence |
|---|---|---|
| `hiddenInset` traffic lights vs a full-bounds child view | **Verified.** The traffic lights draw *above* the child view, at the same position as in `BrowserWindow`. The child view extends under the title-bar band, as `hiddenInset` content does today. This holds for view 0 (`defaultSession`) and, after a foreground switch, for view 1 (`fromPath`). | `macos-hiddeninset-child-view.png` (window inactive, so grey lights), `macos-drag-strip-view0.png`, `macos-drag-strip-view1.png` (lights in colour over the red strip) |
| `-webkit-app-region: drag` works inside a child view | **NOT VERIFIED.** The strip renders in both child views (captures), but only a real OS drag exercises the native hit test. Synthetic `CGEvent` drags (`--drag=true`, with a `BrowserWindow` control) were **withheld**: a full-screen app owned the display, so the events would have landed in it. To verify, run `--check=platform --drag=true` with someone at the machine. | `macos-drag-strip-view0.png`, `macos-drag-strip-view1.png` |
| child webContents destroyed on `BaseWindow.close()` | **Not destroyed.** At +0 ms and +3000 ms after `closed`, both children report `isDestroyed() === false`, their renderer pids are alive, and `webContents.getAllWebContents().length === 2`. An explicit `webContents.close()` destroys them: `isDestroyed() === true`, the pids are gone, the count is 0, and `view.webContents` then reads `undefined`. This matches Electron's BaseWindow "Resource management" note. **T4 must close every view's webContents on `closed`.** | `raw-darwin-arm64.jsonl` run `platform-macos-2`. Run `platform-macos` hit a harness bug in the post-close probe (the `undefined` property); it was fixed and re-run, and both runs' lines are kept. |
| `titleBarOverlay` hit-testing | N/A on macOS (Windows/X11 only) | `windows-x64.md`, `linux-x64.md` |
| Wayland framed chrome | N/A on macOS | `linux-x64.md` |

## Supplement: production renderer bundle (`vite build` + `vite preview :3002`) — NOT a like-for-like comparison

This was run to separate dev-mode inflation from real cost. **It does not reach the login
screen in this harness**, for three reasons:

- The production CSP strips loopback `connect-src`, so the API calls to `:8080` are refused.
- `auth:restoreSession` rejects unhandled.
- The page stalls at a blank shell: the title bar only, 32 DOM elements, against 187 for the
  dev login screen. This was confirmed by a separate render check.

Its numbers are a **floor for a near-empty minified React shell**, not a login-screen
figure:

- renderer footprint: 33–38 MB per view
- Δ footprint per added connection: 52.9 / 38.4 / 36.9 MB
- Δ cold start: 257 (first view) / 15 / 25 ms
- idle CPU per hidden view: 0.00–0.01%

The CSP also blocked the heartbeat probe, so there is no heartbeat data for these runs. A
production login-screen or logged-in connection lies somewhere above this floor. **This
spike does not measure where.**

## §9 threshold evaluation

| threshold | closest measurement | verdict |
|---|---|---|
| > 150 MB incremental private working set per idle **logged-in** connection | Logged-in: NOT MEASURED. Proxy: dev renderer, login-idle, Δ `phys_footprint` = 168.4 / 160.5 MB (2nd connection) and **156.9** / 148.7 MB (3rd). The renderer process alone is 150.7–175.7 MB. | **EXCEEDED on the prescribed measurement** (3 of the 4 N≥2 increments, including the default `throttle=true` at 3). A logged-in renderer does strictly more than the login screen, so for this renderer build the proxy is a lower bound. The production cost is unmeasured: it sits between the 37 MB blank-shell floor and the dev figure. |
| > 400 ms added cold start per added connection | median 174 / 204 ms (`throttle=true`), 268 ms (`throttle=false`, 2→3); min-of-reps 73–197 ms | not exceeded (noisy host; see the per-rep table) |
| > 1% idle CPU per hidden view, throttling on | 0.01–0.04% of one core (login screen) | not exceeded (logged-in idle not measured) |

## Step 5: decisions

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

## Appendix A: analyzer output, dev renderer (the prescribed measurement)

Source: `raw-darwin-arm64.jsonl` (runs excluding `prod-`); CPU % is of ONE core (cumulativeCPUUsage delta / wall time); host has 18 logical cores.

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

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | true | 0 | 0.5,0.5,0.5 | 138.9 | 138.9 | 0.0 | 0.0 | 0.0 | — | 59.3 | — | — |
| cold | true | 1 | 0.5,0.5,0.5 | 571.6 | 174.5 | 69.1 | 61.0 | 267.0 | 432.7 | 255.6 | 196.3 | 144.9 |
| cold | true | 2 | 0.5,0.5,0.5 | 869.1 | 174.9 | 95.0 | 63.3 | 536.0 | 297.5 | 400.1 | 144.6 | 151.0 / 137.8 |
| cold | true | 3 | 0.5,0.5,0.5 | 1133.8 | 180.0 | 95.9 | 65.4 | 791.6 | 264.7 | 545.3 | 145.2 | 149.8 / 136.7 / 136.8 |
| cold | false | 0 | 0.5,0.5,0.5 | 139.0 | 139.0 | 0.0 | 0.0 | 0.0 | — | 59.3 | — | — |
| cold | false | 1 | 0.5,0.5,0.5 | 564.1 | 169.2 | 67.3 | 60.9 | 266.9 | 425.2 | 257.9 | 198.6 | 152.2 |
| cold | false | 2 | 0.5,0.5,0.5 | 863.2 | 174.8 | 85.0 | 69.4 | 531.4 | 299.1 | 400.8 | 142.9 | 145.4 / 140.3 |
| cold | false | 3 | 0.5,0.5,0.5 | 1142.4 | 180.9 | 90.9 | 75.6 | 794.9 | 279.2 | 547.9 | 147.1 | 144.0 / 139.5 / 139.4 |
| login-idle | true | 0 | 3.0 | 252.8 | 144.1 | 65.9 | 42.9 | 0.0 | — | 55.7 | — | — |
| login-idle | true | 1 | 3.0 | 365.2 | 129.7 | 60.8 | 48.2 | 126.4 | 112.4 | 259.1 | 203.4 | 162.0 |
| login-idle | true | 2 | 3.0 | 664.7 | 149.6 | 65.8 | 51.6 | 397.6 | 299.6 | 427.6 | 168.4 | 175.6 / 151.3 |
| login-idle | true | 3 | 10.0 | 515.1 | 130.9 | 57.9 | 48.1 | 278.1 | -149.6 | 584.4 | 156.9 | 175.7 / 151.6 / 150.7 |
| login-idle | false | 0 | 3.0 | 238.1 | 135.3 | 62.1 | 40.7 | 0.0 | — | 55.6 | — | — |
| login-idle | false | 1 | 3.0 | 613.8 | 175.1 | 76.4 | 57.8 | 304.4 | 375.7 | 271.6 | 216.0 | 175.3 |
| login-idle | false | 2 | 3.0 | 911.0 | 187.7 | 75.5 | 62.5 | 585.3 | 297.2 | 432.0 | 160.5 | 175.5 / 153.7 |
| login-idle | false | 3 | 10.0 | 518.5 | 131.4 | 57.2 | 49.5 | 280.3 | -392.5 | 580.7 | 148.7 | 157.7 / 155.2 / 155.1 |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core

| throttle | views | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|
| true | 0 | 120 | — | — | 0.02 | 0.01 | 0.00 | 0.02 |
| true | 1 | 120 | 0.05 | — | 0.02 | 0.01 | 0.00 | 0.08 |
| true | 2 | 120 | 0.00 | 0.04 | 0.02 | 0.00 | 0.00 | 0.07 |
| true | 3 | 540 | 0.00 | 0.01 / 0.01 | 0.02 | 0.00 | 0.00 | 0.05 |
| false | 0 | 120 | — | — | 0.01 | 0.00 | 0.00 | 0.01 |
| false | 1 | 120 | 0.00 | — | 0.02 | 0.00 | 0.00 | 0.03 |
| false | 2 | 120 | 0.00 | 0.04 | 0.02 | 0.00 | 0.00 | 0.07 |
| false | 3 | 540 | 0.00 | 0.01 / 0.01 | 0.02 | 0.00 | 0.01 | 0.06 |

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

## Appendix B: analyzer output, production bundle (blank-shell floor; see the supplement caveat)

Source: `raw-darwin-arm64.jsonl` (runs prefixed `prod-`); CPU % is of ONE core (cumulativeCPUUsage delta / wall time); host has 18 logical cores.

#### Cold start (state=cold, fresh profile; whenReady -> did-finish-load, median of reps)

| throttle | views | reps | per-view load ms (median) | all-loaded ms (median) | delta vs N-1 ms |
|---|---|---|---|---|---|
| true | 0 | 2 | — | — | — |
| true | 1 | 2 | 257 | 257 | 257 |
| true | 2 | 2 | 264 / 272 | 272 | 15 |
| true | 3 | 2 | 291 / 296 / 297 | 297 | 25 |

#### Memory: workingSetSize (MB), sum over every app process

`cold` = first sample at all-loaded (median of reps). `login-idle` = mean of the last 3 samples. Footprint = macOS phys_footprint at end of run (all processes; the private-memory cross-check).

| state | throttle | views | minutes (actual) | total WS | browser | GPU | utility | renderers (Tab) | delta total WS vs N-1 | footprint total | delta footprint vs N-1 | per-view renderer footprint |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | true | 0 | 0.5,0.5 | 138.4 | 138.4 | 0.0 | 0.0 | 0.0 | — | 58.9 | — | — |
| cold | true | 1 | 0.5,0.5 | 436.1 | 165.2 | 69.0 | 53.6 | 148.3 | 297.8 | 116.0 | 57.1 | 37.8 |
| cold | true | 2 | 0.5,0.5 | 595.1 | 167.7 | 77.9 | 55.8 | 293.7 | 159.0 | 154.5 | 38.5 | 37.6 / 35.1 |
| cold | true | 3 | 0.5,0.5 | 745.9 | 170.3 | 78.5 | 58.2 | 438.8 | 150.7 | 198.0 | 43.5 | 38.7 / 36.2 / 36.2 |
| login-idle | true | 0 | 3.0 | 223.0 | 128.4 | 57.5 | 37.1 | 0.0 | — | 55.5 | — | — |
| login-idle | true | 1 | 3.0 | 353.3 | 138.8 | 63.6 | 45.9 | 105.0 | 130.3 | 108.4 | 52.9 | 37.1 |
| login-idle | true | 2 | 3.0 | 584.0 | 168.1 | 74.4 | 54.3 | 287.1 | 230.7 | 146.8 | 38.4 | 37.0 / 35.1 |
| login-idle | true | 3 | 3.0 | 563.3 | 143.8 | 63.5 | 47.0 | 309.1 | -20.6 | 183.7 | 36.9 | 36.9 / 33.2 / 35.2 |

#### Idle CPU (login-idle; window = +60 s after load to end of run), % of one core

| throttle | views | window s | view 0 (foreground) | hidden views 1..N-1 | browser | GPU | Network Service | total |
|---|---|---|---|---|---|---|---|---|
| true | 0 | 120 | — | — | 0.02 | 0.00 | 0.00 | 0.03 |
| true | 1 | 120 | 0.00 | — | 0.01 | 0.00 | 0.00 | 0.02 |
| true | 2 | 120 | 0.00 | 0.00 | 0.01 | 0.00 | 0.00 | 0.02 |
| true | 3 | 120 | 0.00 | 0.01 / 0.00 | 0.01 | 0.00 | 0.00 | 0.04 |

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

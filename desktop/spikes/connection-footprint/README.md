# Connection footprint + composition spike (Desktop #86, Task 0)

Throwaway measurement prototype. **Not production code, not in CI, not linted, no unit
tests.** Plain ESM (`.mjs`), which keeps it outside the tsc, eslint and vitest globs. It
exists to put measured numbers into `results/*.md`. Those numbers feed ADR-0051, set
`MAX_LIVE_CONNECTIONS` and decide `backgroundThrottling` for hidden views (spec
`docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md` §5 T0 and §9).

Spec §5 T0 says this spike gates the ADR and `MAX_LIVE_CONNECTIONS`. It is also the only
thing that may legitimately reopen option B.

## What it builds

One `BaseWindow` (the real `buildBrowserWindowConfig` window options, `hiddenInset` on
macOS) with 0 to 3 `WebContentsView` children:

| view | session | role in the spec |
|---|---|---|
| 0 | `session.defaultSession` | the `saas` connection (stays on the default session, R1) |
| 1..3 | `session.fromPath(<userData>/spike/profiles/<i>/session)` | a self-hosted connection (R2) |

Every view uses the **real** `webPreferences` from `buildBrowserWindowConfig`: sandbox,
contextIsolation, no nodeIntegration, the real preload, and `webSecurity` false because the
build is unpackaged. Each view also gets its own `session` and `backgroundThrottling` from
`--throttle`. Each view loads the Vite dev renderer at `http://localhost:3001`. View 0 is the
foreground view. Views 1 and up are hidden with `view.setVisible(false)` from creation, which
is how background connections would be restored.

The spike's main process registers **no `ipcMain` handlers**. The renderer boots to its login
screen and logs `No handler registered for ...` for every preload call it makes. That noise is
expected.

`userData` is redirected to `<appData>/concord-connection-footprint-spike`, so the spike never
touches a real Concord profile. `--state=cold` deletes that directory before launch.

## How to run

```bash
cd desktop
npm run build:preload && npm run build:main   # once: the spike imports dist/main/browserWindowConfig.js
npm run dev:renderer                           # shell 1: Vite on :3001
# shell 2:
npx electron spikes/connection-footprint/main.mjs --views=3 --throttle=true --state=login-idle --minutes=10
npx electron spikes/connection-footprint/main.mjs --check=platform              # macOS platform rows
node spikes/connection-footprint/analyze.mjs spikes/connection-footprint/results/raw-darwin-arm64.jsonl
```

| flag | values | meaning |
|---|---|---|
| `--views` | `0`..`3` | number of connection views (0 = bare `BaseWindow`) |
| `--throttle` | `true` / `false` | `webPreferences.backgroundThrottling` for every view |
| `--state` | `cold` / `login-idle` / `logged-in-idle` | `cold` wipes the spike profile first; `login-idle` reuses the warm profile and idles at the login screen; `logged-in-idle` refuses to run (exit 2, see below) |
| `--minutes` | number | sampling window after all views have loaded |
| `--sample-seconds` | default `30` | `app.getAppMetrics()` interval |
| `--run` | label | run id written on every JSONL line |
| `--url` | default `http://localhost:3001` | renderer URL. The supplementary production-bundle runs used `vite preview` on `:3002`; in this harness that bundle stalls at a blank shell (see `results/macos-arm64.md`) |
| `--check=platform` | | macOS platform rows instead of a measurement run |
| `--drag=true` | | with `--check=platform`: also post real OS mouse drags (see below) |

## What it records

Each run appends JSONL lines to `results/raw-<platform>-<arch>.jsonl`:

- `run`: the parameters, the Electron version and the platform.
- `load`: `whenReady` to `did-finish-load` in ms, per view.
- `sample`: one line per app process every `--sample-seconds`. It holds `pid`, `type`,
  `view` (matched through `webContents.getOSProcessId()`), `memory.workingSetSize`,
  `cpu.percentCPUUsage` and `cpu.cumulativeCPUUsage`.
- `footprint`: at the end of the run, macOS `phys_footprint` per process via `footprint(1)`.
  This is the private-memory cross-check, because macOS `workingSetSize` also counts shared
  resident pages.
- `disk`: `du -sk` of each view's session directory. For view 0 that is the `userData` root
  minus `spike/`. The values are also printed on exit.
- `probe`: heartbeat-probe events (below).
- `visibility`: `document.visibilityState` of every view at the end of the run.

**CPU unit.** On Electron 45 / macOS, `percentCPUUsage` is a share of **all** logical cores. On
the 18-core measuring host, the `cumulativeCPUUsage` delta divided by wall time came out at 18
times `percentCPUUsage`. `analyze.mjs` therefore derives CPU from `cumulativeCPUUsage` and
reports **% of one core**, the Activity Monitor convention and the stricter reading of the
§9 "1% idle CPU" threshold.

## Heartbeat probe (hidden-view throttling vs websocket heartbeat)

After `did-finish-load`, `main.mjs` injects a probe into every view. The probe opens a
WebSocket to a `ws` server in the spike's main process on `127.0.0.1`, which the dev CSP's
`connect-src` allows. The probe mirrors the live contract:

- **Application heartbeat:** the page sends from a 30 s `setInterval`, like
  `websocketService.startPingInterval`. The server timestamps the arrivals, so a throttled
  page cannot misreport its own timing.
- **Protocol ping:** the server sends one every 54 s, which is the control plane's
  `pingPeriod`. Chromium's network service answers it without renderer JS.
- **Application echo:** the server sends a frame every 54 s, and the page echoes it from
  `onmessage`.

**A "miss" is judged against the server's real tolerances.** The control plane's
`pongWait` is 60 s, which bounds the transport. Presence needs an inbound application frame
within 120 s; see the presence-liveness sweep in the control plane's `internal/websocket`
README. The table also counts gaps over 45 s, i.e. the 30 s cadence not held, so a reader
can apply a stricter rule.

Chromium's intensive wake-up throttling applies only after a page has been hidden for 5
minutes. The `throttle=true` heartbeat runs therefore need a window of 10 minutes or more.

## `logged-in-idle`: not measurable with this harness

Two things block it:

1. **No control plane.** The renderer talks to `localhost:8080`, and Desktop has no control
   plane.
2. **No custody handlers.** Even with a control plane, this harness registers no custody
   IPC: `auth:storeRefreshToken`, `auth:getMachineId` and the rest. `Login.tsx` fails
   closed when `storeRefreshToken` rejects, so a login cannot complete inside the spike.

Measuring it needs both a control plane and the real main-process custody, i.e. the
post-T5/T7 build. Re-run the rows there; do not fake custody in this spike. `--state=logged-in-idle`
exits 2 so that a login-screen run can never be recorded under that label.

## Platform rows (from spec §5 T0)

| row | where it can be checked |
|---|---|
| `-webkit-app-region: drag` inside a child view | every OS. On macOS: `--check=platform --drag=true` |
| `titleBarOverlay` hit-testing | Windows and X11 only |
| macOS `hiddenInset` traffic lights vs the child view | macOS: `--check=platform` captures the window |
| Wayland framed chrome | Linux Wayland only |
| hidden-view timer throttling vs websocket heartbeat | every OS: heartbeat probe, `--minutes>=10` |
| child webContents survival on `BaseWindow.close()` | every OS: `--check=platform` |

`--check=platform` does four things:

- It captures the window with `screencapture -x -o -l<CGWindowID>` into
  `results/macos-*.png`.
- It injects a red `-webkit-app-region: drag` strip into both child views and captures each
  as the foreground view.
- It closes the `BaseWindow`, then records `webContents.isDestroyed()` and renderer-pid
  liveness at +0 ms and +3 s, and again after an explicit `webContents.close()`.
- With `--drag=true`, it also compiles a small CoreGraphics tool with `swiftc` and posts a
  real OS mouse drag that starts inside the strip, then compares `getBounds()` before and
  after. A plain `BrowserWindow` with the same strip goes first as the positive control. If
  the control does not move, event posting is not permitted, and the child-view result
  means nothing.

**Only pass `--drag=true` when you are at the machine and expect it.** The posted events
land on whatever is frontmost.

## §9 thresholds (spec)

Exceeding any one of these reopens the within-A fallback (one `BrowserWindow` per
connection) before any option-B discussion:

| threshold | value |
|---|---|
| incremental private working set per idle logged-in connection | > 150 MB |
| added cold start per added connection | > 400 ms |
| idle CPU per hidden view with throttling on | > 1% |

Results: `results/macos-arm64.md` (measured), `results/windows-x64.md` and
`results/linux-x64.md` (not measured).

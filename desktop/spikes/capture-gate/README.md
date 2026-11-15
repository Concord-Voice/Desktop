# Capture-gate probe (Desktop #87, Task 0)

Throwaway measurement prototype. **Not production code, not in CI, not linted, no unit
tests.** Plain ESM (`.mjs`), which keeps it outside the tsc, eslint and vitest globs. It runs a
real Electron 45 and answers seven questions that the #87 capture-lease design depends on
(spec `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` §6 T0,
§3.3, §3.4, §3.5, §5.2). Its results feed ADR-0052 and two downstream decisions:

- **Row 1 selects `CAPTURE_CHECK_POLICY`** (Task 4) and the §5.2 branch (the `DeviceSelector`
  step in Task 7A/7B).
- **Row 7 selects `BANNER_VISIBILITY_SIGNAL`** (Task 7B).

## What it builds

One `BaseWindow` (480 × 360, shown with `showInactive()` so it never takes focus) with two
`WebContentsView` children:

| view | session | state |
|---|---|---|
| A | `session.fromPath(<userData>/spike/0/session)` | visible |
| B | `session.fromPath(<userData>/spike/1/session)` | hidden with `setVisible(false)` from creation |

Both views use `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload,
and `backgroundThrottling` from `--throttle` (default `true`, the value `shellWindow.ts` uses).
Each loads `renderer.html?view=A|B`, which exposes `window.probe`:
`gum(constraints)`, `gdm(constraints)`, `vetoUnload()`, `trackStates()`, `stopAll()`,
`devices()`, `permState(name)`, `clicks()`, `vis()` and `nonce` (new on every document load).

Main installs a permission **check** handler and a permission **request** handler on both
sessions. Every call is logged as `(view, permission, phase, mediaTypes|mediaType,
isMainFrame, answer)`. The check handler answers `--check` for `media` and `display-capture`
and `false` for everything else. Each row sets what the request handler answers.

### Profile isolation

`main.mjs` calls `app.setPath('userData', …)` (and `sessionData`, `crashDumps`, `logs`) on a
fresh `fs.mkdtempSync(<os.tmpdir()>/concord-capture-gate-)` directory **before**
`app.whenReady()`, so it never opens a real Electron or Concord profile. The directory is
removed by a detached reaper (plain Node via `ELECTRON_RUN_AS_NODE`) once the spike's pid has
exited. An in-process `rmSync` at `quit` or at `process.exit` is not enough: on 45.0.0 Chromium
writes `Local State` and the partition directories after both. The reaper only removes a
directory whose parent is `os.tmpdir()` and whose name carries the spike's prefix. The path is
printed as `[gate] profile <dir>` so a runner can confirm it is gone.

Each run has a hard timeout (`--timeout-ms`, default 30 000) that calls `app.exit(3)`, so a hung
row (a dialog that did not close, a load that never finished) cannot leave windows open.

## How to run

```bash
cd desktop
npx electron spikes/capture-gate/main.mjs --row=1 --check=true
npx electron spikes/capture-gate/main.mjs --row=1 --check=false
npx electron spikes/capture-gate/main.mjs --row=2
npx electron spikes/capture-gate/main.mjs --row=3 --check=true
npx electron spikes/capture-gate/main.mjs --row=4 --activation=true  --timeout-ms=60000
npx electron spikes/capture-gate/main.mjs --row=4 --activation=false --timeout-ms=60000
npx electron spikes/capture-gate/main.mjs --row=5 --fake-ui --check=true
npx electron spikes/capture-gate/main.mjs --row=6
npx electron spikes/capture-gate/main.mjs --row=7 --throttle=true
npx electron spikes/capture-gate/main.mjs --row=7 --throttle=false
```

No build step is needed; the spike imports nothing from `dist/`.

**Flag rule.** `--use-fake-device-for-media-stream` is appended by `main.mjs` on every run.
`--use-fake-ui-for-media-stream` is appended **only for row 5** (`--fake-ui`), and `main.mjs`
refuses to start any other row if it sees the fake-UI flag or `--fake-ui`. Row 5 shows why: the
fake-UI flag bypasses both permission handlers, so a run that carries it measures nothing about
the gate.

| flag | values | meaning |
|---|---|---|
| `--row` | `1`..`7` | the row to run (below) |
| `--check` | `true` (default) / `false` | what the check handler answers for `media` / `display-capture` |
| `--throttle` | `true` (default) / `false` | `backgroundThrottling` for both views |
| `--activation` | `true` (default) / `false` | row 4: install the `beforeunload` veto inside a user-gesture `executeJavaScript`, or without one |
| `--fake-ui` | | row 5 only: append `--use-fake-ui-for-media-stream` |
| `--timeout-ms` | default `30000` | hard timeout, then `app.exit(3)` |
| `--run` | label | run id on every log line |

## Rows

| row | what it does |
|---|---|
| 1 | Request handler grants. Three `getUserMedia({ audio: true })` calls in A (the first two keep the earlier tracks live, the third follows `stopAll()`). Counts request-handler calls per `getUserMedia`. Also records `enumerateDevices()` (entries, labelled, with a `deviceId`) and `permissions.query({ name: 'microphone' })` before and after |
| 2 | Request handler answers `callback(false)`. Records the renderer's error name and message for audio and for video |
| 3 | Request handler **denies everything**. `getUserMedia` with `chromeMediaSource: 'desktop'` (video without an id, video with `screen:0:0`, video plus loopback audio) and `getDisplayMedia({ video: true })` with no `setDisplayMediaRequestHandler`. Records which permission string reaches which handler |
| 4 | A holds a live microphone and camera track behind a `beforeunload` veto. (a) `reload()` alone. (b) `forcefullyCrashRenderer()` then `reload()` in the same task, as spec §3.4 step 4 has it. (c) Only if (b) left no document: a second `reload()` after `render-process-gone`. Records the document nonce, track states, renderer pid liveness, `isCrashed()` and the `webContents` events |
| 5 | `--fake-ui`. Request handler **denies everything**. `getUserMedia` audio and video. Any call that resolves was granted without the request handler |
| 6 | `dialog.showMessageBox(baseWindow, { signal, … })` with the spec §3.3 option shape. Sends a `mouseDown` to A with `sendInputEvent` before, during and after, records `sheet-begin` / `sheet-end`, then calls `controller.abort()` and records how the promise settles. The dialog closes itself; no click is needed |
| 7 | `document.visibilityState` in B (hidden from creation) and in A (visible, then `setVisible(false)`), plus the `visibilitychange` events each document saw |

Row 3 and row 5 never grant a screen capture: a grant could start a real capture and raise a
macOS Screen Recording prompt on the executor's machine. Row 5 does not exercise desktop
capture for the same reason.

## Output

Every handler call and every step is one `[gate] {json}` line on stdout. Each run ends with one
`[gate] SUMMARY {json}` line carrying the row's result. Nothing is written to disk except the
temporary profile. `results/*.md` are written by hand from those lines.

## Result table template

Each `results/<platform>-<arch>.md` uses this table, one line per row and configuration:

| row | observed | run count | note |
|---|---|---|---|
| 1 (`--check=true`) | … | n / 3 | … |

- **observed**: what the SUMMARY lines show, in words. No inference beyond them.
- **run count**: how many of the runs showed it, out of how many runs.
- **note**: caveats, limits of the measurement, and what the row does not prove.

A row that was not run reads `NOT MEASURED — <reason>`. Nothing is estimated.

Results: `results/macos-arm64.md` (measured), `results/windows-x64.md` and
`results/linux-x64.md` (not measured).

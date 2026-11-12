# Capture-gate probe — macOS arm64

Spec: `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` §6 T0
(also §3.3, §3.4, §3.5, §5.2). Harness: `../main.mjs` (see `../README.md`).

**Measured 2026-11-11** on Electron **45.0.0** (Chromium 156.0.8078.48), macOS 27.2 (build
26B123), Apple Silicon. `--use-fake-device-for-media-stream` on every run;
`--use-fake-ui-for-media-stream` on row 5 only. Every row ran three times per configuration.
Each run used a fresh temporary profile, and the spike's reaper removed every one.

## Results

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

## What this changes downstream

- **Spec §3.4 step 4 (Tasks 2 and 4).** `forcefullyCrashRenderer()` does end the old document's
  tracks (R1 holds), but `reload()` in the same task is lost and leaves the connection's view a
  crashed `webContents` with no document. Nothing in #86 reloads on `render-process-gone`
  (`main.ts:1493` logs, `shellWindow.ts:216` advances the generation). The reload has to be
  issued once `render-process-gone` has been delivered, for example from the
  `renderer-gone` generation listener that settles the handoff.
- **Check handler (Task 4).** Row 1 passes: the request handler is the gate for every
  `getUserMedia`, so the check may answer for a bound primary main frame. Under that policy any
  bound primary main frame, holder or not, sees labelled devices with ids and
  `permissions.query` = `granted`. `DeviceSelector` needs no `device-test` acquire before
  `enumerateDevices` (§5.2, the row-1-passes branch).
- **`display-capture` (Task 4).** Both `chromeMediaSource: 'desktop'` and `getDisplayMedia`
  reach the request handler as `display-capture`, never the check handler. The request-handler
  gate therefore covers `getDisplayMedia` too. §3.5's "the `getDisplayMedia` fallback fails
  closed without a handler" is unverified past a grant.
- **Tests (Tasks 7B, 8).** Any run with `--use-fake-ui-for-media-stream` grants capture with no
  handler involved, so it cannot test the lease gate. Manual checks must run without it.

## Decisions

CAPTURE_CHECK_POLICY = 'bound-primary-main-frame'

BANNER_VISIBILITY_SIGNAL = 'visibilityState'

Row 1 passed in 3 / 3 runs, so the first applies. Row 7 reported `hidden` in 3 / 3 runs with
the shell's `backgroundThrottling: true`, so the second applies. It holds only while hidden
views keep `backgroundThrottling: true`.

# Audiocap transport closeout (issue 73) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the missing evidence for issue 73's acceptance criteria with one three-process probe, and record it in ADR-0043.

**Architecture:** A sibling Electron probe app, `desktop/scripts/audiocap-transport-probe/`, loads the production host, capture child, addon loader, preload bundle and renderer bridge. The test-only synthetic addon reaches the unmodified loader through a staged temp tree. A pure maths module holds the corruption oracle and the statistics and is unit-tested.

**Tech Stack:** Electron 45 (`utilityProcess`, `protocol.handle`, `webContents.debugger`), esbuild (already a dev dependency), vitest, plain JavaScript (CommonJS `main.js`, ES module `oracle.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-11-73-audiocap-transport-closeout-design.md`

## Global Constraints

- No change under `desktop/src/**`, and none to `desktop/native/concord-audiocap/{rt,napi,index.js,binding.gyp}`. The one permitted edit under `desktop/tests/` is Task 4.
- No new dependency in `desktop/package.json`.
- No audio is recorded, written to disk or committed. The probe handles the deterministic synthetic waveform only.
- The addon is never loaded in main or the renderer. The staged binary lives outside the repository and is deleted on every exit path.
- Exit codes: 0 invariants held; 1 an invariant was violated; 2 a check could not run. Every `catch` prints `FAIL <class>: <reason>`.
- Public repository: no competing product names, no private-repository issue numbers, repository-relative paths, agent names without `@`.
- Subagents do not commit. The orchestrator reviews each diff and commits it. Commit subjects use a bare type (`test:`, `chore:`, `docs:`, `ci:`); bodies end with `Refs #73`.
- All commands run from `desktop/` unless a path says otherwise.

## Review Focus

1. The synthetic binary or `dist/` is missing or stale. Expected: exit 2 with the build command to run, never a pass. (Task 2, step 2)
2. The hook is not installed or no quanta flow. Expected: the steady pass fails on its count floor rather than passing over zero quanta. (Task 2, step 5)
3. The oracle never bites. Expected: `--inject=bitflip` makes the probe exit 1. (Task 2, step 6)
4. The probe hangs. Expected: a watchdog timer prints `PROBE FAIL (timeout)` and exits 2. (Task 2, step 3)
5. The window is hidden or occluded during a measurement. Expected: the measurement pass is void, exit 2. (Task 5, step 2)

---

### Task 1: Oracle maths and its unit tests

**Files:**
- Create: `desktop/scripts/audiocap-transport-probe/oracle.mjs`
- Test: `desktop/scripts/audiocap-transport-probe/oracle.test.ts` (colocated, as `scripts/desktop-engine-probe/runner.test.ts` is)

**Interfaces (Produces):**

```js
export const FRAMES = 480, CHANNELS = 2, TABLE_LEN = 47, RIGHT_LEAD = 12, PHASE_STEP = 10, PHASE_STEP_INVERSE = 33;
// 47 IEEE-754 binary32 bit patterns from `kTable` in rt/synthetic_source.h. Throws unless exactly 47 are found.
export function parseTable(headerText /* string */) /* Uint32Array(47) */;
// bits: Uint32Array(960), interleaved L,R. Left[i] must equal table[(phase+i)%47], right[i] table[(phase+i+12)%47].
export function checkQuantum(bits, table) /* {ok:true, phase:number} | {ok:false, reason:'length'|'not-in-table'|'mismatch', index:number} */;
// Quanta missing between two consecutively delivered quanta: (33 * ((phase - prevPhase - 10) mod 47)) mod 47.
export function missingQuanta(prevPhase, phase) /* 0..46 */;
export function percentiles(values /* number[] */) /* {n, p50, p95, p99, max} */;   // nearest-rank
// samples: [{t0Ns: bigint, perfMs: number, t1Ns: bigint}]. Keeps the shortest round trip.
export function calibrate(samples) /* {offsetMs: number, uncertaintyMs: number} */;  // offset = perfMs - midpoint(t0,t1) in ms; uncertainty = rtt/2
// One stall's verdict. control: true for the 80 ms stall.
export function judgeStall({content, seqGaps, overrun, control}) /* {ok:boolean, reason?:string} */;
```

- [ ] **Step 1 (test-writer): write the failing tests** in `oracle.test.ts` (`// @vitest-environment node`), reading the real header with `readFileSync`:
  - `parseTable` returns 47 distinct values, first `0x00000000`, second `0x3D087C60`; throws on a header with 46 entries.
  - `checkQuantum` accepts a quantum generated for phase 0 and for phase 46 (wrap), and returns that phase.
  - Negative vectors, each must return `ok:false`: one flipped bit; left and right swapped; a one-sample shift of the whole buffer; a buffer of 958 samples (`reason:'length'`); a value not in the table (`reason:'not-in-table'`).
  - `missingQuanta(p, (p+10)%47) === 0`; for k in 1..46, `missingQuanta(p, (p+10*(k+1))%47) === k`.
  - A duplicated quantum (same phase twice) gives `missingQuanta === 46`, which `judgeStall` cannot reconcile with `seqGaps`.
  - `percentiles([1..100])` gives `p50 50, p95 95, p99 99, max 100, n 100`; empty input throws.
  - `calibrate` picks the shortest round trip among three samples and reports half of it as the uncertainty.
  - `judgeStall`: `{14,14,14,false}` ok; `{0,0,0,false}` not ok (reason names the floor); `{0,0,0,true}` ok; `{1,0,0,true}` not ok; `{14,14,13,false}` not ok.
- [ ] **Step 2:** Run `npx vitest run scripts/audiocap-transport-probe/oracle.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3 (developer): implement `oracle.mjs`** to the interfaces above. No imports.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `test: add the audiocap transport oracle and its unit tests`.

### Task 2: Probe core: stage, window, start, isolation, steady delivery

**Files:**
- Create: `desktop/scripts/audiocap-transport-probe/package.json` (`{"main": "main.js"}`), `main.js`, `page.js`

**Interfaces:**
- Consumes: `oracle.mjs` (Task 1). From the staged `dist/main/audiocapHost.js`: `startAudiocapHost(generation, windowHandle|null)`, `killAudiocapHost()`, `setAudiocapPortSink((generation, port) => void)`, `setAudiocapInterruptListener((interrupt) => void)`, `currentAudiocapGeneration()`. Bridge: `createScreenAudioBridge(generation)` returning `{track, generation, stop(), stats(): {overrun, seqGaps, faulted}}`.
- Produces: `window.__probe` in the page with `counts()` returning `{checked, bad, firstBad, contentMissing, lastWriteMs}`, `stats()` (the bridge's), and `stall(ms)`; in `main.js` a `runPass(name, fn)` helper that later tasks append passes to; the result lines `ok   <name>` / `FAIL <name>: <reason>`, then `PROBE PASS` or `PROBE FAIL (<n>)`.

- [ ] **Step 1: staging** in `main.js`. Create `fs.mkdtempSync(path.join(os.tmpdir(), 'audiocap-probe-'))`; copy `dist/` to `<stage>/dist/`, `native/concord-audiocap/index.js` and `package.json` to `<stage>/native/concord-audiocap/`, and `build/Release/concord_audiocap_synthetic.node` to `<stage>/native/concord-audiocap/build/Release/concord_audiocap.node`. Delete the stage in a `process.on('exit')` handler.
- [ ] **Step 2: guards**, each exits 2 with the fix: `app.isPackaged` is true; `dist/main/audiocapHost.js` or `dist/preload/preload.js` is missing or older than its source (`npm run build:main && npm run build:preload`); the synthetic binary is missing (`npm run build:native -- --synthetic`); the stage resolves inside the repository; SHA-256 of the staged binary differs from the synthetic build's or equals the shipped build's; `main.ts` no longer contains `webContents.postMessage('audiocap:port'`.
- [ ] **Step 3: window.** Copy the scheme registration and window options from `scripts/desktop-engine-probe/main.js` (`registerSchemesAsPrivileged` with `standard, secure`, `protocol.handle`, `show: true`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, preload = the staged `dist/preload/preload.js`). Serve an HTML page, `oracle.mjs`, `page.js`, the table as JSON, and the bridge bundle built with `require('esbuild').buildSync({entryPoints: ['src/renderer/services/voice/screenAudioBridge.ts'], bundle: true, format: 'iife', globalName: '__bridge', write: false})`. Add a 120 s watchdog that prints `PROBE FAIL (timeout)` and exits 2.
- [ ] **Step 4: start pass.** Register the port sink (`win.webContents.postMessage('audiocap:port', { generation }, [port])`) and the interrupt listener before `startAudiocapHost(1, null)`. In the page, `page.js` patches `WritableStreamDefaultWriter.prototype.write` before the bundle runs: for each `AudioData`, `copyTo` a preallocated `Float32Array(960)`, run `checkQuantum` on its `Uint32Array` view, accumulate `missingQuanta`, record `performance.now()`, then call the original. Then `__bridge.createScreenAudioBridge(1)`. Pass when the start result is `ok` and `counts().checked > 0` within 5 s.
- [ ] **Step 5: isolation and steady passes.** Isolation: `executeJavaScript('typeof require + "," + typeof process')` returns `undefined,undefined`; on darwin, `lsof -p <pid>` contains the staged `.node` path for the utility PID (from `app.getAppMetrics()`), and does not for main or the renderer; if the positive control fails, exit 2. Steady: over 3 s, `checked >= 250`, `bad === 0`, `contentMissing === 0`, `stats()` is `{overrun: 0, seqGaps: 0, faulted: false}`.
- [ ] **Step 6: prove it can fail.** Add `--inject=bitflip`: the hook flips one bit of the copy before checking. Run `./node_modules/.bin/electron scripts/audiocap-transport-probe --inject=bitflip`. Expected: `FAIL steady`, `PROBE FAIL (1)`, exit 1.
- [ ] **Step 7:** Run `./node_modules/.bin/electron scripts/audiocap-transport-probe`. Expected: `ok` lines for start, isolation and steady, `PROBE PASS`, exit 0, and no `audiocap-probe-*` directory left in the temp directory.
- [ ] **Step 8:** Commit `chore: add the audiocap three-process transport probe`.

### Task 3: Slow-consumer and real-kill passes

**Files:**
- Modify: `desktop/scripts/audiocap-transport-probe/main.js`, `page.js`

**Interfaces:** Consumes `window.__probe`, `judgeStall` (Task 1), `runPass` (Task 2).

- [ ] **Step 1: `__probe.stall(ms)`** busy-waits on `performance.now()` in the page's main thread.
- [ ] **Step 2: slow-consumer pass.** For each of 80 ms (control), 300 ms, 450 ms: snapshot `counts()` and `stats()`; `await executeJavaScript('__probe.stall(ms)')`; wait until 16 more quanta have been checked; take deltas `content` (from `contentMissing`), `seqGaps`, `overrun`; require `judgeStall(...)` ok, `bad === 0`, `faulted === false`, and that the first content gap appeared within the first 16 quanta delivered after the stall. Print the three deltas per stall.
- [ ] **Step 3: real-kill pass.** `process.kill(<utility pid>, 'SIGKILL')`. Require: exactly one interrupt whose `reason === 'child-crash'` within 5 s; `currentAudiocapGeneration() === 0`; `counts().checked` unchanged between 1 s and 2 s after the kill; no process of type `Utility` with the audiocap service name in `app.getAppMetrics()` 2 s after the kill.
- [ ] **Step 4:** Run the probe. Expected: the control line shows `0 0 0`; the 300 ms and 450 ms lines show three equal non-zero numbers; `ok kill`; `PROBE PASS`.
- [ ] **Step 5:** Commit `chore: add slow-consumer and real-kill passes to the transport probe`.

### Task 4: Criterion 4 assertion in the existing interrupt test

**Files:**
- Modify: `desktop/tests/unit/services/voiceService.screenAudioTeardown.test.ts` (the test titled "an interrupt for the live generation retires audio only, closes zero audiocap hosts, and marks the share interrupted")

- [ ] **Step 1 (test-writer):** In that test, after `deliverLiveInterrupt('child-crash')`, add assertions that no `screen-audio` producer remains (`svc.producers.has('screen-audio')` is false) and that no capture acquisition or produce call happened after the interrupt (assert on the suite's existing mocks; add no production change). If the suite has no mock that can observe an acquisition, say so in the hand-back instead of inventing one.
- [ ] **Step 2:** Run `npx vitest run tests/unit/services/voiceService.screenAudioTeardown.test.ts`. Expected: PASS. Then break it once: temporarily make the assertion expect a producer, confirm FAIL, restore.
- [ ] **Step 3:** Commit `test: assert no audio producer or acquisition follows a capture interrupt`.

### Task 5: Measurement passes (`--measure`)

**Files:**
- Modify: `desktop/scripts/audiocap-transport-probe/main.js`, `page.js`

**Interfaces:** Consumes `percentiles`, `calibrate` (Task 1). Produces one JSON object on stdout between the lines `=== MEASURE JSON BEGIN ===` and `=== MEASURE JSON END ===`, containing `env` (git SHA, `process.versions` for electron, chrome, node and uv, OS version, timer resolution), `latency` and `heap`.

- [ ] **Step 1: calibration.** In main, 500 times: `t0 = process.hrtime.bigint()`, `perfMs = await executeJavaScript('performance.now()')`, `t1 = process.hrtime.bigint()`; `calibrate(samples)`. Timer resolution: the smallest non-zero difference between consecutive `performance.now()` readings in a 2000-iteration page loop.
- [ ] **Step 2: latency pass, 60 s after 5 s discarded.** The page's hook records E1 per quantum; a `MediaStreamTrackProcessor` on `bridge.track` records E2 at each 480-sample boundary of the samples read and closes each frame. E0 comes from `AudioData.timestamp` (microseconds) at E1. Calibrate before and after. Void (exit 2) if: the E1 and E2 counts differ; `seqGaps` or the overrun delta is non-zero; the offset moved by more than the uncertainty; `document.visibilityState` is not `visible` at start and end. Report `percentiles` for `L_generator = E2 - E1`, `L_transport = E1 - E0` and `L_total = E2 - E0`, each also as value minus the run minimum, plus the largest gap between consecutive E1 values.
- [ ] **Step 3: heap pass, 60 s after 5 s discarded, on a fresh page load with `?mode=heap`** (no hook, no processor; the track feeds `AudioContext` → `MediaStreamAudioSourceNode` → `GainNode(0)` → destination; the app appends the switch `autoplay-policy=no-user-gesture-required`). After load: `webContents.debugger.attach()`, `HeapProfiler.enable`, `HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`, `HeapProfiler.startSampling` with `{samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true}`, wait 60 s, `HeapProfiler.stopSampling`, `collectGarbage`, `Runtime.getHeapUsage`. Report: sampled bytes (sum of `selfSize` over the profile tree) divided by quanta delivered (from `stats()` and elapsed time at 100 per second); `usedSize` delta; `backingStorageSize` delta when the field exists, else `"not exposed"`; `seqGaps` and overrun deltas. A protocol command that is rejected is exit 2.
- [ ] **Step 4: limits** (from the spec, section 4): retained growth at most 65536 bytes; sampled allocation at most 2048 bytes per quantum; largest write gap at most 20 ms. Over a limit prints `FLAG <name>` and exits 1.
- [ ] **Step 5:** Run `./node_modules/.bin/electron scripts/audiocap-transport-probe --measure`. Expected: the standing passes, then the JSON block, `PROBE PASS`.
- [ ] **Step 6:** Commit `chore: add latency and heap measurement passes to the transport probe`.

### Task 6: Take the measurements (orchestrator, on the developer Mac)

- [ ] **Step 1:** Run the `--measure` command three times with the probe window visible and unobstructed. Save each JSON block outside the repository.
- [ ] **Step 2:** Compute the median and range of every reported figure across the three runs.
- [ ] **Step 3:** If a limit is flagged, stop and investigate with superpowers:systematic-debugging before any doc is written.

### Task 7: Docs

**Files:**
- Modify: `docs/adr/0043-per-process-screen-share-audio-capture.md` (append one addendum), `.claude/rules/domains/native-audio.md` (synthetic section), `desktop/native/concord-audiocap/README.md`

- [ ] **Step 1 (docs-writer): ADR addendum** titled "As-built addendum: issue 73 closeout (transport measurements)", with: the environment line; the latency table (three segments, p50/p95/p99/max/n, uncertainty, offset-free) beside S1's figures and the caveat that S1 ran in one renderer on an older Electron with no utility process and that the synthetic stamp excludes device-buffer delay; the criterion 1 figures against their limits and the proposed wording from the spec, marked "pending project-lead approval"; the slow-consumer table; the sentence "A crashed capture child is never respawned: the share continues video-only with the reason `child-crash`, and a new child exists only when the user starts screen audio again (invariant I6 in `audiocapHost.ts`)"; two record corrections (the watchdog functions the first addendum said would return did not, and a later addendum keeps that gap open by decision; the bounded timeout owed on the spawn listener is still owed and the listener's stated unreachability no longer holds). No private-repository issue numbers in the new text.
- [ ] **Step 2 (docs-writer):** `native-audio.md`: one paragraph, the probe's temp stage is the only sanctioned place where the synthetic binary sits under the release file name; never inside the repository, never through a loader selector. README: a "Transport probe" section with the build commands, the two run commands, and the exit codes.
- [ ] **Step 3:** Run `pre-commit run --files <the three files>` if the hook environment works on this machine; otherwise record that it did not run.
- [ ] **Step 4:** Commit `docs: record the audiocap transport measurements in ADR-0043`.

### Task 8: CI step and path filter (separate commit; the push needs the project lead)

**Files:**
- Modify: `.github/workflows/native-audiocap.yml` (macOS arm64 leg, after the step "Prove the define separates the two binaries"), `.github/ci/scan-relevance.yml` (the `native:` key)

- [ ] **Step 1:** Add one step: `npm run build:main && npm run build:preload && ./node_modules/.bin/electron scripts/audiocap-transport-probe`, `working-directory: desktop`, gated to the macOS arm64 matrix row. No `continue-on-error`.
- [ ] **Step 2:** Add to `native:`: `desktop/scripts/audiocap-transport-probe/**`, `desktop/src/main/audiocap*.ts`, `desktop/src/main/nativeAddonPath.ts`, `desktop/src/preload/audiocapRelay.ts`, `desktop/src/shared/audiocapProtocol.ts`, `desktop/src/renderer/services/voice/screenAudioBridge.ts`.
- [ ] **Step 3:** Run `scripts/check-native-ioc-gate.sh` from the repository root. Expected: pass.
- [ ] **Step 4:** Commit `ci: run the audiocap transport probe on the macOS native leg`. Do not push this commit without the project lead: the automation's token cannot push `.github/workflows/`.
- [ ] **Step 5:** After the first CI run: if the hosted runner cannot show a window, remove the step, keep the probe local, and record that in the ADR addendum and the pull request.

# Issue 73 closeout: evidence for the audiocap host and PCM transport

**Issue:** #73 (`feat: utilityProcess host and PCM transport for concord-audiocap`), child of epic #71
**Date:** 2026-11-11
**Status:** Design approved by the project lead on 2026-11-11. Items 2 to 5 of section 11 are still open.
**Governing decision record:** [ADR-0043](../../adr/0043-per-process-screen-share-audio-capture.md)

## 1. What this is

The host, the transport and the renderer bridge are on `main`. The issue is still open because
three acceptance criteria were never measured and one was only partly shown. This spec plans the
smallest work that produces honest evidence for them, and the docs that record it.

It builds **one probe and no product change**. `desktop/src/**` and the addon's `rt/`, `napi/`,
`index.js` and `binding.gyp` stay as they are unless a measurement proves a defect.

## 2. Status of each acceptance criterion

| # | Criterion (short) | Today | After this work |
|---|---|---|---|
| 1 | Renderer hot-path allocations "measure zero" | Never measured. Cannot be literally zero as built (section 4). | Measured; restated wording put to the project lead |
| 2 | p50 and p99 added latency against S1 | Never measured | Measured with the synthetic source, as S1 was |
| 3 | Slow consumer drops cleanly, a test asserts no corruption | Unit tests at each layer; the three-process run was never done | Standing three-process test with a bit-exact oracle |
| 4 | Killing the capture process gives video-only, never a system mix | Hardware check M5 (ADR-0043) plus unit tests | Same, plus a standing real-kill witness |
| 5 | No addon code in main or renderer | CI host probe proves main only | Renderer half added |
| 6 | Docs | IPC contract 27 and 28 are recorded in `.claude/rules/domains/electron.md`; the runtime-topology document named by the issue lives in another repository and already describes the capture process | ADR-0043 addendum with the numbers |
| 7 | Quality gate | No gate is configured in `.claude/repo-config.json` | Coverage of the merged transport files recorded in the pull request |

## 3. The probe

A sibling of the existing host probe: `desktop/scripts/audiocap-transport-probe/`, run as
`electron scripts/audiocap-transport-probe`. The existing `audiocap-host-probe` is not changed; it
is windowless by design and runs headless on Linux.

Four files:

| File | Purpose |
|---|---|
| `package.json` | `{"main": "main.js"}`, as the host probe has |
| `main.js` | Electron main: stages the tree, opens the window, starts the host, runs the passes, prints the result |
| `page.js` | Renderer: installs the write hook, creates the bridge, runs the stall, reads the track back |
| `oracle.mjs` | Pure maths: waveform table, bit-exact check, gap arithmetic, percentiles, clock calibration |

### 3.1 It runs production code, not copies

| Piece | How it is loaded |
|---|---|
| Host | `require` of the staged `dist/main/audiocapHost.js` (built by `npm run build:main`) |
| Capture child | Forked by the host itself, from the staged `dist/main/audiocapChild.js` |
| Addon loader | The staged, unmodified `native/concord-audiocap/index.js`; its D5 guard runs in the real utility process |
| Preload relay | The production bundle `dist/preload/preload.js`, with `sandbox: true` and `contextIsolation: true` |
| Bridge | `screenAudioBridge.ts` bundled at run time with `esbuild` (already a dev dependency); entry point `createScreenAudioBridge(generation)` |
| Port hand-over | Re-stated in the probe: `webContents.postMessage('audiocap:port', { generation }, [port])`. This is the one seam the probe re-implements; the probe fails with "could not run" if that call is no longer present in `main.ts` |

The window follows the `desktop-engine-probe` precedent: `show: true`, a probe-only scheme served
by `protocol.handle`. The probe passes `windowHandle: null` to `startAudiocapHost`; the synthetic
backend ignores the target.

### 3.2 The synthetic binary reaches the production loader through a staged tree

The shipped loader resolves exactly one development path,
`<loader dir>/build/Release/concord_audiocap.node`, and must not gain a selector. So the probe
copies `dist/`, the loader, and `concord_audiocap_synthetic.node` (renamed to the release file
name) into a fresh directory under the operating system's temp directory, and loads the host from
there.

Guards, all of which fail the probe:

- the stage is outside the repository;
- the staged binary's SHA-256 equals the synthetic build's and differs from the shipped build's;
- the probe refuses to run when `app.isPackaged`;
- the stage is deleted on every exit path.

This deliberately presents the test-only binary under the release file name, outside the
repository. `.claude/rules/domains/native-audio.md` gains one paragraph saying this stage is the
only sanctioned place for that.

### 3.3 Standing passes (every run, including CI)

1. **Start.** `startAudiocapHost(1, null)` succeeds and the bridge receives the port through the
   production relay.
2. **Renderer isolation (criterion 5).** In the page's main world `require` and `process` are
   undefined. On macOS, `lsof -p` lists the staged `.node` for the utility process (the positive
   control) and for neither main nor the renderer.
3. **Steady delivery, 3 s.** Every quantum is bit-exact at the write boundary; `seqGaps` and the
   overrun delta are 0; the bridge has not faulted.
4. **Slow consumer (criterion 3).** Section 5.
5. **Real kill (criterion 4).** `SIGKILL` to the utility process mid-stream. Exactly one interrupt
   with the crash reason arrives; `currentAudiocapGeneration()` returns 0; writes stop within 1 s;
   no new utility process exists 2 s later.

### 3.4 Measurement passes (`--measure`, a developer macOS machine, recorded once)

6. **Latency, 60 s (criterion 2).** Section 6.
7. **Heap, 60 s (criterion 1).** Section 4. It runs on a fresh page load with no hooks installed.

Each runs three times; the record gives the median and the range. Exit codes: 0 invariants held,
1 an invariant was violated, 2 a check could not run. Both 1 and 2 fail.

## 4. Criterion 1: allocations

### What was built

Per 10 ms quantum the bridge creates a `Float32Array` view, an `AudioData`, the promise returned
by `writer.write`, and an ack object; the 3872-byte buffer arrives by value from the capture
process and is then passed on by transfer. That is about 100 quanta per second of short-lived
objects. The spike chose transfer over a pooled free list and removed the pool with it (ADR-0043,
T0b). A literal zero is not what this design does.

### Options

| Option | Assessment |
|---|---|
| **A. Keep the code, measure, restate the criterion** (chosen) | No risk to shipped behaviour. Needs the project lead's approval of the new wording |
| B. Rebuild the bridge so nothing is created per quantum | Needs a shared-memory ring. `SharedArrayBuffer` is unavailable in this runtime (ADR-0043, T0c). A redesign, not a closeout |
| C. Leave it unmeasured | The issue never closes |

### Measurement

Chrome DevTools Protocol through `webContents.debugger`, attached after load. The track feeds a
zero-gain WebAudio graph, so it has a consumer that creates no script objects.

1. Five seconds of steady state, then `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage`.
2. `HeapProfiler.startSampling`, including objects already collected, for 60 s.
3. Stop, collect garbage, read `Runtime.getHeapUsage` again.

Recorded: sampled script-heap bytes allocated per quantum; retained script-heap growth after
garbage collection; backing-store growth where the protocol exposes it; quanta dropped (expected
0). The largest gap between consecutive writes comes from the latency pass.

Limits stated up front, not after the run:

| Figure | Limit | If exceeded |
|---|---|---|
| Retained script-heap growth over 60 s, after GC | at most 64 KB, and not rising across the three runs | A leak. Stop and investigate before closing |
| Sampled script-heap allocation per quantum | at most 2 KB (control objects only) | Something copies the payload into the script heap. Stop and investigate |
| Largest gap between writes | at most 20 ms (two quanta) | Recorded and flagged; GC is the first suspect |

What this does **not** show: copies inside the browser engine below `AudioData`. The record says
so. It does not claim "never copies".

### Proposed wording (the project lead decides)

> In steady state the renderer hot path allocates only a bounded set of short-lived control
> objects per quantum (measured: B bytes) and retains nothing: script-heap growth after garbage
> collection over 60 s was D bytes, no quantum was dropped, and no write was delayed by more than
> M ms. The PCM payload is handed to `AudioData` by transfer, not copied by the bridge.

If the wording is refused, option B is filed as its own issue and this issue stays open on
criterion 1.

## 5. Criterion 3: slow consumer

The renderer's main thread busy-waits. The bridge stops acking, credit runs out, the child stops
draining, the ring fills and drops the newest quantum. Capacity before the first drop is 8 credits
plus 8 ring slots, about 160 ms.

| Stall | Expected |
|---|---|
| 80 ms (control) | no drop |
| 300 ms | about 14 dropped |
| 450 ms | about 29 dropped |

**Oracle.** The synthetic source is one continuous period-47 waveform; the right channel leads the
left by 12 samples and each quantum advances the phase by 10. The probe reads the table from
`rt/synthetic_source.h` at run time. In the write hook, before the original `write`, all 960
samples of every quantum must match the table exactly, and the phase step between consecutive
quanta gives the number of quanta missing. Every stall drops fewer than 47, so the count is
unambiguous.

**Witnesses**, read after 16 fresh quanta because `overrunTotal` lags by up to 8:

- W1: quanta missing by content;
- W2: the bridge's `seqGaps` delta;
- W3: the bridge's overrun delta.

**Pass:** every delivered quantum bit-exact; W1 = W2 = W3 for each stall; **W3 at least 1 for the
300 ms and 450 ms stalls** and 0 for the control, so the test cannot pass without the ring having
dropped; the first gap appears after at most 16 stale quanta; the bridge has not faulted and
delivery resumes.

The claim stops at the write boundary. What the browser's track generator does after `write` is
not this transport's code and is not asserted here.

`oracle.mjs` gets unit tests written by the test-writing agent in its own commit. Each negative
vector must be flagged: a flipped bit, swapped channels, a one-sample shift, a duplicated quantum,
a reordered pair.

## 6. Criterion 2: latency

| Point | Definition |
|---|---|
| E0 | The quantum's `captureTimestampNs`, recovered from `AudioData.timestamp` (the bridge sets it to ns / 1000) |
| E1 | Entry to `writer.write`, stamped with the renderer's `performance.now()` |
| E2 | The same samples arriving from a `MediaStreamTrackProcessor` on the bridge's track. This stands for the producer and is the endpoint S1 used |

| Segment | Meaning | Clocks |
|---|---|---|
| `L_generator` = E2 − E1 | The like-for-like comparison with S1 | one clock |
| `L_transport` = E1 − E0 | What the utility-process hop added. S1 had no such hop | two clocks |
| `L_total` = E2 − E0 | The criterion's own quantity | two clocks |

**Clock calibration.** E0 is `uv_hrtime` in the capture process; main reads the same clock. Main
brackets `executeJavaScript('performance.now()')` 500 times with `process.hrtime.bigint()` and
keeps the sample with the shortest round trip. Uncertainty is half that round trip plus the
measured timer resolution. Calibration runs before and after the pass; the pass is void if the
offset moved by more than the uncertainty. Offset-free figures (each value minus the run's
minimum) are reported beside the absolute ones.

**The pass is void unless** the count at E1 equals the count at E2, `seqGaps` is 0 and the overrun
delta is 0 inside the same 60 s. A percentile over survivors is the flaw ADR-0043 records against
S1's first attempt.

Reported per segment: p50, p95, p99, max, n, uncertainty. Nothing here gates CI. S1's figures
(p50 0.1 ms, p99 0.2 ms) came from one renderer on an older Electron with no utility process; the
record says so next to the comparison.

**Scope decision for the project lead:** this measures the transport with the synthetic source, as
S1 did. The synthetic stamp is taken immediately before the ring push, so it contains no
device-buffer delay. The figure with the real macOS backend belongs to the macOS backend's own
closeout (#75), where the real application and a human-granted capture permission are needed
anyway.

## 7. Criterion 4: no system mix after a kill

Existing evidence, named:

- `desktop/tests/unit/services/voiceService.screenAudioTeardown.test.ts`, "an interrupt for the
  live generation retires audio only, closes zero audiocap hosts, and marks the share interrupted";
- `desktop/tests/unit/renderer/services/voice/screenAudioD6.test.ts`, "D6: a window target cannot
  obtain a system mix" and "kSystemMix containment";
- hardware check M5 in ADR-0043.

Plan task: read the first test and confirm it asserts that no loopback acquisition follows the
interrupt. If that assertion is missing, the test-writing agent adds it to that test. The probe's
real-kill pass then only has to show that a real kill surfaces exactly one crash interrupt.

## 8. Where it runs

| What | Where | Standing or one-time |
|---|---|---|
| `oracle.mjs` unit tests | every runner (vitest) | standing |
| Passes 1 to 5 | macOS arm64 leg of `.github/workflows/native-audiocap.yml`, after both binaries exist; also the nightly run of that workflow | standing |
| Passes 6 and 7 | a developer macOS machine | one-time; re-run when Electron moves |

The CI step is `npm run build:main && npm run build:preload`, then the probe. A failing step fails
the job. A visible window on a hosted macOS runner has no precedent in this repository; the first
run is the proof, and if the runner cannot show a window the step is removed and the standing run
stays local, recorded as such.

The `native` path filter in `.github/ci/scan-relevance.yml` gains the probe directory and the
transport sources, so the workflow runs when they change.

## 9. Docs that ship in the same pull request

- **ADR-0043**, a new addendum at the end: the latency table against S1 with its caveat; the
  criterion 1 figures and the approved wording; the slow-consumer result; one sentence stating
  that a crashed capture child is never respawned (in code as invariant I6, in no document
  today); and two record corrections: the watchdog functions the first addendum said would return
  did not (a later addendum already keeps that gap open by decision), and the bounded timeout it
  says is owed on the spawn listener is still owed.
- **`.claude/rules/domains/native-audio.md`**: the staged-tree paragraph from section 3.2.
- **`desktop/native/concord-audiocap/README.md`**: how to run the probe in both modes.

The raw result JSON (numbers only) goes in the pull request body. No audio is recorded or
committed anywhere; the probe handles a deterministic test waveform only.

## 10. Not in this work

- Any change to the transport, protocol, ring, credit scheme, relay or bridge.
- The real macOS backend latency (measured under #75).
- A Windows leg of the probe (the Windows backend is not built).
- The watchdog rail, and the spawn-listener timeout. The second is proposed as a follow-up issue.
- Latency through a media server or an RTP sender.
- Latency or heap thresholds that gate CI.
- A cross-origin-isolated probe page, a second helper application, per-file hashing of the stage.

## 11. Decisions that belong to the project lead

1. Approve this design. It replaces the earlier outline (launch development clients and share
   windows) with a synthetic-source probe, because the real application path needs a media server
   and cannot isolate the transport.
2. Approve the restated criterion 1 wording once the numbers exist.
3. Accept criterion 2 measured with the synthetic source, with the real-device figure under #75.
4. The CI step edits `.github/workflows/`, which needs a push with workflow scope.
5. File the spawn-listener timeout as a follow-up issue, or not.

## 12. Risks

| Risk | Handling |
|---|---|
| The track read-back is lossy or re-chunks frames | The latency pass is void unless counts match; criterion 3 does not depend on read-back |
| A protocol field or flag name differs in this Chromium | Capability pre-check; exit 2 |
| No usable window on the hosted macOS runner | Section 8 |
| The hook perturbs the heap figure | The heap pass runs on a fresh load with no hooks |
| The staged test binary escapes | Section 3.2 guards |

## 13. Predicted reviewers

`security-reviewer`, `code-reviewer`, `scope-reviewer` (always); `red-team` (the issue carries
`risk: security`); `docs-reviewer` (ADR, rules, README); `test-reviewer` (the oracle tests).

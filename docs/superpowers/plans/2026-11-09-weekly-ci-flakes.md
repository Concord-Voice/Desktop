# Weekly CI flakes: Desktop voice runtime probe implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove two Desktop voice-runtime fixture flakes while preserving the production A/V drift detector and every real media, E2EE, sandbox, and fail-fast assertion.

**Architecture:** First extract the current copied ramp and fixed cutoff behind stable pure helpers without changing behavior. Test-writer then executes those old semantics through the actual detector to obtain meaningful RED regressions; backend-developer repairs the helpers and wires a single-late-step recovery window into the real Electron harness.

**Tech Stack:** Node.js ESM and `node:test`, Electron 45.0.0, Playwright 1.64.1, mediasoup-client 3.25.3, real `RTCStatsReport` snapshots.

**Spec:** `docs/superpowers/specs/2026-11-09-weekly-ci-flakes-design.md`

## Global constraints

- Do not modify `desktop/src/renderer/services/voice/avSyncDriftDetector.ts`.
- Raw merged stats go to the production-independent detector unchanged; normalize only a shallow copied positive-control iterable.
- A raw independent or production drift verdict fails immediately, including during recovery.
- Continuous audio/video delivery, E2EE, progress, runtime markers, sandbox, camera reproduction, and cleanup remain required.
- `MEDIA_PROBE_DURATION_MS` remains a minimum in `95000..180000`; only exactly one late `offset-step` may extend observation, and total continuous-call time never exceeds `180000 ms`.
- Exactly two peers must produce usable raw evidence and a tripped control. Missing, skipped, or cancelled evidence is failure.
- No new dependency, workflow retry, new script module, or third-party API change.
- Diagnostics are allowlisted counters, booleans, and known refusal labels only.

## Review focus

1. The raw `entries` array or an entry object is mutated by the control normalizer; the no-mutation test must prove otherwise.
2. Ambient raw skew cancels the nominal injected drift; the normalized differential must still move exactly `-2 ms/s`.
3. A late legitimate `offset-step` leaves zero usable samples at 95 seconds; exactly one such reset may recover, while missing evidence, a different reset, or a second reset fails.
4. A real raw/production drift appears during recovery; it must fail immediately rather than wait for the cap.
5. Failure diagnostics are handed raw stats, IDs, SDP, or keys; the summary must omit them and retain only allowlisted detector state.

---

### Task 0: Extract the current semantics behind stable helpers

**Owner:** `@backend-developer`

**Files:**
- Modify: `desktop/scripts/voice-runtime-probe/witness-contract.mjs`
- Modify: `desktop/scripts/voice-runtime-probe/page.mjs`
- Modify: `desktop/scripts/voice-runtime-probe/run.mjs`

**Interfaces:**
- Produces:
  - `createFaultControlFork({ slopeMsPerSec = 2 } = {}) => (entries, elapsedMs) => { entries, normalized: false }`
  - `continuousCallDecision({ elapsedMs, requiredDurationMs, witnesses }) => 'continue' | 'verify'`
- Preserves: the current copied audio `remoteTimestamp + elapsedMs * (slopeMsPerSec / 1000)` ramp and fixed `elapsedMs < requiredDurationMs` cutoff. `witnesses` is accepted but not yet used.

- [ ] **Step 1: Extract the current control fork**

Move the exact current copied-report ramp out of `independentTick` into `createFaultControlFork`. Preserve which entry is copied and every current numeric operation. Return `{ entries: fork, normalized: false }`; do not introduce baseline normalization yet.

- [ ] **Step 2: Extract the current fixed deadline**

Have `continuousCallDecision` return `continue` while `elapsedMs < requiredDurationMs` and `verify` otherwise. Replace the loop's inline fixed-deadline branch with this helper without adding recovery.

- [ ] **Step 3: Verify extraction is behavior-preserving**

Run the existing focused Node tests. Expected: PASS with no changed runtime verdict, duration, or artifact shape. Review the diff specifically for mechanical extraction only.

- [ ] **Step 4: Checkpoint the behavior-preserving extraction**

```bash
git add desktop/scripts/voice-runtime-probe/witness-contract.mjs \
  desktop/scripts/voice-runtime-probe/page.mjs \
  desktop/scripts/voice-runtime-probe/run.mjs
git commit -m "refactor: extract voice probe evidence helpers"
```

---

### Task 1: Pin the pure helper and evidence-gate contract

**Owner:** `@test-writer`

**Files:**
- Modify: `desktop/scripts/voice-runtime-probe/witness-contract.test.mjs`

**Interfaces:**
- Consumes: Task 0 exports `createFaultControlFork` and `continuousCallDecision`, plus the actual `createAvSyncDriftDetector` from `desktop/src/renderer/services/voice/avSyncDriftDetector.ts` (Node 24+ type stripping; do not mirror the detector in the test).
- Produces: behavioral failing tests against the extracted old semantics; absence of an export is not a valid RED result.

- [ ] **Step 1: Add the positive-control normalization tests**

Add full paired inbound/remote-outbound fixtures accepted by the actual detector. Test that:

- at `t=0`, the returned differential equals the raw baseline;
- with ambient raw skew moving `+2 ms/s`, the extracted old `-2 ms/s` copied ramp cancels to a steady differential and does not trip the actual detector (control observation);
- assert the required behavior is a drift verdict after normalization, producing RED against the extracted implementation;
- at `t=60_000`, the normalized skew must be exactly baseline minus `120 ms`;
- a raw one-off offset jump does not alter that normalized trajectory;
- input arrays and entry objects remain deeply equal to a pre-call copy;
- incomplete, duplicate, or non-finite remote-outbound pairs are copied but not normalized.

- [ ] **Step 2: Add the measurement-window state tests**

Use exactly two compact witnesses and the extracted decision helper. Drive the actual detector through one `offset-step` at 90 seconds so it cannot rebuild its 60-second window by 95 seconds. Assert:

- `94_999 ms` returns `continue`;
- the extracted old behavior returns `verify` at `95_000 ms` (control observation), while the required behavior is `continue-recovery`, producing RED;
- a later time below `180_000 ms` with both peers usable and both controls tripped returns `verify`;
- either `independentDrift` or `productionDrift` returns `fail` even before the minimum and during recovery;
- no qualifying step, a different reset, a second `offset-step`, incomplete control evidence, or elapsed `180_000 ms` returns `fail` rather than recovery.

- [ ] **Step 3: Extend the redaction test**

Pass detector counters, known refusal labels, and injected secret/raw fields through `summarizeRuntimeWitnesses`. Assert that typed counters/booleans and known reasons survive, unknown labels are dropped, the lists are bounded, and raw stats, IDs, SDP, keys, and arbitrary strings do not appear in serialized output.

- [ ] **Step 4: Run the focused test and verify the new contract fails**

Run:

```bash
cd desktop
node --test scripts/voice-runtime-probe/witness-contract.test.mjs
```

Expected: FAIL only on the behavioral assertions: the actual detector remains steady under the old cancelled ramp, and the old fixed deadline returns `verify` rather than `continue-recovery`. All imports and pre-existing tests must pass.

- [ ] **Step 5: Checkpoint the test contract**

```bash
git add desktop/scripts/voice-runtime-probe/witness-contract.test.mjs
git commit -m "test: reproduce voice runtime detector flakes"
```

---

### Task 2: Implement deterministic control and bounded recovery

**Owner:** `@backend-developer`

**Files:**
- Modify: `desktop/scripts/voice-runtime-probe/witness-contract.mjs`
- Modify: `desktop/scripts/voice-runtime-probe/page.mjs`
- Modify: `desktop/scripts/voice-runtime-probe/run.mjs`
- Modify: `desktop/scripts/voice-runtime-probe/README.md`
- Test: `desktop/scripts/voice-runtime-probe/witness-contract.test.mjs` from Task 1; do not weaken its assertions.

**Interfaces:**
- Consumes: Task 1's exact tests and the existing `createAvSyncDriftDetector().observe(entries, observedAtMs)` interface.
- Produces:
  - `MAX_DURATION_MS = 180_000`
  - stable `createFaultControlFork({ slopeMsPerSec = 2 } = {}): (entries: Iterable<unknown>, elapsedMs: number) => { entries: unknown[], normalized: boolean }`
  - stable `continuousCallDecision({ elapsedMs, requiredDurationMs, witnesses }): 'continue' | 'continue-recovery' | 'verify' | 'fail'`
  - witness fields `independentOffsetStepCount: number`, `faultControlUsableCount: number`, and `faultControlRefusals: string[]`

- [ ] **Step 1: Repair `createFaultControlFork` in `witness-contract.mjs`**

Shallow-copy every object entry. Admit normalization only when exactly one `a:` and one `v:` `remote-outbound-rtp` entry have finite `timestamp` and `remoteTimestamp` values. Capture first-pair audio/video offsets plus `elapsedMs`. On each admitted call, preserve the baseline video offset and set the audio offset to `baselineAudioOffset - slopeMsPerSec * elapsedSeconds`; derive only the two copied `remoteTimestamp` values from the current report timestamps and return `normalized: true`. For invalid input, return copied entries with `normalized: false`. Do not mutate IDs, counters, timestamps, the iterable, or original entries.

- [ ] **Step 2: Repair `continuousCallDecision` and redacted summaries**

Validate `elapsedMs` and `requiredDurationMs` as finite integers in range. Check raw drift before duration readiness. Require exactly two witnesses, `independentUsableCount > 0`, and `injectedDetectorTripped === true` for `verify`. Below the minimum return `continue`. At/after the minimum return `continue-recovery` only when all other evidence is complete and exactly one peer has exactly one `offset-step`, zero usable raw verdicts, and no other discontinuity; otherwise return `fail`. During recovery, a usable raw verdict returns `verify`, while any second/different reset or `elapsedMs >= MAX_DURATION_MS` returns `fail`. Extend `summarizeRuntimeWitnesses` only with the fields listed in the spec and a fixed detector-reason allowlist capped to the detector's known vocabulary.

- [ ] **Step 3: Run the focused test and verify the pure implementation passes**

Run:

```bash
cd desktop
node --test scripts/voice-runtime-probe/witness-contract.test.mjs
```

Expected: PASS, including no-mutation, exact `-2 ms/s`, bounded recovery, drift-first, expiry, and redaction cases.

- [ ] **Step 4: Wire the normalized copy into `page.mjs`**

Create one fork closure per renderer peer. Keep `independent.observe(entries, observedAt)` first and unchanged. Pass only `fork(entries, elapsedMs).entries` to `faultControl.observe`. Count raw `offset-step` results, control usable results, known refusals, and the existing tripped latch. Do not reset either detector to obtain a pass.

- [ ] **Step 5: Wire the adaptive window into `run.mjs`**

Replace the fixed cutoff with elapsed-time polling governed by `continuousCallDecision` and capped at `MAX_DURATION_MS`. On every poll, in order:

1. assert continuous decoded/presented media and live tracks;
2. call `requireNoRuntimeFailure(markers)`;
3. evaluate measurement state;
4. throw immediately for `fail`;
5. finish only for `verify`;
6. continue for `continue`/`continue-recovery`.

Retain the final per-peer detector assertions as defense in depth. Do not move camera-reproduction or cleanup ahead of evidence completion.

- [ ] **Step 6: Update the probe README**

Document that the requested duration is the minimum, exactly one late `offset-step` may recover up to the 180-second hard cap, and missing/repeated reset evidence still fails. Recovery continues all real media/E2EE/error checks, and normalization affects only copied positive-control reports. State explicitly that raw healthy-call reports and the production sampler remain untouched.

- [ ] **Step 7: Run focused and static validation**

Run:

```bash
cd desktop
node --test --test-concurrency=2 scripts/voice-runtime-probe/local-sfu.test.mjs scripts/voice-runtime-probe/witness-contract.test.mjs scripts/voice-runtime-probe/audio-witness.test.mjs
npm run lint
npm run typecheck
```

Expected: all commands PASS. New helper branches must achieve at least 80% new-code coverage in source CI.

- [ ] **Step 8: Validate the real runtime gate through ordinary source CI**

Push the branch through the existing `Voice Runtime Probes` matrix. Require both Ubuntu and macOS jobs to execute the real probe and pass; a skipped/cancelled job is not evidence. Do not manually rerun a failure to manufacture acceptance. Confirm the artifact shows two peers, usable raw evidence, tripped controls, no raw/production drift, and no sensitive raw stats.

- [ ] **Step 9: Commit the harness and documentation**

```bash
git add desktop/scripts/voice-runtime-probe/witness-contract.mjs \
  desktop/scripts/voice-runtime-probe/page.mjs \
  desktop/scripts/voice-runtime-probe/run.mjs \
  desktop/scripts/voice-runtime-probe/README.md
git commit -m "fix: stabilize voice runtime drift evidence"
```

---

## Final validation and review gates

- [ ] Confirm no diff under `desktop/src/renderer/services/voice/avSyncDriftDetector.ts`.
- [ ] Confirm no workflow, dependency, sandbox flag, or timeout relaxation was added.
- [ ] Confirm 0 new blocker/critical issues.
- [ ] Confirm 0 new high-confidence security hotspots.
- [ ] Confirm at least 80% new-code coverage.
- [ ] Confirm `desktop/scripts/voice-runtime-probe/README.md` ships with the code.
- [ ] Run required Phase-8 reviewers: security-reviewer, code-reviewer, scope-reviewer, test analyzer, and docs-reviewer.


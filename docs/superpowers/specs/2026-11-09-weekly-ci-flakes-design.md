# Weekly CI flakes: Desktop voice runtime probe design

**Status:** Final design for the 2026-11-09 ad-hoc lifecycle run  
**Scope:** `Concord-Voice/Desktop` only; voice runtime probe fail-then-pass observations  
**Source baseline:** Desktop `b151bdc782a36c8ed4134ef31164bd44cc9e63d3`

## Problem statement

The real encrypted-voice runtime probe has two confirmed fail-then-pass shapes on unchanged tested code. One run completed the real-stats measurement but its copied-report positive control did not trip; another received an `offset-step` discontinuity late enough that one peer never rebuilt the detector's required 60-second window before the fixed 95-second call ended. The observed behavior is flaky fixture admission, not proof that the production A/V drift detector is wrong. The fixture currently adds a nominal drift to uncontrolled live skew, and it treats the minimum media duration as an absolute evidence deadline. Those choices make a healthy call fail without improving the production assertion.

## Goals

- Make the copied-report positive control deterministic without changing raw reports or production detector behavior.
- Preserve at least 95 seconds of continuous real audio/video/E2EE execution.
- Allow one late raw `offset-step` to rebuild a complete evidence window, bounded by 180 seconds total continuous-call time.
- Keep production drift and runtime failures fail-fast during both the minimum and recovery windows.
- Retain compact, allowlisted diagnostics that distinguish raw-detector recovery from positive-control failure.

## Non-goals and anti-goals

- Do not change `desktop/src/renderer/services/voice/avSyncDriftDetector.ts`, its thresholds, reasons, or discontinuity rules.
- Do not retry the workflow, restart Electron, skip a peer, or turn a missing/skipped observation into a pass.
- Do not mock `getStats()`, RTC objects, E2EE transforms, media counters, or the production sampler.
- Do not relax sandbox, context isolation, media progress, E2EE, or cleanup assertions.
- Do not add a new dependency or change a third-party API call.

## Constraints and invariants

1. **Production evidence stays raw.** `independent.observe(entries, observedAt)` continues to receive the unmodified merged `RTCStatsReport` snapshots. Any raw `independentDrift` or `productionDrift` fails immediately.
2. **Normalization is control-only.** Only a shallow copied iterable passed to the separate `faultControl` detector is normalized. The helper must not mutate an entry returned by `getStats()`.
3. **The control keeps real shape and identity.** Pairing identifiers, SSRCs, counters, report timestamps, and all non-`remoteTimestamp` fields remain copied from the real reports. The helper changes only the two selected `remote-outbound-rtp.remoteTimestamp` values.
4. **The control trajectory is exact.** On its first complete finite audio/video pair, capture the two offsets (`timestamp - remoteTimestamp`) and the observation time. On later samples, hold the video offset at its baseline and move the audio offset at exactly `-2 ms/s`. This makes differential skew equal `baselineSkew - 2 * elapsedSeconds`, independent of ambient raw skew and below the detector's `6 ms/s` offset-step ceiling.
5. **Malformed or incomplete input still refuses.** If the normalizer cannot identify exactly one finite namespaced audio and video `remote-outbound-rtp` entry, return copied entries without inventing data; the detector reports its ordinary refusal.
6. **Duration has minimum and cap semantics.** `MEDIA_PROBE_DURATION_MS` remains a required minimum in `95000..180000`. A recovery window is admitted only for exactly one late raw `offset-step` that prevented a peer from completing its first usable window; the continuous-call phase never exceeds `180000 ms`. Missing evidence, a different reset reason, or a second reset fails instead of receiving more time.
7. **Recovery is not a quiet period.** Every recovery poll still requires advancing decoded and presented frames, live source tracks, audio/video presence, no runtime marker failure, no production drift, and no independent drift. A second `offset-step` during recovery fails immediately.
8. **Two peers are required.** Completion requires each peer to have at least one usable raw independent verdict and a tripped separate control. Cancelled, missing, malformed, or skipped evidence cannot complete the gate.
9. **Diagnostics remain redacted.** Persist only counters, booleans, and a bounded set of known detector refusal labels. Never retain raw stats, IDs, SDP, keys, console arguments, or media content.
10. **Sandbox and cleanup remain fail-closed.** Keep `chromiumSandbox: true`, never add `--no-sandbox`, and continue treating Electron/app/SFU cleanup errors as failures.

## Dependency contracts consulted

- mediasoup-client 3.25.3 official API: `Transport.getStats()` returns a promise for an `RTCStatsReport`; the design continues to await the existing calls and does not alter the API surface.
- Playwright 1.64.1 Electron API: evaluation awaits returned promises, and `ElectronApplication.close()` can reject; the existing awaited evaluation and cleanup handling remain intact.
- [W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/): a report is a snapshot; local `timestamp` is the receiving endpoint's stats timestamp, while `remoteTimestamp` is sourced from the remote endpoint. Object identity/lifetime belongs to the report objects, so the control copies entries rather than mutating the snapshot.

No dependency API change is required.

## Approach options

### Option A: Retry the whole runtime job

This is operationally simple but converts a deterministic gate into probabilistic admission, repeats expensive Electron/SFU setup, and obscures whether the previously failing test executed successfully. Rejected.

### Option B: Always run for 180 seconds

This gives a late discontinuity time to recover, but doubles the normal critical path and does not fix the positive control's dependence on ambient skew. Rejected.

### Option C: Deterministic control plus bounded adaptive recovery

Normalize only the copied control trajectory, retain the raw detector unchanged, stop after the requested minimum when both peers have complete evidence, and admit bounded recovery only for one late raw `offset-step`. Recommended because it addresses both observed flake shapes while preserving every production assertion.

## Detailed design

### Pure helper ownership

Keep the new logic in the existing `desktop/scripts/voice-runtime-probe/witness-contract.mjs`; do not add a new file under `desktop/scripts/`, which would expand build/release path-classifier maintenance.

- `MAX_DURATION_MS = 180_000`
- `createFaultControlFork({ slopeMsPerSec = 2 } = {})` returns `(entries, elapsedMs) => { entries, normalized }`.
- `continuousCallDecision({ elapsedMs, requiredDurationMs, witnesses })` returns one of `continue`, `continue-recovery`, `verify`, or `fail`.

The API is introduced first as a behavior-preserving extraction: the fork applies the existing copied audio `remoteTimestamp + elapsedMs * 0.002` ramp and returns `normalized: false`; the decision returns `continue` before the fixed deadline and `verify` at it. Behavioral tests then fail against those old semantics. The repair keeps the signatures stable, changes only the fork internals, and adds the recovery/failure decisions.

`continuousCallDecision` returns `fail` immediately when either raw detector reports drift. It returns `verify` only at or after the required minimum and only when exactly two witnesses each have `independentUsableCount > 0` and `injectedDetectorTripped === true`. It returns `continue-recovery` only when all other evidence is complete and exactly one peer has exactly one `offset-step` and no usable raw window. A missing control, no qualifying step, a different/repeated reset, or reaching 180 seconds returns `fail`.

### Renderer fixture

`page.mjs` keeps the raw `independent` call first. It feeds the fork's shallow copy to `faultControl`, tracks the count of raw `offset-step` observations, control usable count and known refusal labels, and exposes those allowlisted values in `witness()`. It does not reset either detector merely to obtain a pass.

### Runtime orchestrator

`run.mjs` continues polling at five seconds. At every poll it first asserts continuous media and runtime health, then evaluates measurement state. `fail` throws immediately with the decision reason; `verify` exits only after the requested minimum; `continue` covers the ordinary minimum window; `continue-recovery` covers the sole admitted late-step recovery. Final E2EE, priority, extension, detector, camera-reproduction, and cleanup checks remain.

### Diagnostics

Extend `summarizeRuntimeWitnesses` with typed values only:

- `productionDrift`, `independentDrift`, `injectedDetectorTripped`
- `independentUsableCount`, `independentOffsetStepCount`, `faultControlUsableCount`
- bounded, allowlisted `independentRefusals`, `faultControlRefusals`

This makes the next failure actionable without storing RTC reports or identities.

## Decomposition

0. **Backend-developer prerequisite:** behavior-preserving extraction of the current copied ramp and fixed cutoff into the stable helper APIs. This must stay a no-op refactor.
1. **Test-writer:** use the actual production detector against the extracted old behavior; add behavioral RED tests for ambient cancellation and the late single-step deadline, plus no-mutation, repeated-reset, fail-fast, cap, and redaction cases.
2. **Backend-developer:** repair the stable helpers and wire `page.mjs`/`run.mjs`; update the probe README. This depends on the RED contract and is not parallelizable with step 1.
3. **Validation:** run focused Node tests, lint/typecheck, and source CI on both OS matrix variants. Do not manually rerun a failed workflow to manufacture a pass.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Normalization leaks into the raw detector | Low | Critical | Separate variables; no mutation test; production detector receives original `entries` first |
| Recovery hides genuine drift or chronic instability | Low | High | Drift fails before readiness; only one `offset-step` qualifies, and any other/repeated reset fails |
| Control normalization fabricates valid data from missing reports | Low | High | Normalize only exactly one finite audio/video pair; otherwise preserve refusal |
| Recovery raises CI time materially | Medium | Medium | Stop as soon as evidence is complete after the requested minimum; hard cap 180 seconds |
| Diagnostics retain sensitive RTC data | Low | High | Fixed keys, counters/booleans, refusal allowlist; tests inject secrets and assert absence |
| New helper file misses release classifiers | Low | Medium | Extend the existing `witness-contract.mjs`; create no new script module |

## Resolved design tensions

- **Fixed duration versus evidence completeness:** one isolated late `offset-step` may rebuild within the existing 180-second bound. General missing or repeatedly reset evidence still fails at the requested deadline.
- **Real-report control versus determinism:** real report structure and timestamps remain, while only the copied remote clock offsets are normalized. Raw production evidence is never normalized.
- **Fast failure versus recovery:** confirmed drift and media/runtime errors remain fail-fast; only the specifically admitted single late `offset-step` receives recovery time.

## Acceptance criteria

| Criterion | Required result |
|---|---|
| Confirmed flake reproductions | Pure tests reproduce ambient-skew cancellation and late-window reset; both pass after implementation |
| Production detector | No change to source, thresholds, refusals, or raw inputs |
| Runtime invariants | Real media, E2EE, progress, sandbox, runtime-error, camera-reproduction, and cleanup gates remain required |
| Duration | Minimum remains 95 seconds; only one late `offset-step` admits recovery; total continuous-call time is bounded at 180 seconds |
| Missing evidence | Two peers must execute and produce usable raw evidence plus a tripped control; missing/skipped evidence fails |
| Quality gate | 0 new blocker/critical issues |
| Security hotspots | 0 new high-confidence security hotspots |
| Coverage | At least 80% new-code coverage |
| Docs to update | `desktop/scripts/voice-runtime-probe/README.md` ships with the code and documents minimum/cap semantics and control-only normalization |


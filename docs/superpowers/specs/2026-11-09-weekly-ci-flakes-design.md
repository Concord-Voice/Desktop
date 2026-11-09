# Desktop voice runtime probe flake repair

Date: 2026-11-09
Scope: `desktop/scripts/voice-runtime-probe/**`; no production detector change.

## Evidence

Two Desktop CI attempts failed and then passed using the same tested code and SFU revision:

| Observation | Failed then passed | Failure |
| --- | --- | --- |
| Fault control | [42168457968/job 127730470645](https://github.com/Concord-Voice/Desktop/actions/runs/42168457968/job/127730470645) -> [attempt 2/job 127731561991](https://github.com/Concord-Voice/Desktop/actions/runs/42168457968/job/127731561991) | one copied-report detector did not trip |
| Usable raw witness | [42184335704/job 127781080205](https://github.com/Concord-Voice/Desktop/actions/runs/42184335704/job/127781080205) -> [attempt 2/job 127782312113](https://github.com/Concord-Voice/Desktop/actions/runs/42184335704/job/127782312113) | `offset-step` left one peer with no usable verdict before 95 s |

The report establishes nondeterminism, not a production detector defect. A behavioral regression test shows the old copied `+2 ms/s` ramp can be cancelled by opposing ambient skew; the late-reset observation is consistent with the detector's required 60-second window but does not prove its engine cause.

## Decision

- Keep `avSyncDriftDetector.ts`, production sampling, and raw independent observations unchanged.
- `createFaultControlFork` shallow-copies the reports and normalizes only a strict, SR-linked pair for each kind: inbound `remoteId` and remote-outbound `localId` must agree, timestamps must advance, and links must be unambiguous. It retains an unlinked mediasoup probationary report but rejects multiple legitimate publishers. After the first finite audio/video pair, it preserves copied video offset and imposes an exact 2 ms/s slope on copied audio offset. It changes no raw report entry, identity, counter, or production observation.
- Require at least 95 seconds of continuous real media. New observation cycles stop at 180 seconds. A cycle admitted from 175 through 179.999 seconds may finish by 185 seconds only with complete proof. Recovery is allowed only for exactly one peer with one raw `offset-step`, no other discontinuity, and no usable verdict in its current measurement window. `independentCurrentWindowUsable` describes retained-window proof, not only the latest tick; non-discontinuity refusals retain history.
- Drift, failed independent sampling, missing control evidence, media/E2EE/progress failure, or runtime error fails. Incomplete proof at or after 180 seconds fails and is not retried. Reset counts govern incomplete-window recovery, so early resets followed by a clean 60-second window by the base deadline may pass; a second/different reset during active incomplete extension fails at the next poll. The 185-second completion bound is internal, not a duration setting, and recovery cannot omit a peer.
- Normal five-second polls require both decoded and presented counter advancement. Only the terminal clamped short poll may retain the immediately preceding both-advancing proof, and only for the same consumer with nondecreasing counters and both ages within `VIDEO_STALL_MS`. It cannot chain retained proof or admit startup, a new consumer, stale frames, or counter regression. Camera reproduction remains strict.
- Diagnostics contain only counters, booleans, and an allowlisted detector-reason set; no IDs, keys, SDP, raw RTC reports, or console payloads.

## Validation and limits

The unit tests use the actual production detector for ambient-skew cancellation, raw-report immutability, late-step recovery, missing/repeated-reset rejection, and cap behavior. The real Electron probe remains the runtime proof; it must keep sandboxing, context isolation, real `getStats`, E2EE, frame progress, camera reproduction, and cleanup assertions. `MEDIA_PROBE_DURATION_MS` remains 95000..180000. No new dependency or script file is added.

The Desktop split has no count-refresh probe; its absence is a coverage gap, not a pass.

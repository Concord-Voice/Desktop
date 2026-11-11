# Issue 75 closeout: macOS per-process audio capture (Core Audio process taps)

**Status:** Design approved by the project lead on 2026-11-11, with pre-measurement decisions 1
to 5 (section 8) taken as recommended. Decisions 6 to 11 are still open. Nothing here is built.
**Date:** 2026-11-11
**Inputs:** design panel (architect, system engineer), an adversarial check of the panel's
spec against the code (8 claims confirmed, 2 wrong, 5 cuts, 5 gaps), ADR-0043.

## 1. What this is

The backend is on main and green in CI. The issue stayed open on evidence, and one criterion
is contradicted by what was measured. This work measures, records, and ships product code
only if the measurement calls for it. It does not rebuild the backend. Evidence is counters
only. No audio is stored anywhere.

## 2. Status of each acceptance criterion

| # | Criterion | Status | What closes it |
|---|---|---|---|
| 1 | JSF++ profile, `.mm` files in scope | Met. The self-test has no `.mm` case | One self-test case (section 6) |
| 2 | ASAN, UBSAN and fuzz green in the nightly | Met as written. `tap_backend.mm` itself is never sanitized, and `macos_partial_handle_test.mm` runs only locally | Cite the nightly runs; record the gap in the ADR |
| 3 | Below 14.4 `capability()` returns false with a reason | Met (scouted; lines re-checked when the ADR text is written) | Nothing |
| 4 | Consent refused or revoked degrades to video-only with an explanation | **Open, contradicted by measurement** | Section 3 |
| 5 | Real-machine app matrix | Partly: 2 of 6 rows recorded | Section 4 |
| 6 | ADR-0043 floor and consent findings | Met for what exists | Addendum (section 7) |
| 7 | Quality gate | No gate covers `desktop/native/**` (`sonar-project.properties:14`) | Lead decision 9 |

### Found during the issue 73 measurement review (verified)

The macOS tap stamps each callback in the `mach_absolute_time` domain
(`desktop/native/concord-audiocap/rt/platform/macos/tap_backend.mm`, near lines 65 to 88),
while the pump is seeded from `uv_hrtime()` (`desktop/native/concord-audiocap/napi/addon.cc`,
near line 1175). On Electron 45, `uv_hrtime` calls `mach_continuous_time` (read from a
disassembly of the shipped framework). The two differ by the total time the Mac has slept
since boot. Effects:

- `silentSinceStart` cannot latch until a capture outlives that sleep time plus the 10 s
  budget. It is a diagnostic counter (the child's liveness line and the host status), not a
  product path, so no user-visible behaviour changes; but the evidence it gives is wrong.
- Any latency figure for the real backend that compares the tap's stamp with main's clock
  carries the same offset.
- The comment at `tap_backend.mm` line 65 ("the SAME domain uv_hrtime reports") is false on
  this runtime, and the obligation stated in `rt/quantum_pump.h` near line 281 is broken.

Smallest fix: add the difference between `mach_continuous_time()` and `mach_absolute_time()`,
read back to back and converted, to every stamp; correct both comments; add a test that seeds
from the host clock and stamps through `nowStampNs`. It touches `rt/` and needs the JSF++
profile run. Lead decision 11: fix it in PR 1 of this issue (recommended, because criterion 4's
evidence reads these counters) or as its own issue.

## 3. Criterion 4: the decision

### Context

ADR-0043 records that the tap starts and every call returns `noErr` under denial
(lines 1029 to 1033), that a capture whose responsible process holds neither Screen Recording
nor Microphone runs and delivers silence (line 593, an unrecorded observation), that denying
the audio-only grant alone still carried signal, and that revoking that grant mid-share did
nothing to a running tap. A share that is live but silent is the failure the criterion forbids.
Which grant states are reachable inside Electron, and which are silent, has not been measured.

### Options

| Option | What it is | Assessment |
|---|---|---|
| A1 | Amend the criterion to the measured behaviour. No product code | Right only if no reachable state is silent |
| A2 | A synchronous grant read in main at share start that refuses with a reason | Right only for states measured silent. A wrong predicate removes app sound for every macOS user |
| A3 | A content-based silence detector | Rejected. ADR-0043 removed it (lines 1753 to 1763) and a quiet app trips it |

### Decision: measure first, then apply a rule that is fixed before measuring

Each consent cell (section 5) runs twice while a constant tone plays in the target. Every run
gets exactly one class:

| Class | Definition |
|---|---|
| `fault` | The start or the run reports a fault stage. A refusal with a reason is an acceptable outcome |
| `carries` | `callbackTotal` above 0, and `signalTotal / callbackTotal` at least half the ratio of the both-granted control |
| `silent` | `callbackTotal` above 0 and `signalTotal` equal to 0 |
| `dead` | `callbackTotal` equal to 0 and no fault. The renderer sees a live silent track, so this counts as silent |
| `other` | Anything else: a ratio above 0 but under half the control, the OS ending the process, two runs that disagree |

- **Rule A.** No enumerable cell is `silent`, `dead` or `other`. Ship A1. No product code.
- **Rule B.** Every enumerable `silent` or `dead` cell has a pair of grant readings that no
  `carries` cell has, and no cell is `other`. Ship A2 with the predicate set to exactly those
  pairs.
- **Rule C.** Stop; the lead decides and the issue stays open, if any of these hold: a cell is
  `other`; a silent cell shares its readings with a carrying cell; a silent cell reads
  `not-determined` for a grant the app never requests (the user cannot fix that in System
  Settings, and prompting for the microphone to enable app sound is a privacy decision); the
  mid-share revoke run silences or ends a running tap.

A cell where the window is not enumerable is refused today by an existing fence with the
reason `target-unresolved`. It is recorded, and whether that message is an adequate
explanation for a denied grant is lead decision 7.

### A2 design (built only under Rule B)

- `desktop/src/main/audiocapHost.ts`: add `'consent-unavailable'` to `ScreenAudioDegradeReason`
  and to `SCREEN_AUDIO_DEGRADE_REASONS`. Add a pure exported function
  `perProcessConsentRefused(platform, read)`; only the literal `'granted'` counts as held.
- In `startAudiocapHost`, in the synchronous refusal slot (near line 1005), when the handle is
  not `null`, the platform is darwin and the predicate holds: return
  `{ ok: false, reason: 'consent-unavailable' }`. No fork. The start-up capability probe passes
  `null` and is unaffected. The read is `systemPreferences.getMediaAccessStatus`, which is
  synchronous; `permissionManager.checkPermission` is async and
  `desktop/src/main/ipc/audiocap.ts` forbids an await at that point.
- `desktop/src/renderer/utils/policy/screenAudioDegradeCopy.ts`: one string, no remedy suffix.
  Proposed: "App sound needs a system permission that isn't turned on, so your screen is being
  shared without sound. Turn it on in System Settings, Privacy & Security, then restart the
  app." The lead signs the copy.
- `desktop/src/main/ipcContract.ts`: version 34 with a history note. `SPA_MIN_CONTRACT` stays 19.
- No new channel, no new request field, no PID anywhere, no addon in main.

### Consequences

- Rule A closes the issue with a reworded criterion and no product change.
- Rule B adds one refusal reason. It protects only the share start; a later revoke is covered
  by the mid-share revoke run's result, not by code.
- Every branch needs the lead to reword criterion 4.

## 4. The app matrix

Equivalent to the six rows of the Windows run sheet (ADR-0043 lines 724 to 725). Each row gets
an include run (the target plays; expect `carries`) and an exclude run (the target is silent
while `afplay` plays a tone; expect 0 signal callbacks).

| Row | Rendering shape | Recorded today | Who runs it |
|---|---|---|---|
| Chromium browser tab | Child audio service | 1163 of 1671 on macOS 26.6.2 | Agent. Re-run as the anchor between OS versions |
| Multi-process Electron app | Same shape as this client | A third-party comms app, 856 of 2315 | Agent, with a stock Electron window |
| Music player | Vendor mixer | None | Human presses play |
| Media player | Direct Core Audio path | None | Agent if playback starts unattended, else human |
| Windowed 3D game | Low-latency engine path | None | Human |
| Java app | JVM audio stack | None | Human |

Carried forward and not re-run: the refusal of a launchd-parented browser (`target-unresolved`,
recorded). The host-subtree exclusion check (0 of 2984 on 26.6.2) protects against echoing the
call; lead decision 3 says whether it is re-run on this OS.

An include run with 0 signal and no fault is a finding for the lead, never a pass.

## 5. Consent cells and the runner

**Runner.** A new sibling of the existing target probe, `desktop/scripts/audiocap-matrix-probe/`
(`main.js`, `package.json`), not wired to CI. It forks the production capture child as the
existing probe does (`desktop/scripts/audiocap-target-probe/main.js`), needs no media server,
and never reads audio: it keeps the port but attaches no listener.

- Arguments: `--label` (required; printed instead of the window title, which can be private),
  `--title` or `--window-id`, `--seconds`.
- It reads both grant statuses, enumerates with the same `desktopCapturer.getSources` call the
  product fence uses, and records `enumerable`.
- After stop it reads the child's liveness line and prints one row: OS build, Electron
  version, build kind, both statuses, `enumerable`, fault stage, `signalTotal`,
  `callbackTotal`, `quantaTotal`, `overrunTotal`. Never a PID, never a title.

**Cells.** Run under the development Electron bundle's own identity
(`open -n -W -a desktop/node_modules/electron/dist/Electron.app --args <runner dir> ...`).
The check that this identity is the one being toggled: the runner's reading must change after
each toggle, otherwise stop.

| Cell | Screen Recording | Microphone | Needed to close |
|---|---|---|---|
| C1 | granted | granted | Yes: the control |
| C2 | granted | denied | Yes |
| C3 | denied | granted | Yes |
| C4 | denied | denied | Yes: replaces the unrecorded claim at ADR line 593 |
| C5 | after a reset | after a reset | Yes: record the prompts seen |
| R1 | 60 s run; the human turns each gating grant off at about 20 s | | Recommended (lead decision 4) |
| P1 | Locally packaged build, grants held, in a call | | Recommended under every rule (lead decision 2) |
| P2 | Packaged build, the refusal message visible in one light and one dark theme | | Rule B only |
| D1 | Runner launched from a terminal, no toggling | | Rule B only |

P1 cannot produce counters: a packaged build discards the child's liveness line
(`desktop/src/main/audiocapChild.ts`, near line 979). Its evidence is a person hearing the app
sound on a second client. The original failure this criterion names was a packaging fault,
which is why P1 is recommended even under Rule A.

Recorded as residuals, not run: macOS versions from 14.4 other than the two measured; Intel
hardware; a Developer-ID-signed build; the audio-only grant as a third factor (noted per run
from System Settings, since Electron cannot read it).

**Procedure.**
1. `cd desktop && npm run build:main && npm run build:native`. No `npm install` until the
   session ends: it re-signs the bundle and resets its grants.
2. The human grants Screen Recording and Microphone to the Electron bundle.
3. The agent runs C1, the agent rows of the matrix, and the anchor row.
4. The human runs the human rows, then toggles for C2, C3 and C4, resets for C5, and does R1.
5. The agent classifies every run and applies the rule.

The human part is about 30 to 45 minutes at the Mac. The development bundle's identifier is
shared by every Electron checkout on the machine, so a grant reset affects those too.

## 6. Test strategy

| What | Type | Where | Who |
|---|---|---|---|
| `.mm` self-test case, named with its `AV` rule number so it cannot pass on the wrong diagnosis; the existing `.cc` case gets the same name fix | Shell self-test | CI, the JSF++ profile job | Test agent |
| Removing `.mm` from the checker's walk turns the named case red | Mutation, local | Developer machine | Test agent |
| The runner prints one row with no PID and no title | Local run | Developer machine | Agent |
| Consent cells, R1 | Hardware measurement, recorded once | Developer machine | Agent runs, human toggles |
| Matrix rows | Hardware measurement, recorded once | Developer machine | Agent and human |
| Rule B: the predicate for every status pair and for non-darwin | Vitest unit, injected reader | CI | Test agent |
| Rule B: a refusal does not fork, returns the new reason, ignores a `null` handle; a later start with grants held forks | Vitest unit | CI | Test agent |
| Rule B: the copy map is exhaustive, with no remedy suffix | Vitest unit | CI | Test agent |
| Rule B: deleting the check turns a test red | Mutation, local | Developer machine | Test agent |
| P1, P2 | Manual, in a call | Packaged build | Human |

Nothing measured here becomes a standing CI test: it needs real grants and real applications.

## 7. Changes, in two pull requests

**PR 1, no product change.** It references the issue and does not close it; its branch name
must not start with the issue number.
- New `desktop/scripts/audiocap-matrix-probe/main.js` and `package.json`.
- `scripts/test-check-native-jsf-profile.sh`: the two case changes in section 6.
- `.claude/rules/domains/native-audio.md`, lines 222 to 229: on darwin the shipped target has a
  producer and a start with no target returns `NoTarget`; elsewhere it returns `NoBackend`.

**PR 2, after the measurement and the lead's decisions.**
- `docs/adr/0043-per-process-screen-share-audio-capture.md`: a new addendum with the macOS
  verification table (rows, OS build, counters), the consent table (readings, `enumerable`,
  class), the rule and the branch that fired, the R1 result, the residual list, and the CI gap
  for the partial-handle test. Line 593: replace the unrecorded claim with the measured cells
  and remove its last sentence, which cites the removed silence detector.
- Rule B only: the three product files in section 3, `.claude/rules/domains/electron.md`, the
  changelog if one exists, and the unit tests.

Out: any workflow edit, any `rt/` change, a README section for the runner (its usage lives in
the file header, as for the existing probes).

## 8. Decisions that belong to the project lead

Before the measurement:
1. Approve the outcome classes and Rules A, B and C as written.
2. P1 is required to close under every rule (recommended), or is a residual.
3. Re-run the host-subtree exclusion check on this OS in the same in-call session as P1
   (recommended), or carry the 26.6.2 result forward.
4. Run R1 (recommended), or record the Screen Recording and Microphone revoke as a residual.
5. Whether "not run, with a reason" is acceptable for the game and Java rows.

After the measurement:
6. The wording of criterion 4. Proposed under Rule B: "A per-process share started in a grant
   state measured to deliver silence is refused to video-only with an explanation. Revoking a
   grant mid-share has the measured effect recorded in ADR-0043. Unmeasured states are listed
   there as residuals." Under Rule A the first sentence becomes "No reachable grant state was
   measured to deliver a silent live track."
7. Whether the existing `target-unresolved` message ("share a whole screen to include sound")
   is an adequate explanation when the cause is a denied grant. The whole-screen path may need
   the same grant (inferred, not measured).
8. Rule B: the copy, and the edit to `desktop/src/main/ipcContract.ts` (a protected path).
9. Criterion 7: native code is outside the configured quality gate. Proposed: the pull request
   records coverage for the merged TypeScript that is in scope, states the native gap, and the
   criterion is narrowed in those words.
10. Follow-up issues: the partial-handle test in CI (needs a workflow push), and the
    whole-screen loopback path under the same grant states. The stale lines in the issue body.
11. The tap's clock-domain mismatch (section 2): fix in PR 1 (recommended) or as its own issue.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The grant check refuses wrongly on packaged builds | Medium until measured | Predicate limited to measured cells; P1 and P2 |
| `open` does not give the runner its own identity | Medium | The reading must change after each toggle, else stop |
| New rows are on a newer OS than the recorded ones | Certain | The anchor row is re-run; the OS build is on every row |
| Rule C fires and the issue cannot close | Low to medium | Stated up front as the lead's decision |
| A reading is stale until the app restarts | Medium | The copy says to restart; D1 and P2 check it |
| Human-only rows are never run | Medium | Lead decision 5 |

## 10. Not in this work

The Windows backend. A silence detector. Polling grants during a share. Prompting for the
microphone from the share path. The launchd-parented browser limitation. Any `rt/` change. Any
workflow edit. New IPC channels. OS versions or hardware we do not have. Any stored audio.

## 11. Not verified

Whether another application's window is enumerable without Screen Recording. Whether
`getMediaAccessStatus` is stale until restart. Whether `tccutil reset` works without elevated
rights on this OS. Whether the capture child tolerates 60 s with no consumer (read in code, not
run). Whether `desktop/scripts` is linted. The nightly run history beyond the last three runs.

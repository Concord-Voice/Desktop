# Issue 75 closeout (macOS process-tap evidence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the measured evidence that lets issue 75 close honestly: a local runner that records capture counters per grant state and per application, a fixed rule that turns those counters into a decision on criterion 4, and the record in ADR-0043.

**Architecture:** A new sibling of the existing target probe forks the production capture child, reads only the child's end-of-run liveness counters, and prints one JSON row per run. A pure classifier turns rows into outcome classes and applies Rules A, B and C from the spec. PR 1 changes one shipped file: the macOS tap's clock domain in `rt/platform/macos/tap_backend.mm` (decision 11, taken as "fix in PR 1", Task 4). Any other product code changes only if Rule B fires.

**Tech Stack:** Electron 45 main process (plain JavaScript, as the other probes), Node ESM for the classifier, Vitest for its tests, bash for the JSF++ self-test.

**Spec:** `docs/superpowers/specs/2026-11-11-75-macos-tap-closeout-design.md` (approved 2026-11-11; pre-measurement decisions 1 to 5 taken as recommended; decision 11 taken as "fix in PR 1"; decisions 6 to 10 open).

## Global Constraints

- No audio is stored, printed or committed. The runner never attaches a listener to the capture port. Tone files live in scratch and are never committed.
- Every printed row carries `--label`, never a window title, and never a PID (invariant I-PID).
- The addon is never loaded in main or a renderer (ADR-0043 D5). The runner's main process reads grants and enumerates windows only.
- Public repository: write "a third-party comms app"; no private-repository issue numbers; agent names in backticks.
- PR 1 branch `chore/audiocap-macos-matrix-probe`; PR 2 branch `docs/audiocap-macos-verification` (or `feature/audiocap-consent-refusal` under Rule B). Neither starts with the issue number; both say `Refs #75` until the lead approves closing.
- Each branch is cut from a clean `origin/main`. Stage B is serialized behind issue 73 in the shared worktree.
- No `npm install` during the hands-on session: it re-signs the Electron bundle and resets its grants.
- `rt/` code obeys the JSF++ profile; any `rt/` edit runs `scripts/check-native-jsf-profile.sh`.

## Review Focus

1. The child dies or prints no liveness line: the row must say so, never read as `silent` with zero counters. Null counters with no fault stage are `other` (Rule C), never `fault` or `silent`; only a fault stage makes a run `fault`. Pinned by Task 1 test `parseLiveness returns null when the line is absent` and `classifyConsent of null counters is other`.
2. stderr arrives in chunks that split the liveness object mid-key: parsing the joined buffer must give the same counters. Pinned by Task 1 test `parseLiveness reads a line split across chunks`.
3. A cell whose window is not enumerable is silent for a reason the product already refuses: when Screen Recording does not read granted or the enumeration failed, it must not decide Rule A or B. Pinned by Task 1 test `a non-enumerable silent cell does not block Rule A`.
4. Two runs of one cell disagree: that must stop the rule, not average. Pinned by Task 1 test `disagreeing runs make the cell other and the rule C`.
5. A grant reads an unrecognised value, one that is not among the five strings `getMediaAccessStatus` returns: only `'granted'` counts as held. Pinned by Task 1 test `an unrecognised reading is a distinct pair, never held`.

---

## PR 1: the runner, the self-test cases, the rules correction

### Task 1: Classifier and rule (pure)

**Files:**
- Create: `desktop/scripts/audiocap-matrix-probe/classify.mjs`
- Test: `desktop/scripts/audiocap-matrix-probe/classify.test.ts` (`// @vitest-environment node`, written first by `test-writer`)

**Interfaces:**
- Produces, all exported from `classify.mjs`:
  - `parseLiveness(stderrText: string): Counters | null`. `Counters = { callbackTotal, quantaTotal, signalTotal, overrunTotal, destroyFailures: number; silentSinceStart, faulted, poisoned, quiesceProved: boolean }`; `faulted` and `poisoned` read `true` unless the child printed `false`. Reads the last `[audiocap] liveness { ... }` block the child prints (`desktop/src/main/audiocapChild.ts`, near line 1002; Node's inspect format, `key: value` pairs). `null` when absent or any numeric field is missing.
  - `classifyConsent(counters: Counters | null, faultStage: string | null, controlRatio: number): 'fault' | 'carries' | 'silent' | 'dead' | 'other'`. Definitions from spec section 3: `fault` only when `faultStage` is set; with no fault stage, unreadable counters are `other` (null, `faulted` or `poisoned` not `false`, or `destroyFailures` above 0); `dead` when `callbackTotal === 0`; `silent` when `callbackTotal > 0` and `signalTotal === 0`; `carries` when `signalTotal / callbackTotal >= controlRatio / 2`; `other` otherwise.
  - `classifyMatrix(kind: 'include' | 'exclude', counters, faultStage): 'pass' | 'leak' | 'finding'`. An exclude row with `signalTotal > 0` is `leak`, even when the run also faulted. Otherwise a fault stage, unreadable counters or `callbackTotal === 0` is `finding`; include passes on `signalTotal > 0` and exclude on `signalTotal === 0`.
  - `classifyRevoke(counters, faultStage, control: Counters, controlSeconds: number, seconds: number): 'no-effect' | 'silenced' | 'stopped' | 'fault' | 'other'`. With `r = signalTotal / callbackTotal` and `rc` the control's ratio: `fault` on a fault stage; `other` on unreadable counters (as in `classifyConsent`) or when the expected count below is not above 0; `stopped` when `callbackTotal < 0.9 x (control.callbackTotal / controlSeconds) x seconds`; `no-effect` when `r >= 0.95 x rc`; `silenced` when `r <= 0.5 x rc`; `other` otherwise.
  - Ruling (planning): a matrix include row passes on `signalTotal > 0`, not on the ratio rule. The ratio rule assumes a constant tone (spec section 3); application content is not constant, and the recorded baselines (856 of 2315, 1163 of 1671) would fail it. The ratio is still printed.
  - `applyRule(cells: Cell[], revoke: string | null, neverRequested: string[]): { rule: 'A' } | { rule: 'B', predicate: Array<{ screen: string, microphone: string }> } | { rule: 'C', reasons: string[] }`. `Cell = { id, screen, microphone, enumerable: boolean, runs: string[] }`. A cell's class is its runs' class when they agree, else `other`. Rule C reasons, any of: a cell is `other`; the control `C1` is missing or not `carries`; a counted `silent` or `dead` cell has the same `(screen, microphone)` pair as a `carries` cell; a counted `silent` or `dead` cell reads `'not-determined'` for a grant in `neverRequested`; `revoke` is anything but `no-effect`, `fault` included. Otherwise Rule B when at least one counted cell is `silent` or `dead` (the predicate is the set of those pairs), else Rule A. Every cell is counted except an excused one (`enumerable` false, and Screen Recording not `'granted'` or `enumerationFailed`), and that one is left out only when it is `silent` or `dead`: an excused `other` cell still gives Rule C, and an excused `carries` cell still counts. `applyRule` does not check that the evidence is complete; the CLI does (below).
  - `incompleteCells(cells, revokeRuns): string[]`, the spec section 5 completeness reasons: each of C1 to C5 has two runs; C1 to C4 read their section 5 pair and C5 does not read the control's; R1 has a row, runs at least 60 s, starts `granted`/`granted` and ends with a grant not held.
  - CLI: `node classify.mjs <rows.jsonl> [--never-requested screen,microphone]` (`--never-requested` defaults to both; `''` names none) prints every row's class, the rule, and the predicate or the reasons. Besides `applyRule`'s reasons it gives Rule C on the evidence checks in spec section 3: any `incompleteCells` reason; a row with no `runId` (an identical row with a repeated `runId` is counted once, and a row that repeats a `runId` with any value changed gives Rule C with a reason naming only the two line numbers); a consent or revoke run with no window id, or consent and revoke runs on more than one window; consent and revoke runs from more than one OS build or Electron version (matrix rows do not feed the rule, so the OS build, Electron version and window id checks skip them); a consent run whose grants read after it (`screenAfter`, `microphoneAfter`) differ from those read before it; a consent run with an after-reading that is missing or not one of the known values (`granted`, `denied`, `restricted`, `not-determined`, `unknown`); a consent run whose start reading (`screen`, `microphone`) is not one of those values; a consent run that reads `unknown` for either grant, before or after it, which fails closed although `unknown` is one of those values (unlike an unrecognised value, it is printed in the reason); a consent run labelled anything but C1 to C5, whose reason names the label only when it matches the runner's `--label` pattern `^[A-Za-z0-9._-]{1,64}$`; a row whose `runId` is not a version 4 UUID; a consent or revoke run with no OS build (null included) or an Electron version of another form; a consent or revoke run whose window id is not a whole number from 1 to 4294967295; a consent or revoke run whose `seconds` is not a whole number from 1 to 600, whose counters are neither null nor five whole numbers from 0 to 4294967295 (u32, as the addon sets them) with `signalTotal` no more than `callbackTotal`, and four booleans, or whose fault stage is neither null nor one of the child's stages or the runner's `unknown`; a consent or revoke run whose `enumerable` or `enumerationFailed` is not a boolean, or that is enumerable with a failed enumeration; a revoke run whose label is missing or does not match `^[A-Za-z0-9._-]{1,64}$`; a revoke run that reads one grant off after it while the other is missing or unrecognised. A reason line never prints an unrecognised value, since it did not come from the runner, and no output line prints a row value as given: a label, cell id, grant reading or fault stage only when it matches `^[A-Za-z0-9._-]{1,64}$`, a flag only as a boolean, a window id, count or R1 length only as a whole number in range, else `(unprintable)`, `unrecognised counters` or `for an unrecorded time`; a row's line starts with `row` and an unenumerable cell's with `cell`, so no label can start a line. Rows file shape is Task 2's row.

- [ ] **Step 1 (`test-writer`): write `classify.test.ts`.** Cases, with these values: the five Review Focus tests above; `carries` at ratio 0.5 against control 1.0 and `other` at 0.49; `silent` at 0 of 2000; `dead` at 0 callbacks with no fault; a fault stage `target` is `fault`; matrix include 856 of 2315 passes; matrix exclude 1 of 2984 is `leak`; revoke 0.95 x control is `no-effect`, 0.3 x control is `silenced`; Rule A with C1 to C4 all `carries`; Rule B with C4 `silent` on `('denied','denied')` gives that pair alone; Rule C when C4 `silent` shares its pair with a carrying cell; Rule C when `revoke === 'silenced'`. Use a liveness fixture copied from the child's `console.warn` call shape, not from a run.
- [ ] **Step 2:** `cd desktop && npx vitest run scripts/audiocap-matrix-probe/classify.test.ts`. Expected: FAIL, cannot find `./classify.mjs`.
- [ ] **Step 3 (producer):** implement `classify.mjs`. No imports beyond `node:fs` for the CLI.
- [ ] **Step 4:** same command. Expected: PASS, every case.
- [ ] **Step 5:** commit `test: add the classifier for the macOS capture evidence runner` with `Refs #75`.

### Task 2: The runner

**Files:**
- Create: `desktop/scripts/audiocap-matrix-probe/main.js`, `desktop/scripts/audiocap-matrix-probe/package.json` (same shape as `desktop/scripts/audiocap-target-probe/package.json`)

**Interfaces:**
- Consumes: `parseLiveness` (Task 1).
- Produces: one stdout line `ROW <json>` per run, `<json>` = `{ runId, label, kind, osRelease, osVersion, osBuild, electron, buildKind: 'development', screen, microphone, screenAfter, microphoneAfter, windowId, enumerable, enumerationFailed, faultStage, counters, seconds }` (each field as spec section 5 lists it), where `kind` is `consent`, `include`, `exclude` or `revoke` from `--kind`, `screenAfter` and `microphoneAfter` are the grants read again after the run, and `counters` is `null` when the child printed no liveness block. Then exit 0. Exit 2 with `FAIL <reason>` when it could not run.

- [ ] **Step 1:** Arguments: `--label` (required), exactly one of `--title` or `--window-id`, `--kind` (required), `--seconds` (default 20). Refuse with exit 2: not darwin; `app.isPackaged`; a missing or malformed argument; no window matching `--title`.
- [ ] **Step 2:** In main: read `systemPreferences.getMediaAccessStatus('screen')` and `('microphone')`; enumerate with the same `desktopCapturer.getSources` call and options that `desktop/src/main/ipc/audiocap.ts` uses for its fence (copy them; cite the line in a comment); `enumerable` is whether the target's id is in the result. The window handle is parsed from the source id as `desktop/scripts/audiocap-target-probe/main.js` does.
- [ ] **Step 3:** Fork `dist/main/audiocapChild.js` exactly as `runStart` in the target probe does (same `start` message, same `hello` wait), with three differences: stderr and stdout are buffered and never echoed; `port2` is kept referenced and gets no listener; the run lasts `--seconds`. Then `stop`, wait up to 10 s for the liveness block in the buffer, kill the child, print the row.
- [ ] **Step 4 (verification, agent alone, current grants):** `cd desktop && npm run build:main && npm run build:native`, then run against one open window, in the terminal form, which reads the terminal's grants. The runner bounds itself (its `setTimeout` to `fail('timeout')` kills the child and exits); the outside bound is a backstop, a perl alarm (`timeout` is not on every supported macOS release) on the Electron binary itself, not on `./node_modules/.bin/electron`: that is a Node wrapper that forwards only SIGINT, SIGTERM and SIGUSR2, so an alarm on it ends the wrapper and leaves Electron running. `perl -e 'alarm 60; exec @ARGV' "$(node -p "require('electron')")" scripts/audiocap-matrix-probe --label t1 --title <part of that window's title> --kind consent --seconds 5`. The runner kills the capture child only on its own exit path, so after an alarm ends the run, check for a leftover `Electron` or `Electron Helper` process (Activity Monitor, filtered by name) and stop it before the next run. `--title` matches the window's title, not its application's name. Expected: one `ROW` line, exit 0 (the counters may be any class: the grants are whatever this machine has). Then `--window-id 4294967294`. Expected: a row with `faultStage: 'target'`. Then grep the captured output for the `--title` substring and for `pid`. Expected: no match for either.
- [ ] **Step 5:** commit `chore: add the macOS capture evidence runner` with `Refs #75`.

### Task 3: JSF++ self-test cases and the rules-file correction

**Files:**
- Modify: `scripts/test-check-native-jsf-profile.sh:113`, `.claude/rules/domains/native-audio.md:222-229`

- [ ] **Step 1:** Rename the case at line 113 to `"AV 208 throw in a .cc file"` and add after it `expect_fail "AV 208 throw in a .mm file" 'void f() { throw 1; }' mm`. The `AV 208` prefix pins each case to its rule (see `expect_fail`, lines 26 to 54), so a checker that stops walking `.mm` fails with "contains no C++ sources" and the case reads CAUGHT BY THE WRONG RULE.
- [ ] **Step 2:** `bash scripts/test-check-native-jsf-profile.sh`. Expected: every case passes.
- [ ] **Step 3 (mutation, then restore):** remove `".mm"` from the tuple at `scripts/check-native-jsf-profile.sh:344`, re-run. Expected: the `.mm` case reports CAUGHT BY THE WRONG RULE and the suite exits non-zero. Restore the line; `git diff scripts/check-native-jsf-profile.sh` must be empty.
- [ ] **Step 4 (`docs-writer`):** `native-audio.md` lines 222 to 229: on darwin the shipped target has a producer, and a start with no target returns `NoTarget`; elsewhere it returns `NoBackend` (`.github/workflows/native-audiocap.yml`, near lines 310 to 315). The build command for the synthetic target is `npm run build:native -- --synthetic` (`desktop/scripts/build-native.mjs`), not a raw `node-gyp` call. The issue 73 pull request adds a paragraph to the same section: whichever merges second rebases.
- [ ] **Step 5:** commit `test: pin the JSF++ self-test extension cases to their rule` and, separately, `docs: correct the shipped-target behaviour in the native-audio rules`, both `Refs #75`.

### Task 4 (decision 11 taken as "PR 1"): the tap's clock domain

**Files:**
- Modify: `desktop/native/concord-audiocap/rt/platform/macos/tap_backend.mm:65-88`, the comment near `desktop/native/concord-audiocap/test/rt_contract_test.cc:2903`
- Test: the local macOS test file that already reaches the backend's internals (`macos_partial_handle_test.mm`; read the addon README near lines 238 to 240 for how it is built)

- [ ] **Step 1 (`test-writer`):** a test that `nowStampNs(nullptr)` is within 1 ms of `hostTimeToNs(mach_continuous_time())`. It prints the current `mach_continuous_time() - mach_absolute_time()` and reports VACUOUS, not PASS, when that is under 1 s (a machine that has not slept since boot cannot tell the domains apart).
- [ ] **Step 2:** run it. Expected: FAIL by the sleep offset (this machine has slept).
- [ ] **Step 3 (`senior-engineer`):** move both branches of `nowStampNs` into the `mach_continuous_time` domain: the `mHostTime` branch adds the continuous-minus-absolute offset (`sleepOffsetTicks`, read back to back) in host ticks before its single conversion, so a 0 timebase still yields 0; the fallback reads `mach_continuous_time` directly; correct the comment at line 65 and the test comment near line 2903.
- [ ] **Step 4:** run the test (PASS), `bash scripts/check-native-jsf-profile.sh` (clean), `npm run build:native` (links).
- [ ] **Step 5:** commit `fix: stamp macOS tap callbacks in the clock domain the pump is seeded from` with `Refs #75`. Record in the PR that this test is local-only, like the partial-handle test.

### Task 5: PR 1

- [ ] Draft PR per `/dev-lifecycle` Phase 5, then `/pr-creation`. Body: what the runner records and never records; the self-test mutation result; criterion 2 evidence (the last three nightly runs of the sanitizer and fuzz legs, by run link) and its gap (`tap_backend.mm` is never sanitized); criterion 3 evidence (the cited lines, re-read); criterion 7 as proposed in lead decision 9 (vitest coverage of the merged in-scope TypeScript: `desktop/src/main/audiocapChild.ts`, `audiocapHost.ts`, `ipc/audiocap.ts`; the native code is outside the configured gate); decision 11 as taken (the clock-domain fix ships in this PR); the open decisions 6 to 10.

## Hands-on session (needs the project lead at the Mac, about 30 to 45 minutes)

### Task 6: Measure

- [ ] **Step 1:** `cd desktop && npm run build:main && npm run build:native`. The lead grants Screen Recording and Microphone to the development Electron bundle.
- [ ] **Step 2:** The agent opens a Chromium tab that plays a constant tone (an oscillator page in scratch) and runs C1 twice with `--kind consent`. Rows go to a scratch `rows.jsonl`, never into the repository. C1's ratio is the control.
- [ ] **Step 3:** The agent runs its matrix rows (spec section 4), include and exclude, with the OS build on every row. The lead runs the music player, game and Java rows (or marks one "not run" with a reason, decision 5).
- [ ] **Step 4:** The lead toggles for C2, C3 and C4 (each run twice), resets for C5 and records the prompts seen (leave any prompt unanswered until that run's `open` returns, and reset again before C5's second run: spec section 5, step 4), then R1: a 60 s `--kind revoke` run with each gating grant turned off at about 20 s. After every toggle the agent checks that the row's readings changed; if not, stop (the runner's identity is not the one being toggled).
- [ ] **Step 5:** P1 (decision 2): a locally packaged build in a two-client call; the lead confirms the far client hears the shared window's sound. In the same session, re-run the host-subtree exclusion check (decision 3).
- [ ] **Step 6:** `node scripts/audiocap-matrix-probe/classify.mjs <scratch>/rows.jsonl`. Record the rule that fired. Rule C stops here for the lead.

## PR 2: the record (and product code only under Rule B)

### Task 7: ADR-0043 addendum (`docs-writer`)

- [ ] The addendum and the line 593 correction exactly as spec section 7 lists them; the counters from `rows.jsonl`; the residual list; the CI gap for the partial-handle test; the clock-domain finding and what was done about it. Commit `docs: record the macOS process-tap verification in ADR-0043`.
- [ ] Correct the comment at `.github/workflows/native-audiocap.yml` line 282: the shipped target refuses a start with no target (`NoBackend` off darwin, `NoTarget` on darwin), not "no producer at all -> NoBackend". It needs a push with workflow scope, so it rides PR 2.
- [ ] In the addendum, record whether `desktop/scripts/audiocap-matrix-probe/` is kept as a committed, re-runnable probe (as the target probe is) or removed after the session.
- [ ] In the PR body, not in the repository: the list of stale statements in the issue body (spec section 8, decision 10) for the lead to edit, and decisions 6 to 9 with the measured numbers beside them.

### Task 8 (Rule B only): the start-time refusal

**Files:** as spec section 3, "A2 design".

- [ ] **Step 1 (`test-writer`):** the four Rule B rows of spec section 6, with the predicate set to exactly Task 6's measured pairs.
- [ ] **Step 2:** run them. Expected: FAIL (no such function or reason).
- [ ] **Step 3 (`frontend-developer`):** `perProcessConsentRefused(platform: NodeJS.Platform, read: (k: 'screen' | 'microphone') => string): boolean` in `desktop/src/main/audiocapHost.ts`; the refusal in the synchronous slot near line 1005; `'consent-unavailable'` in both reason lists; the copy; contract version 34. The mutation in spec section 6 must turn a test red.
- [ ] **Step 4:** the tests pass; the audiocap and screen-audio suites stay green.
- [ ] **Step 5:** D1: the runner launched from a terminal with no toggling; its reading must agree with the tap's class, or Rule C (spec section 3).
- [ ] **Step 6:** P2 in one light and one dark theme (the lead, in a call). Commit `feat: refuse a per-process share in a grant state measured to be silent`.

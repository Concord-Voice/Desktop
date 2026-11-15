# Issue 213: settle `reapChild`'s spawn listener (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ADR and the code agree that `reapChild`'s `once('spawn')` listener needs no bound, stop the crash path from reaping a child that has already exited, and pin both with tests.

**Architecture:** One small behaviour change in `retire`, a rewritten `reapChild` comment, new Vitest cases, a kept headless probe, and a dated ADR-0043 entry with pointers to it.

**Tech Stack:** TypeScript, Vitest (in `desktop/`), Markdown.

**Spec:** `docs/superpowers/specs/2026-11-15-213-reapchild-spawn-listener-design.md`

## Global Constraints

- Do not change `reapChild`'s body. The only behaviour change is that `retire` skips the reap on the crash path. Under D5, nothing in the addon changes.
- Keep the shared `makeChild` fake as it is. It keeps one handler per event. New cases use a local EventEmitter-backed child, so every listener runs and can be counted.
- New text in this public repository cites no private pull-request or issue numbers, and the probe prints no PIDs.
- The pull request body says `Closes #213`.

## Review Focus

1. Someone later adds a timer to the reap. Test 1 must fail on its own assertion, whatever the timer's duration.
2. The crash path: an `exit` on a live session must make no `kill()` call and arm no spawn listener.
3. Every other reap site, `error` included, must still re-kill a child that spawns late.

### Task 1: Tests (`test-writer`)

**Files:** Modify `desktop/tests/unit/main/audiocapHost.test.ts`, in the describe block "audiocap host reaping a child that has not spawned yet". Add a local `makeEmitterChild` built on Node's `EventEmitter`, with `kill: vi.fn(() => false)`.

- [ ] **Step 1:** Add `it('re-kills a spawn that arrives after any amount of time — the reap arms no timer')`. Call `vi.useFakeTimers()` before `loadHost()`. Fake timers must be installed first: a timer the reap arms while real timers are active is a real timer, and the test could never run it, so the test would pass against a timer-based reap. Start the host and call `killAudiocapHost()`. Assert `vi.getTimerCount()` is 0, the `exit` listener count is unchanged and there is one `spawn` listener. Call `vi.runAllTimers()`, assert the `spawn` listener is still there, emit `spawn`, and assert `child.kill` was called 2 times.
- [ ] **Step 2:** Add `it('a killed child that exits without ever spawning is not killed again and leaves no timer')`. Kill the child, then `child.emit('exit', 1)` so every `exit` listener runs. Assert `child.kill` was called 1 time and `vi.getTimerCount()` is 0.
- [ ] **Step 3:** Add the crash-path case: with a live session, `child.emit('exit', 1)`. Assert no `kill()` call, both inside the emit (from a listener registered after the host's) and after it, 0 `spawn` listeners, no timer, and a start result of `child-crash`. It fails against the current code: this is the TDD red for Task 2.
- [ ] **Step 4:** Add the `error` case: one `kill()`, one `spawn` listener, and a second `kill()` on `spawn`. Add one late-spawn case for each other reap site: handshake timeout, stop quiesce timer (`startAudiocapHost(1, 42)`, then 150 ms), stop catch path (`postMessage` throws), and `drainStoppingChild` (stop, then `killAudiocapHost()` before 150 ms).
- [ ] **Step 5:** Run `cd desktop && npx vitest run tests/unit/main/audiocapHost.test.ts`. Only the crash-path case may fail.

### Task 2: Crash-path code (`code-writer`)

**Files:** Modify `desktop/src/main/audiocapHost.ts`.

- [ ] **Step 1:** Add `childExited: boolean` to `HostSession`, starting at `false`. The fork-time `exit` listener sets it to `true` just before it calls `retire`. In `retire`, run `if (!live.childExited) reapChild(live.child)`. Keep the comments at `retire`, the I7 header and the `exit` and `error` listeners true.
- [ ] **Step 2:** Update the older mid-share interrupt tests that assert a `kill()` after a crash-path `exit`. They now contradict the design.
- [ ] **Step 3:** Run `cd desktop && npx vitest run tests/unit/main/audiocapHost.test.ts && npx tsc --noEmit -p .`. Both must pass.

### Task 3: Probe (`devops`)

**Files:** Add `desktop/scripts/utility-process-probe/` (`main.js`, child scripts, `Dockerfile`).

- [ ] **Step 1:** Build a hand-run, container-only probe that checks the three Electron properties the decision rests on: a fork that fails at launch emits only `exit`, `spawn` never follows `exit`, and the wrapper is collectable after `exit`. It also records `kill()` inside an `exit` listener. It prints no PIDs, refuses to run outside its image, and exits non-zero if a property fails.
- [ ] **Step 2:** Run it in `nproc` and `cwd-missing` modes on Electron 45.2.3 (the lockfile pin) and 45.0.0, and report the values for the ADR entry.

### Task 4: Comment and ADR (`docs-writer`, after Task 3 reports)

**Files:** Modify `reapChild`'s comment in `desktop/src/main/audiocapHost.ts`, and `docs/adr/0043-per-process-screen-share-audio-capture.md`.

- [ ] **Step 1:** Comment: separate what was read from Electron's source from what the probe measured, name the crash-path skip, and point at the probe for each Electron major bump.
- [ ] **Step 2:** ADR: add a dated record-correction entry with decision A, the crash-path change, the evidence (INFERRED from source, MEASURED by the probe, UNMEASURED), and why B and C were rejected. Add a pointer to it after the first addendum's bounded-timeout paragraph, in § "Accepted residual: `reapChild`'s spawn listener on a fork that never spawns", and after "That disagreement is still open…".

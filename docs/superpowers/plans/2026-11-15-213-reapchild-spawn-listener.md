# Issue 213: settle `reapChild`'s spawn listener (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ADR and the code agree that `reapChild`'s `once('spawn')` listener needs no bound, with tests that pin the late-spawn reap.

**Architecture:** Behaviour does not change. The work is two Vitest cases, one rewritten comment paragraph, and a dated ADR-0043 entry with pointers to it.

**Tech Stack:** TypeScript, Vitest (in `desktop/`), Markdown.

**Spec:** `docs/superpowers/specs/2026-11-15-213-reapchild-spawn-listener-design.md`

## Global Constraints

- Do not change `reapChild`'s body or any of its callers. Under D5, nothing in the addon changes.
- New text in this public repository cites no private pull-request or issue numbers.
- The pull request body says `Closes #213`.

## Review Focus

1. Someone later adds a timer that drops the listener. Test 1 must fail when they do.
2. The crash path: `retire` runs inside the `exit` emit and arms an inert listener there. Test 2 covers exit without spawn, and the comment must name the crash path.
3. The test fake keeps one handler per event, so a test that registers a second `exit` listener would overwrite the stop path's handler. Use the fake as it is.

### Task 1: Tests (`test-writer`)

**Files:** Modify `desktop/tests/unit/main/audiocapHost.test.ts`, in the describe block "audiocap host reaping a child that has not spawned yet".

- [ ] **Step 1:** Add `it('re-kills a spawn that arrives long after the kill — no bound drops the listener')`. Create the child with `makeChild({ killReturns: false })`, start it, and call `killAudiocapHost()`. Then call `vi.useFakeTimers()` and `vi.advanceTimersByTime(600_000)`. Assert `typeof child.onceHandlers.spawn` is `'function'`. Call `child.onceHandlers.spawn()`, then assert `child.kill` was called 2 times.
- [ ] **Step 2:** Add `it('a child that exits without ever spawning is not killed again and leaves no timer')`. Create the child with `killReturns: false`, start it, and kill it. Emit the child's exit through the fake's existing exit handler, with no spawn. Assert `child.kill` was called 1 time and `vi.getTimerCount()` is 0.
- [ ] **Step 3:** Run `cd desktop && npx vitest run tests/unit/main/audiocapHost.test.ts`. It must pass, because both tests pin current behaviour. Then make `reapChild` timer-based as a temporary change, check that test 1 fails, and revert.
- [ ] **Step 4:** Commit `test: pin reapChild's late-spawn reap and its unbounded listener`.

### Task 2: Comment and ADR (`docs-writer`, after the empirical run reports)

**Files:** Modify `desktop/src/main/audiocapHost.ts`, but only the closing paragraph of `reapChild`'s comment (about lines 731 to 733) and the Electron version note where it applies. Modify `docs/adr/0043-per-process-screen-share-audio-capture.md` at about lines 915 to 936 and 2056 to 2068, and add a new dated entry.

- [ ] **Step 1:** Comment: state the Electron 45 facts from the spec's Evidence section in two or three sentences, and name the inert listener on the crash path.
- [ ] **Step 2:** ADR: add a dated record-correction entry that settles the residual. It gives decision A, the evidence, why B and C were rejected, and the empirical run's result. Add a one-line pointer to the entry after "#3198 owes a bounded timeout…" and after "That disagreement is still open…".
- [ ] **Step 3:** Run `cd desktop && npx vitest run tests/unit/main/audiocapHost.test.ts && npx tsc --noEmit -p .`. Both must pass.
- [ ] **Step 4:** Commit `docs: settle the reapChild spawn-listener residual in ADR-0043`.

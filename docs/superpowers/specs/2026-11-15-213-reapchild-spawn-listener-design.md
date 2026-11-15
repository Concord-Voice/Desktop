# Issue 213: does `reapChild`'s spawn listener need a bound? (short design)

**Status:** Approved for build under the `/dev-lifecycle --epic` automated contract (2026-11-15; the project lead directed the epic to run to completion). Size: a small change.

## Intent

ADR-0043 says a bounded timeout is owed on `reapChild`'s `once('spawn')` listener. The code comment says none is needed. This change records one decision, so that the ADR and the code agree. The leak `reapChild` exists to prevent must stay fixed whatever the delay: a child killed before spawn that comes up unreaped.

## Evidence

The facts below come from Electron's own source at v45.2.3, diffed against the installed v45.0.0:

- A launch failure ends in `HandleTermination(1)`, whether it happens before or after `ServiceProcessHost::Launch`. That call emits only `exit`. `error` is emitted only when a running child has a V8 fatal error.
- `OnServiceProcessLaunch` returns at once when `terminated_` is set, and `HandleTermination` sets it before emitting `exit`. So `spawn` never follows `exit`.
- `kill()` returns `false` whenever the JS handle is null. That is true before launch and after `exit`.
- `HandleTermination` clears the wrapper's self keep-alive. The process registry holds weak references, and the bound callbacks use weak cells. After `exit`, nothing roots the wrapper, so a `once('spawn')` listener on it is collected with it.
- In normal operation, the same synchronous function sets the pid and emits `spawn`. So a `kill()` that returned `false` because no pid existed yet is always followed by `spawn` or by `exit`.

An empirical headless run in a Linux container records the launch-failure event sequence and whether the wrapper is collected. It opens no window on the developer machine. Its result goes into the ADR entry. If it contradicts the source reading, this design returns to option C.

## Approaches

| | What | Trade-off | Verdict |
|---|---|---|---|
| A | Keep the bare `once('spawn')`. Add a test that a late spawn is still reaped. Amend the ADR and the comment with the evidence | Adds no new failure mode. It depends on Electron's behaviour, which the evidence above settles for v45 | **Chosen** |
| B | Add a timer that drops the listener | If `spawn` arrives after the timer fires, a live capture process is stranded and nothing can kill it. That breaks D6 (fail closed) | Ruled out by the issue |
| C | Remove the spawn listener with `once('exit')` | On the crash path, `retire` calls `reapChild` inside the `exit` emit. There `kill()` returns `false`, and a `once('exit')` registered during the emit never fires, so C leaves two dead listeners where A leaves one. It also needs a test fake that holds several listeners per event | Rejected: it adds code without closing the case it targets |

## Design (A)

- **Code:** behaviour does not change. Rewrite the closing paragraph of `reapChild`'s comment. State the Electron 45 facts instead of "the child is unreachable either way". Also say that the crash path arms an inert listener on a child that has already exited, and that the listener is collected with that child.
- **Tests:** add two cases to the reaping describe block in `desktop/tests/unit/main/audiocapHost.test.ts`.
  1. A `spawn` that arrives long after the kill is still killed (fake timers advanced 10 minutes). This test fails if anyone adds a timer that drops the listener.
  2. A child whose first `kill()` returns `false`, and which then emits `exit` without `spawn`, gets no second `kill()`. `reapChild` leaves no pending timer.
- **ADR-0043:** add a dated record-correction entry that settles the residual. It says no timeout is owed, gives the evidence, and says why B and C were rejected. Add a pointer to it at both passages: the first addendum's "#3198 owes a bounded timeout" paragraph, and the issue-73 addendum's "That disagreement is still open". Text added in this public repository cites no private pull-request or issue numbers.

## Non-goals

Detaching the fork-time `message`, `exit` and `error` listeners on exit is out of scope. They capture the session, and they are collected with the child for the same reason as the spawn listener. Callers, IPC and the addon do not change (D5).

## Left to the builder

The exact test names, and how the existing fake emits `exit`.

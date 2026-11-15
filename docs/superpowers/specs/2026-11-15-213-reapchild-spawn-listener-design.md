# Issue 213: does `reapChild`'s spawn listener need a bound? (short design)

**Status:** Approved for build under the `/dev-lifecycle --epic` automated contract (2026-11-15; the project lead directed the epic to run to completion). Size: a small change.

## Intent

ADR-0043 says a bounded timeout is owed on `reapChild`'s `once('spawn')` listener. The code comment says none is needed. This change records one decision, so that the ADR and the code agree. The leak `reapChild` exists to prevent must stay fixed whatever the delay: a child killed before spawn that comes up unreaped.

The evidence, the measurements and why options B (a timer) and C (`once('exit')`) were rejected are in ADR-0043, § "Record correction: issue 213, the `reapChild` spawn-listener residual is settled (2026-11-15)".

## Design (A)

- **Code:** keep the bare `once('spawn')` with no bound. One behaviour change: the crash path no longer reaps a child that has already exited. The fork-time `exit` listener sets a `childExited` flag on the session, and `retire` skips `reapChild` when it is set. Every other cause still reaps, `error` included. Rewrite `reapChild`'s comment to state the Electron 45 facts, and point it at the kept probe `desktop/scripts/utility-process-probe/` for each Electron major bump.
- **Tests:** in the reaping describe block of `desktop/tests/unit/main/audiocapHost.test.ts`, on an EventEmitter-backed child:
  1. The kill-path reap arms no timer. After `vi.runAllTimers()`, a late `spawn` is still killed.
  2. A killed child that exits without spawning is not killed again and leaves no timer.
  3. The crash path makes no `kill()` call, inside or after the `exit` emit, and arms no spawn listener.
  4. The `error` path still reaps and re-kills on a late `spawn`.
  5. Each other reap site (handshake timeout, stop quiesce, stop catch path, `drainStoppingChild`) re-kills a child that spawns late.
- **ADR-0043:** add a dated record-correction entry that settles the residual. Add a pointer to it at both passages: the first addendum's bounded-timeout paragraph, in § "Accepted residual: `reapChild`'s spawn listener on a fork that never spawns", and the issue-73 addendum's "That disagreement is still open". Text added in this public repository cites no private pull-request or issue numbers.

## Non-goals

Detaching the fork-time `message`, `exit` and `error` listeners on exit is out of scope. They capture the session, and they are collected with the child for the same reason as the spawn listener. Callers, IPC and the addon do not change (D5).

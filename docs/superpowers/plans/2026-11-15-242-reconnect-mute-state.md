# Reconnect keeps self-mute/deafen — Implementation Plan (#242)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No reconnect, rebuild or peer rejoin can resume a muted or deafened user's mic, and the state everyone sees matches what the mic is actually doing.

**Architecture:** Add one shared mic-resume predicate, `canResumeMic`, and route the two unguarded resume sites through it. Then add three small state corrections in `voiceService.ts`.

**Tech Stack:** TypeScript, mediasoup-client 3.26, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-242-reconnect-mute-state-design.md`

## Global Constraints

- All production changes go in `desktop/src/renderer/services/voice/voiceService.ts`. No new dependencies and no protocol change.
- Keep the guard on media-policy latches at every resume site (frontend.md § Media-rate policer).
- Tests go in `desktop/tests/unit/services/voiceService.reconnectMuteState.test.ts`, using the harness from `voiceService.mediaPolicy.test.ts` (the real singleton, a stub socket, and `producerStub`).
- Commits use Conventional Commits with a bare `type:`.

## Review Focus

1. The user is deafened while no producer exists, so the mic is created after the deafen. Solo exit must not resume it. (Task 1)
2. The user is server-muted but not self-muted when solo exit runs. The mic must stay paused. (Task 1)
3. The user is test-suspended during solo exit. The mic must stay paused, and the test restore owns it. (Task 1)
4. Policy says paused and `mic.paused` is already true on resume. `pause-producer` must still be emitted. (Task 2)
5. The roster is rebuilt while the user is muted. The local tile must not flash "unmuted". (Task 2)

---

### Task 1: Shared mic-resume predicate (defect repair, via `/reproduce-then-fix`)

**Files:**
- Modify: `desktop/src/renderer/services/voice/voiceService.ts` (`shouldResumeMicAfterTrackReplacement` ~:2448, `resumeLocalProducer` ~:7660, `exitSoloBandwidthSaving` ~:7708)
- Test: `desktop/tests/unit/services/voiceService.reconnectMuteState.test.ts` (new)

**Interfaces:**
- Produces: `private canResumeMic(producer: mediasoupTypes.Producer): boolean`, which returns `!this.isMediaPolicyLatched(producer.id) && this.shouldRunMicVAD(producer.id) && this.hasLiveMicGraph(producer)`.

- [ ] **Step 1: Write the failing reproduction test.** Name: `deafened before the mic exists, then a resume and a peer rejoin, never resumes the mic`. Setup: `setDeafened(true)` with `isMuted` false, then a paused mic `producerStub('mic-1', true)` and a live `micGraph`. Then call `svc.exitSoloBandwidthSaving()`. Assert that `emitted('resume-producer')` is `[]` and `mic.resume` is not called.
- [ ] **Step 2: Add the blocked/CONTROL table** for `exitSoloBandwidthSaving` and `resumeLocalProducer('mic')`, both with a paused mic and a live graph. Rows:

  | Row | State | `resume-producer` emits |
  |---|---|---|
  | CONTROL | nothing set | 1 |
  | muted | `setMuted(true)` | 0 |
  | deafened | `setDeafened(true)` | 0 |
  | serverMuted | local participant `serverMuted: true` | 0 |
  | serverDeafened | local participant `serverDeafened: true` | 0 |
  | test-suspended | `testSuspendedProducerIds.add('mic-1')` | 0 |
  | latched | `setMediaPolicyPaused('mic', 'mic-1')` | 0 |

- [ ] **Step 3: Run the tests and see them fail.** Run `cd desktop && npx vitest run tests/unit/services/voiceService.reconnectMuteState.test.ts`. The deafened, serverMuted, serverDeafened and test-suspended rows should FAIL for both sites, and so should the reproduction test.
- [ ] **Step 4: Implement `canResumeMic`.** Use it in both sites' mic branches. Leave `shouldResumeMicAfterTrackReplacement` unchanged: it has two callers and already applies the full policy.
- [ ] **Step 5: Run the tests again** with the same command. Expected: PASS, and `voiceService.mediaPolicy.test.ts` is still green.
- [ ] **Step 6: Commit** as `fix: gate every mic resume on the full mute/deafen policy`.

### Task 2: State correction after a resume

**Files:**
- Modify: `voiceService.ts`: `buildParticipantList` ~:3841, `restorePostResumeMuteState` ~:4980, `toggleDeafen` ~:6870
- Test: the same new test file

**Interfaces:**
- Consumes: nothing new. Uses `shouldRunMicVAD`.

- [ ] **Step 1: Write the failing tests.**
  - `restorePostResumeMuteState re-emits pause-producer when muted even if the mic is already paused`: with a paused mic, `setMuted(true)` and `svc.restorePostResumeMuteState(socket)`, expect one `pause-producer` emit with `{ producerId: 'mic-1' }`.
  - `buildParticipantList seeds the local user's own mute and deafen state from the store`: with `setMuted(true)` and `setDeafened(true)`, call `svc.buildParticipantList({ participants: [{userId: LOCAL, username: 'l'}, {userId: PEER, username: 'p'}], existingProducers: [] })`. Expect the LOCAL entry to have `isMuted` true and `isDeafened` true, and the PEER entry to have `isMuted` false.
  - `toggleDeafen with no mic producer still records mute intent`: with no producers, call `svc.toggleDeafen()`, then `await vi.waitFor(...)`. Expect `isMuted` true and `isDeafened` true.
- [ ] **Step 2: Run the tests and see them fail.**
- [ ] **Step 3: Implement the three changes** as spec § Design items 4–6. In `toggleDeafen`, chain onto `this.toggleMute()`. When it settles and the store is still unmuted while deafened, call `store.setMuted(true)` and `this.applyOptimisticMute(store, true)`.
- [ ] **Step 4: Run the full voice suites.** Run `cd desktop && npx vitest run tests/unit/services/voiceService` and expect PASS.
- [ ] **Step 5: Commit** as `fix: re-assert mute state on the media plane and roster after a resume`.

### Task 3: Docs

**Files:**
- Modify: `.claude/rules/domains/frontend.md`, in the Media-rate policer bullet "No `resume-producer` is ever emitted for a latched producer — all FOUR emit sites are guarded".

- [ ] **Step 1: Record the rule.** Mic resumes at solo exit and `resumeLocalProducer` go through `canResumeMic`, which applies the full mute/deafen/server/test policy, not only the latch. Cite #242.
- [ ] **Step 2: Commit** as `docs: record the shared mic-resume policy`.

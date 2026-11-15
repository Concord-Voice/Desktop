# Reconnect keeps self-mute and deafen — design (#242)

A short design for a small change. It comes from the issue's Design Dossier (option B), as
corrected by the Phase 1 architect pass on `origin/main` 23e2e467.

## Intent

A user who muted or deafened themselves must stay silent through every reconnect and rebuild.
In a two-person call today, the mic of a muted or deafened user can resume when the peer
rejoins, while the UI still says muted (Desktop#242). The fix makes the client honour the
user's choice. Why the connections drop is out of scope here and is tracked separately.

## Goals

- **Privacy (must).** No code path resumes the local mic unless current policy allows it.
  Policy allows it only when all of these hold:
  - the media-rate policer has not latched it;
  - the user is not self-muted or self-deafened;
  - the server has not muted or deafened the user;
  - the user is not in a test suspension;
  - a live mic graph exists.
- **State (should).** After a resume, the media plane and the peers see the mic as paused,
  and the local roster shows the local user's own mute and deafen state.

## Non-goals

- The server half: a `paused` field in `existingProducers`, and serialized `pauseProducer`.
  That work belongs in the media-plane repository and is filed separately.
- Fixing the root cause of the 1006 and `transport close` disconnects.
- New user-visible UI.

## Anti-goals

- Keeping the mic paused by adding one more one-off check. Every mic-resume site must use one
  shared predicate, so the next new site cannot forget a condition.

## Facts the design rests on

- In mediasoup-client 3.26, `Producer.pause()` sets `track.enabled = false`, because
  `disableTrackOnPause` defaults to true (Context7 `/versatica/mediasoup-client`). A paused
  producer therefore sends silence, and only `resume()` makes audio audible.
- Two mic `resume()` calls skip mute and deafen:
  - `exitSoloBandwidthSaving` checks `isMuted` only;
  - `resumeLocalProducer` checks only the latch and the mic graph.
- `shouldRunMicVAD(producerId)` already encodes the policy: test suspension, `isMuted`,
  `isDeafened`, `serverMuted`, `serverDeafened`. Two existing paths already use it through
  `shouldResumeMicAfterTrackReplacement`: `adoptMicProducer` and track replacement.

## Approaches

1. **One shared mic-resume predicate (S).** Add `canResumeMic(producer)`, true when the mic is
   not latched, `shouldRunMicVAD` passes, and `hasLiveMicGraph` holds. Route both unguarded
   sites through it. This fixes the leak and nothing else.
2. **Approach 1 plus state correction (M). Chosen.** Approach 1, plus three small fixes so the
   state everyone sees matches reality. The issue's acceptance criteria require them:
   - deafen records mute intent even when `toggleMute` cannot act;
   - `restorePostResumeMuteState` re-emits `pause-producer` whenever policy says paused;
   - `buildParticipantList` seeds the local user's own `isMuted` and `isDeafened` from the store.
3. **The server owns mute state (L).** Rejected for this issue. It needs a protocol change
   across two repositories and a staged rollout, and stopping the leak does not need it.

## Design

All changes are in `desktop/src/renderer/services/voice/voiceService.ts`.

1. **New predicate.** Add `private canResumeMic(producer): boolean`, equal to
   `!isMediaPolicyLatched(producer.id) && shouldRunMicVAD(producer.id) && hasLiveMicGraph(producer)`.
   `shouldResumeMicAfterTrackReplacement` keeps its solo-mode check and delegates the rest to
   this predicate. This shipped in the Phase 8 review round; the first round left it unchanged.

## Phase 8 review decisions

- The end of a mic test (`restoreTestSuspendedProducer`) also goes through `canResumeMic`.
- Unmuting while deafened also undeafens. A server-deafened user's unmute is refused.
- A server-deafen pauses the mic even when the server did not also server-mute.
- After a deafen, `enforceDeafenedMicOff` pauses a live mic, even when the mute failed.
- The rebuilt roster cleared the local `serverMuted`/`serverDeafened` until the join data restored
  them. Fixed in the companion change for #247: `buildParticipantList` seeds them from the join
  data in the same write.
2. **`exitSoloBandwidthSaving`.** For the mic, resume only when `producer.paused` and
   `canResumeMic(producer)` are both true. Other sources are unchanged.
3. **`resumeLocalProducer('mic')`.** Same rule as step 2.
4. **`toggleDeafen`.** When deafening and not muted, call `toggleMute()` as before. Once it
   settles, if the store still says unmuted (no producer, or the mic is latched), set
   `isMuted` and apply the optimistic mute. `toggleDeafen` stays synchronous for its callers.
5. **`restorePostResumeMuteState`.** When the mic exists and `!shouldRunMicVAD(mic.id)`, pause
   it if it is not already paused, and emit `pause-producer` on the given socket either way.
   The server treats a repeated pause as harmless.
6. **`buildParticipantList`.** For the local user's entry only, take `isMuted` and
   `isDeafened` from the store. Peers' entries stay as they are: deafen from the payload, mute
   from `producer-paused`.

## Tests

- **Reproduction:** the user deafens while no mic producer exists, a resume runs, then the
  peer sends `user-left` followed by `user-joined`. Expect no `resume-producer` emit, and the
  mic stays paused.
- **Solo exit:** a CONTROL case where the mic resumes, and blocked cases for muted, deafened,
  server-muted, server-deafened, test-suspended and latched.
- **`resumeLocalProducer('mic')`:** the same CONTROL and blocked cases.
- **Resume while muted:** `pause-producer` is emitted on the socket, and the local user's
  participant entry shows `isMuted` true.

## Left to the builder

- Where tests live: use a new `voiceService.reconnectMuteState.test.ts` built on the
  `voiceService.mediaPolicy.test.ts` harness.

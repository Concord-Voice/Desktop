---
description: End-to-end encryption and cryptographic code constraints
paths:
  - "desktop/src/renderer/services/e2ee/**"
  - "desktop/src/renderer/services/e2ee/crypto*"
  # The services/e2ee/crypto* glob covers a future E2EE crypto module, while the attachment
  # crypto modules -- which hold the AES-GCM envelope, the AAD construction, and
  # the legacy dispatch -- were governed by no crypto rule at all. They matched
  # only frontend.md and observability.md via broad desktop/src globs.
  - "desktop/src/renderer/utils/crypto/attachmentCrypto.ts"
  - "desktop/src/renderer/utils/crypto/attachmentChunkedCrypto.ts"
  - "desktop/src/renderer/services/messaging/attachmentUploadSession.ts"
  # The services/e2ee/crypto* glob above matches zero files and never has: the crypto
  # core is utils/crypto/crypto.ts (AES-256-GCM, RSA-OAEP, Argon2id, and the legacy
  # PBKDF2-600k path), and utils/crypto/persistE2EESessionKeys.ts was uncovered for the
  # same reason. The dead glob is kept -- it still catches a future
  # services/e2ee/cryptoX.ts -- and the real modules are named explicitly here.
  - "desktop/src/renderer/utils/crypto/crypto.ts"
  - "desktop/src/renderer/utils/crypto/persistE2EESessionKeys.ts"
  # Continuation-pair validation and Shamir reconstruction handle credential and
  # recovery key material; exact scopes keep this governance path-specific.
  - "desktop/src/renderer/utils/crypto/continuationPair.ts"
  - "desktop/src/renderer/utils/crypto/shamir.ts"
  - "desktop/src/renderer/App.tsx"
  - "desktop/src/renderer/hooks/voice/useConnectionRecovery.ts"
  - "desktop/src/renderer/hooks/messaging/useWebSocket.ts"
  # The send paths choose the key_version every ciphertext is stamped with; they
  # matched no crypto rule while stamping a second, unpaired cache read.
  - "desktop/src/renderer/hooks/messaging/useMessaging.ts"
  - "desktop/src/renderer/hooks/messaging/useFileUpload.ts"
  - "desktop/src/renderer/services/messaging/dmMessageSender.ts"
  - "desktop/src/renderer/hooks/ui/useSSOFlow.ts"
  - "desktop/src/renderer/services/system/*Sync.ts"
  - "desktop/src/renderer/services/system/postLoginHydration*"
  - "desktop/src/renderer/services/system/resetService.ts"
  - "desktop/src/renderer/services/system/notificationPrefsService.ts"
  - "desktop/src/renderer/stores/auth/userStore.ts"
  - "desktop/src/renderer/stores/auth/subscriptionStore.ts"
  - "desktop/src/renderer/stores/auth/e2eeStore.ts"
  - "services/control-plane/internal/auth/handlers.go"
  - "services/control-plane/internal/channels/handlers.go"
  - "services/control-plane/internal/dm/handlers.go"
  - "services/control-plane/internal/mfa/handlers.go"
  - "services/control-plane/internal/users/handlers.go"
  - "services/control-plane/internal/users/keymaterial.go"
  - "services/control-plane/internal/users/presence_*.go"
  - "services/control-plane/internal/presence/*.go"
  - "services/control-plane/internal/websocket/customtext.go"
---

# E2EE & Crypto Rules

## Cryptographic Standards

- **AES-256-GCM** for message encryption (authenticated encryption)
- **RSA-OAEP 4096-bit** for key wrapping
- **ECDH P-384+** for key agreement
- **Argon2id** (t=3, m=64MB, p=4) for password hashing
- **PBKDF2-SHA256 600k** — legacy unwrap only, and still reachable. It is the
  *parameter default* of `unwrapLoginKeys`
  (`desktop/src/renderer/utils/crypto/crypto.ts:418`, constants at `:8-9`) and the
  `|| 'pbkdf2'` fallback at `desktop/src/renderer/stores/auth/userStore.ts:1027`
  and `desktop/src/renderer/components/Auth/Login.tsx:1074`, so a server
  response that omits `key_derivation_alg` derives with PBKDF2. New registrations
  are Argon2id (`crypto.ts:391-392`, stamped `keyDerivationAlg: 'argon2id'` at
  `:402`). Do NOT introduce a new PBKDF2 call site, and do NOT "fix" the fallback
  without a migration plan for pre-Argon2id accounts.
- **CSPRNG only** — use WebCrypto `getRandomValues()` or Go `crypto/rand`

## Prohibited

- No MD5, SHA-1 (for integrity), DES, RC4, ECB mode
- No custom cryptographic algorithms
- No third-party crypto libraries without explicit approval
- No key sizes below project minimums (AES-256, RSA-4096, P-384)
- No `any` type in crypto code paths
- No non-null assertions (`!`) in crypto code

## Key Material

- Private keys, channel keys, and session keys NEVER logged
- Never sent to server unencrypted
- Persisted to disk only via Electron `safeStorage` (OS keychain), only for `rememberMe=true` sessions, and only when `secureStorage.encryptForDisk` finds an OS-protected key. On Linux, `basic_text` or a keyring that failed to return a key leaves only Chromium's hardcoded-key fallback (tag `v10`), which counts as no secure storage: Login and Register refuse to start while it is the only key (#197), and a write from a live session leaves its keys in main-process memory only, as for `rememberMe=false`. See [`electron.md`](electron.md) § Token Storage.
- **Session-only (`rememberMe=false`) E2EE key material is held in main-process memory only — never disk/`safeStorage`/localStorage (#1870).** `tokenManager.storeE2EEKeysIfOwner` always stashes the key material to an in-memory `inMemoryE2EEKeys` (mirroring `inMemoryRefreshToken`) so it survives a renderer _soft reload_ (the main process persists), while the disk write stays gated on `rememberMe`. `restoreE2EEKeys` is memory-first. The in-memory copy MUST be wiped in `clearTokens()` (and `_resetForTesting()`) so key custody does not outlive the session (CWE-212); `performLogout()` flows through `clearTokens()`.
- Key-epoch enforcement required for DM messages (migration 000041: `dm_key_revocations`)
- **Recovery-key storage is step-up-gated on overwrite and delete only.** First-time creation (`PUT /mfa/recovery-key`) is token-only, through `INSERT … ON CONFLICT (user_id) DO NOTHING` — this is TOTP enrollment's automatic upload, and there is nothing yet to overwrite. When that insert affects 0 rows, a key already exists: replacing it (the same route) or deleting it (`DELETE /mfa/recovery-key`) requires in-transaction `password` (plus `mfa_code` for an account with an inline-verifiable factor — TOTP or WebAuthn), verified after the lock, matching the recovery reset's own gating. Lock order is `users` (`FOR SHARE`) → `user_recovery_keys`. A credential-less caller who gets 403 `password_required` from the PUT route means the existing key was left in place, unchanged — not that the request failed outright. **A credential-less retry of the first-ever store is idempotent (F2).** When the insert affects 0 rows and no credentials were sent, the handler reads the stored row `FOR SHARE` and compares it column-by-column, in constant time, against the submitted material (`recoveryKeyMaterial.sameAs`, `subtle.ConstantTimeCompare` per column); a byte-identical match answers 200 with nothing written and the attempt budget untouched, so a client that lost its first-store response can retry with the same bytes without hitting the step-up path or being told a key it never saw was "kept". Any mismatch, or a row that has since vanished, falls through to the ordinary step-up-gated overwrite.

## Key epoch is client-attested on every write path (#2832)

The epoch a ciphertext claims is supplied by the **sender**, never chosen by the
server. A write path that defaults, backfills, or infers `key_version` makes the
server assert which CSK epoch a ciphertext belongs to — and the revocation check
then runs against a value the sender never claimed.

- Every ciphertext-write request MUST carry `key_version >= 1`. Reject a missing,
  zero, negative, or malformed value; **never substitute a default.**
- Validate at the boundary (`binding:"required,min=1"` on REST bodies,
  `validateEnvelope` on the WebSocket path). Where a downstream helper repeats the
  check, it must **reject**, not default — an unreachable branch that rejects is a
  backstop, whereas an unreachable branch that substitutes is a latent breach.
- When two places examine the same epoch field, they MUST accept the same type set.
  Read the validated value once rather than re-asserting it; a validator and an
  extractor that disagree let a valid value fall through to a server-chosen one.
- A DB `CHECK` on `key_version IS NOT NULL` validates **presence, not authenticity**.
  It cannot detect a value the server supplied itself, so it is not a substitute for
  boundary validation.
- A claimed label must name an epoch that exists. Every message writer rejects a
  `key_version` above the scope's newest **issued** epoch — the highest wrapped
  `key_version`, the highest `successor_epoch` a committed revocation names, or 1 —
  computed once by `keyrotation.IssuedChannelEpoch` / `IssuedDMEpoch`. REST answers
  400 `epoch_unissued` with `current_epoch`; the WebSocket path sends its
  epoch-verification error. A label no key backs sends every reader after a key that
  does not exist (#2822).
- A revocation check that runs before the write transaction is a preflight. Each
  writer repeats it inside the transaction, after locking the scope's parent row
  (`channels` `FOR SHARE`, `dm_conversations` `FOR NO KEY UPDATE`): a rotation
  holds that row `FOR UPDATE` until it commits its revocation, so only the
  in-transaction read is ordered after it.

Founding incident: `POST /api/v1/messages` accepted a body with no `key_version` and
labelled the row epoch 1, while the WebSocket path rejected the identical omission
with close frame 4400. The defaulting branch was residue from before ADR-0003, when
an unencrypted channel legitimately omitted the field; #1042 removed the
`is_encrypted` selector without removing the branches that served it.

## Reads decrypt with the labelled epoch — 1 is not "current"

The read side of the rule above. A ciphertext's `key_version` names the key that
opens it, and **every** label selects that epoch's key, including 1. The only
row that falls back to the current key is an unlabelled one (0 or absent).

- Gate on `if (keyVersion)`, never `keyVersion > 1`. The `> 1` gate treated
  epoch 1 as an alias for "whatever key is current", which holds only until the
  first rotation: once a group member leaves, the current key is epoch 2 and
  every remaining member's pre-leave history reads "Unable to decrypt".
- `decryptForChannelWithVersion(…, 1)` fetches the epoch-1 wrap (a main-cache
  hit while the channel is still at epoch 1). Only if that key is unavailable
  or cannot open the row does it try the current key, because a pre-#2832 write
  could be labelled 1 while encrypted under a later epoch. A key-generation
  fence is never read as a miss.
- When both keys fail, report the error that says whether waiting can help. A
  pending current key waits. A current key that is present but cannot open the
  row leaves only epoch 1, and a rewrap only ever delivers the newest epoch, so
  the row fails rather than sitting "pending" forever. Otherwise report the
  epoch-1 error. An epoch-1 `NOT_MEMBER` is final before the current key is
  tried: a key still in the cache must not open a row the server has just
  refused.
- The versioned fetch backs off a refused epoch exactly as the current-key path
  does (`keyMissBackoff`, keyed `<channel>:v<version>`, cleared by
  `invalidateChannelKey`). Without it, every re-decrypt of a row labelled with an
  epoch the caller never held re-fetched, and one 429 set the shared
  `rateLimitedUntil` and failed every other channel's key fetches. Labels are
  sender-chosen, so expired entries are swept whenever a new one is recorded.
- Server side, a `?version` miss for any epoch other than the newest issued
  one answers `pending: false` and does not enroll or page holders. The pending
  queue is served only at the issued epoch, so no other can ever arrive. The
  issued epoch stays pending, even before its wraps are distributed.
- A batch path that pre-fetches keys and decrypts with `decryptWithKey` must
  hand a failed epoch-1 row to `decryptForChannelWithVersion`, so that fallback
  still applies, and must assert its operation guard first so a fence is not
  retried as a miss.
- Any surface that shows ciphertext needs the epoch next to it. The DM
  conversation-list preview did not carry one until the server added
  `last_message.key_version`, so it could only guess the current key. A notify
  from an older server omits the field; for unchanged ciphertext the store keeps
  the label it already holds.

Founding incident: the #2822 two-account walkthrough. After test3 left a group,
test1 and test2 reloaded and saw every pre-leave message fail, although
`dm_channel_keys` still held their epoch-1 wraps and the server served them.

## Key-recovery consistency invariant (#1293)

Any server path that writes new `user_keys` key material (a fresh wrapped private
key / `key_version` bump) MUST, in the same transaction, rotate the matching
`public_keys` row AND clear the user's stale `channel_keys` / `dm_channel_keys`.
There is no valid state where a new wrapped private key is published while the
old public key remains — that strands the user's own history (silent permanent
undecryptability).

- The authenticated reset path (`ReplaceMyKeys`, `PUT /api/v1/users/me/keys`)
  enforces this via the single helper `replaceKeyMaterialTx`
  (`services/control-plane/internal/users/keymaterial.go`). It requires a
  `public_key` and `acknowledge_data_loss: true`, and asserts the `public_keys`
  UPDATE affected exactly one row (the table has no `UNIQUE(user_id)`).
- The recovery-token path (`RecoveryResetAccount`, `auth/handlers.go`) already
  satisfies the invariant inline; an integration test locks parity. Unifying
  both onto `replaceKeyMaterialTx` is a tracked follow-up (touches `/auth/`).
- Never reintroduce a key-replacement path that updates `user_keys` alone.
  Founding incident: #1293.

### Distribution side must not re-create purged recipient rows (#2420)

The #1293 invariant is symmetric: a **key-distribution** transaction must not
re-create a wrapped-key row that a concurrent reset purged. #2201/#2397 fenced
the *distributor's* credential epoch (`credepoch.GuardTx`); #2420 fences the
*recipient's* public-key freshness. Every path that wraps a CSK to a recipient
guards each insert with `recipientKeyFresh` — a `SELECT key_version FROM
public_keys WHERE user_id=$1 ORDER BY key_version DESC LIMIT 1 FOR SHARE`
compared against the client-supplied `wrapped_key_versions[user]`
(`internal/channels/handlers.go`): the distribution paths
`distributeChannelKeysToMembers` / `distributeDMKeys` (via `distributeOneChannelKey`),
**and** the channel-creation initial-member wrap `storeWrappedKeys` (plus its
linked-text `storeWrappedKeysNonFatal` copy) via the shared
`wrappedKeyRecipientStale` helper — so `CreateChannelRequest` also carries
`wrapped_key_versions`. Leaving the create-time wrap unguarded would keep the
same race open at channel creation. The `FOR SHARE` lock is
**load-bearing**: it conflicts with the reset's `FOR NO KEY UPDATE` on the same
`public_keys` row (`key_version` is not a key column), so the compare-then-insert
can no longer straddle the reset — a bare snapshot `SELECT` predicate does NOT
serialize under READ COMMITTED and leaves the race open. It is a *shared* lock
(concurrent distributions to the same recipient do not block each other) and
stays off the `users` row, so it neither perturbs the password/key `users →
user_preferences → …` lock hierarchy nor adds a deadlock edge (distribution
locks `public_keys → channel_keys`, the same relative order the reset uses).

A recipient whose version no longer matches is **skipped** (never inserted) and
an idempotent self-heal row is enqueued in the same tx (`pending_key_requests` /
`dm_pending_key_requests`, `ON CONFLICT DO NOTHING`), so a servicer re-wraps to
the new public key. The channel handler returns this as a distinct
`skipped_stale` count (present on **both** the `200` and the degraded `503`
bodies) that does NOT itself raise the CV-CAN-005 transient-retry `503` (that 503
is for view-check DB errors, which retrying can fix; a stale skip is
deterministic and self-heals). The DM path folds a stale skip into its
not-inserted outcome and surfaces no separate count — it has no 503 branch to
protect, so the fold is intentional. A recipient with **no** supplied version fails **open** to the
legacy insert (server-first rollout; `GetPublicKey` already returns `key_version`).
The desktop client's self-heal distribution path
(`e2eeService.processPendingKeyRequests`) captures that `key_version` from the
per-recipient public-key response it already fetches and echoes it as
`wrapped_key_versions`. Rotation uses the same version-bearing member-key map
for every batch. The guard is therefore active for both pending-key servicing
and rotation; legacy callers without a recipient version remain availability-only
fail-open. Founding issue:
#2420.

### Epoch resolution fails closed on a read error (#1218)

`channels.resolveTargetKeyVersionDM` is the only place a DM distribution epoch is
derived from server state, and a failed read there MUST return an error, never a
version. It previously discarded the `Scan` error and clamped to 1 — the one
fallback its own doc comment forbids. On an established conversation that stamps
the recovering recipient's wrapped key at a version no historical message
references (the history-decryption break #1023/PR #1080 exist to prevent) and
answers 200, so neither the distributor nor the recipient learns anything failed.
A read error is indistinguishable from "brand-new conversation" at that point, so
refusing is the only safe reading. The adjacent non-positive branch refuses for
the same reason rather than substituting 1: `COALESCE(MAX(...), 1)` cannot yield
`< 1` over values this service wrote, so reaching it means the row or the driver
disagrees with that reasoning — and an unreachable branch that rejects is a
backstop where an unreachable branch that substitutes is a latent breach.

The channel path is structurally immune and needs no equivalent: #2503 folded its
version resolution into the INSERT statement, where a read error surfaces as a
statement error. That asymmetry is why the DM path is the only one carrying an
explicit guard — do not "harmonize" them by removing it.

**Scope limit — this is epoch INTEGRITY, not epoch AUTHORITY.** An explicit
positive `key_version` supplied by the client is still accepted as-is. That
remaining authority gap is tracked at
#2597; #1218
removed one of that issue's two routes but did not change the version rule on
the survivor.

Every parseable wrapped-key recipient on the surviving DM route is checked
against `dm_participants` while the participant-set advisory lock is held.
Absent or removed recipients are skipped before freshness, self-heal enqueue,
or insertion; valid recipients in the same bounded request continue.

DM key distribution is additionally bounded per conversation
(`ratelimit:dm_key_distribute:<convID>`, 40/60s). That limiter must stay AFTER
the membership gate: in front of it a non-participant mints one Redis key per
attacker-chosen UUID, which is worse than the write pressure it bounds. It must
also stay BEFORE the body parse, so a refused request never pays for a read it
was never going to use, and it carries a 250 ms admission bound: `IsRateLimited`
fails open on a Redis error, so without one a stalled Redis costs the ceiling AND
holds the request for the full server timeout. It sized
to legitimate peer-fulfillment fan-out — `appendDMPendingRequests` shows every
holder every non-self pending row, so an N-participant conversation emits up to
(N/2)² POSTs per sweep — and bounds the multi-account aggregate only; the route's
own 10/min per-user limit is what bounds a single actor.

### DM rotation is one atomic successor claim (2026-09-17 prod lockout)

A DM has no server, so the two mechanisms a server channel's rotation rests on
did not exist for it, and "Rotate Encryption Key" on a DM bricked the
conversation for every participant: the route recorded the revocation of epoch
1 and emitted a `key_rotation` event that **no client handles**, while the
rotation coordinator (`performKeyRotation` in `useWebSocket.ts`) resolved
members through a server the conversation does not have and returned before
posting anything. No epoch-2 wrap was ever written for anyone, and every fetch
of the held epoch answered `REVOKED_EPOCH`. The repair was deleting the
dangling `dm_key_revocations` row by hand.

**Server contract.** `POST /dm/conversations/{id}/rotate-key` now REQUIRES the
successor batch — `wrapped_keys` for EVERY participant plus `key_version` and
`wrapped_key_versions` (`key_fingerprint` is accepted and, as on the unified
route, ignored for DM contexts) — and commits the wraps and the revocation in
ONE transaction (`rotateDMKeyTx`, `internal/channels/dm_rotation.go`). A
bodyless request is a 400 and writes nothing. On a group conversation the
route admits the creator or an admin-role participant only (403 otherwise) —
the renderer offered the action to the creator alone while the server took it
from any member (CWE-602). That creator/admin gate is the ROTATE route's
alone; the unified `/e2ee/keys` route is gated on HOLDING the current epoch,
not on role, so a current-epoch holder can establish a successor there directly
without a `key_revocation` cue — the documented self-heal path
(`performDMKeyRotation`), which the completeness fence forces to cover every
participant, so it is a benign re-key everyone receives, never a lockout
(accepted, security review PR #3343). Its per-conversation budget (10 per 24 h) is READ
before the transaction and SPENT only by a committed rotation, because every
participant shares it and the route now refuses several request shapes: if
refusals spent it, one member (or one old client still posting bodyless)
could exhaust it and block an incident-response rotation for a day.

**Every DM batch is fenced by its epoch relative to `MAX(key_version)`**, on
both routes, under the conversation row lock (`distributeDMKeysTx`,
`internal/channels/handlers.go`). ABOVE it is a successor claim
(`admitDMSuccessorClaimTx`): the claimed epoch must be exactly `MAX+1` (409
with `current_version`, so the claimant can claim the real successor instead
of guessing), and — on a rotation, i.e. when a previous epoch exists — the
claimant must HOLD that epoch (403) and the batch must cover every
`dm_participants` row (400 with `missing`). A batch that names every
participant but whose `wrapped_key_versions` no longer match a recipient's
identity key (#2420) is REFUSED as a whole (409 with `stale_recipients`), not
committed with that recipient skipped: skipped, they would be stranded at the
revoked epoch with no way to claim out. AT the current epoch the batch is a
rewrap for participants still missing a row, and only a HOLDER of that epoch
may post it (403): otherwise a participant stranded without the key could
write an invented one under the live version — for themselves, and for anyone
else still missing a row — undetectable until decrypt fails, and the planted
row would then satisfy the holder check for a successor claim (red-team PoC 1
on PR #3343). BELOW it is refused (409 with `current_version`). The initial
epoch of a fresh conversation keeps the legacy partial-batch contract (a peer
with no public key yet enrolls as pending on their first fetch, #1023): a batch
that wraps for the PEER and omits the distributor's own row is the normal
bootstrap and is left untouched. But a SELF-SERVING initial claim — the actor
wrapping only itself while a keyed peer is omitted — is refused (400 `missing`,
`admitInitialDMEpochCompleteTx`). Once epoch 1 exists the holder fence makes
every omitted keyed participant a permanent non-holder, so an unfenced self-only
claim bricks a fresh conversation for everyone else (red-team B1 on PR #3343:
the completeness fence this PR added to the ROTATION path is exactly what armed
the lockout on the INITIAL path, converting a partial claim from recoverable
into permanent). Residual, inherent and not closable here: a founder can still
strand a peer by wrapping garbage bytes the server cannot verify — the same
limit that lets any holder rotate garbage — so this closes the trivial self-only
primitive, not that tail.

**The ledger row is written by the successor claim, never ahead of it.** A
committed successor claim inserts `dm_key_revocations (previous → new)` in the
same transaction as the wraps (`reason` `manual_rotation` from the rotate
route, `successor_claim` from the unified route). Group-DM member add/remove
therefore write NO ledger row any more: they emit `key_revocation` — the event
clients act on, `reason` `member_added` / `member_removed` / `member_left` — as
a CUE, and the coordinator's claim records the revocation together with the
successor. Until that claim lands the old epoch stays readable and sendable,
which is strictly better than the previous state (the epoch revoked, nobody
able to read, the successor best-effort). The `key_rotation` event and the old
`dm.RotateKey` handler are gone. Two reads changed with it: a **versioned**
fetch of a wrap the caller holds is served even when that epoch is revoked
(history stays readable — only a current-key fetch answers `REVOKED_EPOCH`),
and `appendDMPendingRequests` serves a pending row to CURRENT-epoch holders
only, so a stale holder cannot fulfil it with a revoked key. The
`REVOKED_EPOCH` refusal carries `successor_epoch`, the ledger's replacement
for the epoch the caller holds — disclosing nothing the caller and every
participant's `key_revocation` push did not already have.

**Client contract.** The context-menu action calls `e2eeService.rotateDMKey`,
which fetches every participant's public key, wraps a fresh key for all of
them, and posts the batch; any participant it cannot wrap for — or whose
`/public-key` response carries no version, because the shared helper
is deliberately version-optional for the initial-distribution path (previous
epoch 0) but a rotation must name every `wrapped_key_versions` entry to arm the
server's #2420 recipient-freshness guard — is a `DMRotationError` shown
verbatim, and the route is never posted bare. The
coordinator gained a DM branch (`performDMKeyRotation`) that wraps from
`fetchParticipantPublicKeys` (`services/e2ee/participantPublicKeys.ts`, shared
with the DM store and `rotateDMKey`) and retries a stale claim exactly once at
`current_version + 1` — or stops when the named epoch is already at or past
the cue's, since the goal is met. A current-key fetch that answers
`REVOKED_EPOCH` cues the same coordinator at the refusal's `successor_epoch`,
falling back to `getHighestSeenKeyVersion + 1` and NOT cueing when neither is
known — that is how a conversation whose rotation never established its
successor heals: the first current-epoch holder to open it claims the next
epoch for everyone. A guessed claim at or below the current epoch would be a
holder's no-op rewrap the server answers 200, which clears the backoff and
repeats every window; the successor number is what makes the cue converge in
one round trip. The `e2ee-key-rotation` event is the ONLY way a DM successor
gets established; never add a second path that posts to the rotate route
without the batch.

**Two adjacent gaps closed in the same change.** (1) A key the server refused
(`NO_KEY_YET`, `REVOKED_EPOCH`) is not re-fetched for 30 s
(`MISSING_KEY_BACKOFF_MS`, cleared by `invalidateChannelKey`, which every
key-arrival path calls) — the sidebar preview decrypt re-runs on every store
change and re-fetched the same 404 a dozen times a minute. (2) A holder's
pending rewrap queue had no trigger for a DM: `key_needed` was pushed for
server channels only and nothing ran the queue at login. The first DM pending
enrollment now pages every other participant with `key_needed` (no
`server_id`; the schema field is optional), the queue runs once E2EE is ready
AND the socket is connected (login publishes the token before the keys
unwrap, so neither transition alone can see the other), and the sustained-
outage reconnect path runs it alongside `validate_epochs`.

## Password-derived preference ciphertext lifecycle (#1234/#2200)

FOUR domains are encrypted with the password-derived preferences key: Custom
Status recipient exceptions (#1234), UI preferences, saved GIFs, and friend
organization (#2200). Any path that changes or destroys that key MUST keep every
encrypted document (and the exceptions' enforcement rows) in a coherent,
fail-closed state:

- An ordinary password change MUST rotate ALL FOUR domains in the same
  transaction as the password/key rotation and refresh-token revocation. The
  client fetches each domain's AUTHORITATIVE server row (never inferring
  absence from an unhydrated/empty local store), decrypts with the held
  old-password key, re-encrypts with the new preferences key, and submits per
  domain `{encrypted_data, expected_version}` — absence asserts at
  `expected_version: 0` without creating a row; a present-but-undecryptable
  row is verified-and-preserved (version CAS, ciphertext untouched), never
  overwritten and never a reason to block the change. Any domain conflict
  rolls the whole transaction back; never restore a post-commit best-effort
  save. Password-change rotations emit NO `*_updated` broadcasts — a session
  still holding the old preferences key (including the initiating renderer
  mid-POST) would fetch-and-apply and could push old-key ciphertext back over
  the rotated rows; the forced disconnect + re-login rehydration converges
  cross-device state instead. A transport failure on the password POST
  reconciles against persisted key material (the per-attempt KDF salt) before
  reporting success or retryability, and both the version-skew and
  ambiguous-commit outcomes re-push the fetched plaintexts under the NEW key
  with repair failures surfaced, never swallowed.
- A fulfilled **2xx is commit evidence** even when its body is unreadable
  (#2422). `classifyPasswordChangeResponse` classifies `response.ok` BEFORE
  parsing and guards the 2xx body; a truncated JSON, an invalid
  `presence_override_version`, or a malformed `sync_domain_versions` returns a
  distinct **committed-unreadable** outcome instead of throwing. A throw here
  would be reported as ordinary failure and the `changePassword` `finally` would
  restart the old-key sync watchers over an already-rotated server (CWE-212 /
  data-loss). Committed-unreadable fails **closed to re-auth** via the shared
  `failClosedToReauth` helper (also used by the E2EE-reinit-teardown path):
  `nuclearReset` clears old renderer key custody and, by clearing the access
  token, flips `isCurrent()` false so the watchers stay stopped; the
  reset-surviving login notice is staged. Re-login is the recovery because the
  #2397 continuation pair lives only in the unreadable body, so the old session
  cannot self-repair. A lifecycle cancelled mid-parse stays a cancellation (the
  catch re-asserts `isCurrent()`); a malformed **non-2xx** (401/409/5xx) is
  never promoted to committed. Do not route this case through authenticated salt
  reconciliation.
- **A password change that COMMITS leaves the persisted keychain blob stale —
  re-persist it under the new `CredentialOwner` (#2415, spec §2.4).** The change
  derives a new wrapping key, wrapped private key and preferences key
  (`reinitE2EEOrFailClosed`, `desktop/src/renderer/stores/auth/userStore.ts`),
  so `secure-e2ee.dat` describes the pre-change keyset the instant the
  transaction commits. Before #2415 that was masked by the forced logout; now
  that the continuation pair (see
  [the Electron rule](electron.md) § Token Storage) keeps the
  session alive, the re-persist is MANDATORY — `persistAdoptedSessionKeys`
  (`userStore.ts:386-389`) routes `e2eeService.getSessionKeys()` through
  `persistE2EESessionKeys` under the owner minted by adoption's
  `storeRefreshToken`, and MUST run AFTER that publish because
  `publishRefreshToken` wipes E2EE custody as it mints the owner. Omit it and
  `restoreE2EEKeys` restores a self-consistent but **stale** keyset on next
  launch, and all four password-derived domains above fail to decrypt against
  the rotated server rows. The crash window between the two is accepted: a
  persist failure (or a crash) costs restart-survival only — warn, never clear
  the live in-session keys (#1278/#1288) — and the server durably holds the new
  key material, so the recovery is a password prompt. If the continuation pair
  is ABSENT the change still committed: fail closed to re-auth, never retry, and
  never persist under the old owner.
- The server locks rows in migration-age order — `users` →
  `user_preferences` (000016) → `saved_gifs` (000055) → `friend_organization`
  (000075) → `presence_override_preferences` (000084). Any future writer
  touching two or more of these tables in one transaction MUST follow the
  same order (`rotatePasswordSyncDomain` /
  `executePasswordChange` in `internal/users/handlers.go` are the reference).
- The standalone blob PUTs (`upsertE2EEBlob`) serialize against the password
  transaction by locking the `users` row `FOR NO KEY UPDATE` before the
  upsert — without it, a first-time INSERT could land between the password
  transaction's assert-absent read (which locks no row) and its commit,
  stranding old-key ciphertext past the rotation. Do NOT remove that lock or
  reorder it after the domain-row write (lock hierarchy is `users` → domain
  row on every path).
- Password change and destructive authenticated key replacement MUST re-check
  password/MFA step-up after acquiring the user-row lock. A request authorized
  by credentials superseded while it waited may not rotate any key material.
- Destructive key replacement or recovery MUST atomically force Custom Status
  visibility Off, erase its stored text/emoji, and delete the old exception
  preference (cascading materialized recipients), then issue a
  sender-coordinated clear only to the conservative base presence audience
  before disconnect. If Commit is ambiguous, keep any single-use recovery token
  consumed and run that scoped clear attempt before disconnect.
- Logout/account switch MUST invalidate account-bound hydration and push work
  before clearing stores or accepting the next account's credentials. Delayed
  decrypts, bootstrap pushes, timers, entitlement responses, or password-change
  key initialization may not resume.

### Owner-bound SSO admission (#2424)

SSO login admits an E2EE-gated session bound to the opaque `CredentialOwner`
reserved at sign-in (see [the Electron rule](electron.md) § "IPC contract v19"). Two
invariants protect E2EE custody across the admission; both the direct
(`admitDirectSSOLogin`) and MFA (`admitVerifiedSSOMfaSession`) paths in
`useSSOFlow.ts` must satisfy them:

- **Arm the gate BEFORE publishing auth.** `useE2EEStore.setNeedsSSOUnlock(true,
  owner)` MUST run before `beginAuthLifecycleIfCurrent` (which sets the access
  token), with NO intervening `await`. Zustand subscriptions are synchronous, so
  a subscriber that observes a non-null access token must in the same tick
  observe `needsSSOUnlock=true` with the matching owner — otherwise it could
  admit authenticated UI against a prior account's ambient `ready`, momentarily
  bypassing the owner-bound unlock. Resetting `ready` is NOT an equivalent
  ownership proof; the gate + owner is.
- **Roll back the gate owner-scoped.** If the auth publish loses its
  currentness check after the gate is armed, clear the gate ONLY while it still
  belongs to that owner (`rollbackSSOUnlockGate`: `needsSSOUnlock &&
  ssoCredentialOwner === owner`). A superseding flow may have re-armed the gate
  under its own owner in between; an unconditional clear would strip the
  successor's gate.

SSO MFA refresh-token material stays in main (the `sso:completeMFA` custody
boundary); the renderer receives only `{accessToken, sessionId, credentialOwner}`
and NEVER calls the unrestricted `storeRefreshToken` for SSO. A stale MFA
completion is rejected before it mutates successor credential or E2EE custody,
and modal completion is bound to its challenge token so a late challenge-A result
cannot settle challenge B.

## Implementation

- Use WebCrypto API (frontend) or Go `crypto/*` standard library (backend)
- `e2eeService` is the canonical client-side encryption/decryption service
- Encryption is structural — all channel and DM content flows through `e2eeService` unconditionally; fail closed with blank/error state if the service is not initialized (per #918 startup-race guard), never render ciphertext.
- Every ciphertext write — sends, queued sends, edits and attachment uploads — MUST take the key and its `key_version` from ONE call: `encryptForChannelWithVersion` for message content, `getChannelKeyMaterial` for an attachment key. Never pair an encrypt with a separate `getCurrentKeyVersion` read. The cache can change between the two, and a malformed-response refetch (a bad wrap or a bad served epoch) holds its slot at `keyVersion: 0`, so the stamped epoch can differ from the one that encrypted: a 0 closes the socket with 4400, and a different positive epoch sends readers after the wrong key. This rule first named edits only, and the channel, DM, queued and attachment send paths kept the split read until it was widened. The current-key fetch never substitutes a default either: `validateServedEpoch` rejects a served `key_version` that is not a positive safe integer as `MALFORMED_PAYLOAD`, on the same refetch-once budget as a malformed wrap, instead of replacing it with 1. An attachment reads its pair per file, after the metadata strip, never once for a whole batch. The read is not adjacent to the seal: the chunked path opens an upload session between them and re-seals the whole file on a 410 restart, and the legacy AES-GCM pass is itself asynchronous. So each path takes `createChannelOperationGuard` before the read and asserts it after sealing — the legacy path after `encryptFile`, the chunked path after every part and before its PUT, through the required `UploadSessionCallbacks.assertKeyCurrent` — and a `key_revocation` processed in that window stops the file instead of sending it. The guard trips on ANY invalidation of that channel's key, not only a revocation: voice self-healing recovery also calls `invalidateChannelKey`, so an upload into the active voice channel or DM call errors and must be re-sent. That is fail-closed by design; the upload path does not retry. The server rejects a missing or zero epoch on every write. Message sends and edits also reject a revoked epoch; attachment uploads check only that the epoch was issued (`validateAttestedEpoch`, `internal/media/upload_session.go`), deliberately, so an upload racing a rotation is not failed; that client fence is therefore the only thing that stops a part sealed after the revocation was processed. For edits, on the first `409 epoch_revoked` response, invalidate that channel key and retry exactly once; all other failures stop without retry.
- Current-key and versioned-key work is bound to both the E2EE session generation and the channel-key generation. `clearKeys()` and `invalidateChannelKey()` MUST invalidate pending fetch, unwrap, and decrypt continuations so late work cannot repopulate a cleared cache or apply content under stale credentials. Same-session content resets use `fencePendingOperations()` to reject prior continuations without discarding valid keys. Ordinary `invalidateChannelKey()` mismatches are retryable rotations; authoritative access loss MUST call `revokeChannelAccess()` before purging decrypted state so pre-revocation work fails terminally and never enters a history-refetch path.
- A rotation coordinator captures `createChannelRotationGuard()` when it receives the event, before jitter. That guard intentionally survives ordinary `invalidateChannelKey()` calls (including its own `key_delivered` event between batches), but still rejects a changed E2EE session or terminal channel-access revocation. Do not delay guard capture until the timer fires or use the ordinary channel-operation guard for rotation batches.
- Auth-flow cleanup after initialization MUST use the `E2EEInitializationReceipt` **returned by `initialize()` itself** with `clearKeysIfInitializationCurrent()`, never unconditional `clearKeys()`. **The receipt is invocation-owned (#2423):** `initialize()` returns `Promise<E2EEInitializationReceipt | null>` — the receipt is constructed at `finalizeKeys`' synchronous commit point from THAT call's local `sessionKeys` + `attempt`, so a caller always receives provenance for exactly the keys it committed, never a successor's ambient state. A guard-declined commit returns `null` (never a false commit, never a resident successor's receipt); teardown/supersession still throw `E2EEInitTeardownError`. Do NOT reintroduce a post-hoc `captureInitializationReceipt()` that reads mutable singleton state after the await — that let a stale auth flow capture/persist/clear its successor's keys (the #2423 race). Cleanup is admitted only while the exact `sessionKeys` object identity, its committed `sessionKeysInitAttempt`, and the latest-started `initAttemptSequence` all match the receipt attempt. The identity checks protect a newer committed keyset; the latest-attempt check protects a newer initializer that has started but not yet committed.
- Channel keys use epoch-based rotation with RSA-OAEP wrapping
- Group-DM membership and deletion transactions MUST lock the `dm_conversations`
  parent before child mutations. Add/remove use `FOR NO KEY UPDATE` before changing
  `dm_participants`; deletion uses `FOR UPDATE` before deleting children. Never take
  a participant/FK lock first and upgrade the parent later; that order can deadlock.
- Media per-frame E2EE decrypt stays fail-closed: undecryptable frames are dropped. After a video decrypt stream recovers from an epoch-key miss, the receiver may ask media-plane for a fresh keyframe, but it never renders or forwards the dropped ciphertext as plaintext.

### Media frame crypto v3 (#1878; historical rollout format)

The media per-frame trailer is 21 bytes (`TRAILER_SIZE_V3` in
`renderer/services/e2ee/mediaEncryption.ts`); the wire layout, in order, is
`[headerBytes:1][keyId:2 BE][key_version:4 BE][IV:12][magic:2]` — the ratchet
`keyId` precedes the channel `key_version`, both big-endian.
Receivers key their decrypt map by `senderId:keyVersion:keyId`, so they derive the
exact key deterministically across mid-session CSK rotations — fixing the
sender/receiver ratchet-base desync that black-screened video. On a typed
`FrameKeyMissError`, **both decrypt paths** request the specific `(version, keyId)`
key on demand, fetched server-gated via `e2eeService.getChannelKeyByVersion`
(`GET /api/v1/e2ee/keys/{channelId}?version=`): the RTCRtpScriptTransform **Worker**
path via `requestFrameKeyOnce` (`workers/e2eeWorker.ts`), and the legacy
`createEncodedStreams` main-thread path (`services/e2ee/voiceE2eeTransforms.ts`
`applyLegacyDecryptPipeline`) via the `requestFrameKey` recovery callback — both
routed through VoiceService's shared `provisionFrameKey`. This parity is **load-bearing,
not incidental**: `RTCRtpScriptTransform` is now preferred whenever available, while
`createEncodedStreams` remains the fallback for builds without the Worker API. The #1895
incident proved that wiring provisioning into only one supported path silently black-screens
clients on CSK rotation. Do NOT add a future decrypt-path branch that provisions on only one path.

Forward-secrecy posture (**Decision B**):

- **Intra-version forward secrecy is intentionally dropped.** Every revocation
  rotates the CSK, so the per-frame `keyId` ratchet was only ever a sync mechanism,
  not an access boundary. The 10s old-keyId overlap is a delivery window for
  in-flight frames, not an FS boundary.
- **Inter-version forward secrecy is preserved** by CSK rotation + re-wrap to the
  remaining members on membership change: a removed member's
  `getChannelKeyByVersion` for the new version 403s server-side, so it can never
  derive the post-rotation frame key.
- **The stamped `keyVersion` is unauthenticated** — frames decrypt with no AAD
  (`crypto.subtle.decrypt({ name: 'AES-GCM', iv }, …)`), so the trailer only
  _selects_ the key. A tampered version flip therefore degrades to a fail-closed
  frame drop (`FrameKeyMissError` / GCM `OperationError`), never a decryption with
  the wrong-version key or an exfiltration path.

### Media frame crypto v5 (2026-07-15)

v5 is **per-codec**. `encryptFrame(frame, codec)` / `decryptFrame(frame, senderUserId,
codec)` in `mediaEncryption.ts` dispatch by the `CodecFamily` resolved from the producer or
consumer's first **non-auxiliary media codec** in `workers/e2eeProtocol.ts`. The resolver skips
RTX, RED, ULPFEC, FlexFEC, comfort-noise, and telephone-event entries; reading `codecs[0]` can
select an auxiliary codec and make sender/receiver framing disagree:

- AV1 retains v4's per-OBU payload scheme.
- H.264 uses the v5 Annex-B/NAL-aware access-unit scheme below. It is **not** whole-frame.
- VP9, VP8, Opus, and unknown byte-transparent codecs use whole-frame v5.

**AV1 — per-OBU payload encryption (retained from v4):**

- Encrypt only `OBU_FRAME(6)` and `OBU_TILE_GROUP(4)` payloads. OBU headers, leb128 sizes,
  temporal delimiters, and metadata remain clear so the SFU can parse or rewrite structure.
  OBU structure and its mini-header are not AAD; binding rewritten leb128 sizes would break
  authentication.
- Each encrypted OBU prepends the shared 22-byte mini-header from
  `mediaFrameMiniHeader.ts`: `[magic:2][IV:12][keyId:2 BE][keyVersion:4 BE][reserved:2]`.
  Every OBU uses a fresh full 96-bit CSPRNG IV. Do not restore a deterministic counter prefix:
  a recreated media session can reuse the same CSK-derived sender key, so reset counters are not
  a unique cross-session nonce domain. v5 relies on full-random IVs plus existing CSK/key rotations
  as an operational control; it does not claim a process-local counter proves a global per-key
  invocation bound across recreated sessions or devices. A hard global nonce domain requires the
  version-gated per-session subkey design described in the native media-engine specification.
- Receivers derive OBU boundaries only by re-parsing the received leb128 sizes. Malformed,
  overlong, oversized, or over-count inputs fail closed. Rebuilt encrypted OBUs force
  `has_size_field=1`; structure-only AV1 frames contain no coded-pixel payload and pass through
  clear by design.

**H.264 — Annex-B/NAL-aware encrypted access-unit suffix:**

- `parseH264AnnexB` accepts a bounded, supported set of complete Annex-B NAL units and rejects
  malformed or unknown structures. The sender keeps the access-unit prefix clear through the
  first VCL NAL header and the first three Exp-Golomb slice fields (`first_mb_in_slice`,
  `slice_type`, `pic_parameter_set_id`). Parameter/metadata NALs before that first slice remain
  visible to libwebrtc.
- One fresh 96-bit random IV and one AES-256-GCM operation protect the entire remaining access-unit
  suffix, including later slices and NAL delimiters. The first VCL NAL header plus clear slice
  prefix is AAD; preceding delimiters and parameter/metadata NALs are not.
- The encrypted terminal region is `[22-byte mini-header][ciphertext + 16-byte tag]`, then
  reversibly emulation-prevention-stuffed with the preceding clear-byte zero-run as context.
  Stuffing prevents ciphertext from synthesizing `00 00 01` and becoming a false packetizer
  boundary. The receiver independently locates the clear boundary, unstuffs, authenticates,
  decrypts, and restores the exact original suffix.
- H.264 is admitted only with `packetization-mode=1`; the protected NAL may grow and therefore
  needs FU-A fragmentation. Any unsupported NAL, missing/invalid mini-header, malformed stuffing,
  missing VCL boundary, key miss, or GCM failure drops the frame. Do not fall back to plaintext.
- **Accepted metadata/availability tradeoff:** SPS, PPS, AUD, SEI, delimiters, and other supported
  pre-VCL bytes remain visible and are not authenticated. An on-path participant or compromised SFU
  can tamper with them to disrupt decoding, but cannot forge the authenticated slice suffix or
  recover pixel content. Expanding AAD requires packet-capture proof that libwebrtc and mediasoup do
  not legitimately rewrite the added bytes; otherwise it would turn normal rewrites into drops.

This is the custom H.264 **frame-protection boundary**. libwebrtc still owns RFC 6184
packetization, pacing, retransmission, and feedback; do not add a second RTP packetizer without
wire evidence that libwebrtc mutates the protected suffix.

**VP9 / VP8 / Opus — whole-frame v5:**

```text
[unencrypted header (1–10 B)][AES-256-GCM ciphertext + 16-byte tag]
[headerBytes:1][keyId:2 BE][keyVersion:4 BE][IV:12][version:1 (=5)][magic:2]
```

The trailer remains 22 bytes. Receivers require `version === 5` before crypto, so an older
whole-frame format is rejected deterministically. Whole-frame and AV1 encryption use no AAD so a
BUNDLE payload-type collision cannot make a correctly keyed frame fail merely because the
receiver inferred different leading-header bytes. Do not generalize that rule to H.264; its clear
first-slice parser prefix is authenticated as described above.

**Both transform APIs are load-bearing:** codec-aware dispatch and typed
`FrameKeyMissError` provisioning must reach the `RTCRtpScriptTransform` Worker and the legacy
`createEncodedStreams` main-thread fallback. A key miss requests the exact
`(senderUserId, keyVersion, keyId)` through the shared `provisionFrameKey` path; a GCM failure is
not treated as a key miss. Sender transforms attach synchronously through mediasoup-client's
`onRtpSender` hook before SDP offer creation or server-side producer signaling. Transform setup
failure aborts publishing; post-`produce()` attachment is forbidden because it can emit plaintext
before E2EE becomes active. **Receiver transforms attach symmetrically at receiver creation**,
through `ConsumerOptions.onRtpReceiver` (fires between `setRemoteDescription` and
`createAnswer`): Chromium ≥149 ignores a receive transform attached after the receiver is live —
zero frames enter it while ciphertext reaches the decoder — and replacing one throws
`InvalidStateError`, so late attachment is the legacy pipeline's path only. A per-consumer bypass
probe pairs decoder-side `getStats()` with the worker's entered-frame count and, on a confirmed
engine bypass, fails closed and switches the page session to the legacy `createEncodedStreams`
pipeline once (automatic media-session rebuild; `sessionStorage['concord.e2eeLegacyFallback']`,
manual override `localStorage['concord.forceLegacyE2EE']`). Decoded ciphertext is never an
acceptable output: silence beats noise.

**The PiP window decrypts its own consumers (2026-08-21 PiP E2EE gap):** a PiP `BrowserWindow` is a separate
renderer context, so it shares none of the main window's transforms. `PipVoiceClient` therefore owns
a decrypt-only E2EE Worker (never sent `init` — a PiP has no producers) and attaches its own
transform through mediasoup-client's `ConsumerOptions.onRtpReceiver`, the receive-side mirror of the
`onRtpSender` rule above. It never touches `e2eeService`, IndexedDB, or CSK unwrap: it requests the
single derived frame key over the PiP→Main `BroadcastChannel` proxy (`get-frame-key` →
`voiceService.deriveFrameKeyForPip`), and because `CryptoKey` is structured-cloneable the key
crosses as a handle rather than raw bytes. **That is not a confidentiality boundary:** frame keys
are EXTRACTABLE by construction — `deriveFrameKey`/`ratchetKey` export raw bytes to derive the next
epoch — so any same-origin listener on the `concord-pip` channel could export one. It is the same
trust boundary the main window's `worker.postMessage` already relies on, widened from
point-to-point to a named channel; same-origin script execution is out-of-model, since it can read
the CSK directly. Do not describe this transport as non-extractable. The request carries an
explicit `(keyVersion, keyId)` on a typed Worker miss, and the version drives the CSK lookup: a key
derived from the current CSK for an older version's frame decrypts to garbage. Every refusal is
fail-closed and the stream is not played — no transform constructor, `onRtpReceiver` never invoked,
attachment threw, or the bypass probe confirmed after one re-attach. The PiP supports the
`RTCRtpScriptTransform` path only, so it refuses whenever the shared resolver returns anything else.
It sees the manual `localStorage['concord.forceLegacyE2EE']` override (localStorage is shared
per-origin across `BrowserWindow`s) and refuses up front; it cannot see the automatic
`sessionStorage['concord.e2eeLegacyFallback']` fallback, which is per-window, so there its own
bypass probe reaches the same fail-closed outcome a few seconds later. Either way the PiP plays
nothing rather than ciphertext.

**Key schedule unchanged from v3:** `deriveFrameKey`, `ratchetKey`, the
`senderId:keyVersion:keyId` decrypt-key map, and server-gated
`getChannelKeyByVersion` provisioning are unchanged. v5 changes framing, not the cipher or keys.
Sender CSK rebase is monotonic and session-fenced: an out-of-order version fetch may install only
if it is still the latest requested version for the same active channel, user, `MediaEncryption`
instance, and Worker. Install the derived key and stamped version together; stale work must never
roll a sender backward or mutate a replacement session. Initial sender setup and current decrypt-key
provisioning fetch an atomic `{channelKey, keyVersion}` snapshot and carry that exact version through
derivation. A once-announced higher sender version gets four total fetch attempts with
500/1000/2000 ms backoff; pending/rate-limit/network/server failures retry, while membership,
revocation, invalid-request, and malformed-key errors terminate immediately. Terminal or exhausted
rebase tears down media only if every captured session identity and requested version is still
current; a superseded or replacement session is left untouched. During that bounded retry window,
the sender continues stamping the prior version; server-side participant removal and forwarding
authorization are therefore part of the revocation boundary.

Initial media-E2EE setup is single-flight for one channel/user/generation and subscribes to key
rotations **before** its first key fetch. It builds `MediaEncryption` and Worker candidates off to
the side, checks the captured channel/user/generation and prior shared-object identities after every
await, then publishes key, stamped version, Worker, and subscription in one synchronous commit.
Rotations buffered during derivation are reconciled against `getHighestSeenKeyVersion` before the
subscription becomes live. Cleanup invalidates the generation and unsubscribes at entry, before its
first await; stale retries or failed initializers may destroy only candidates/state they still own.

**Simulcast-screen safety (#1924):** H.264/VP8 simulcast publishes independent encodes. Each
encoded frame on each layer gets its own random IV, so layering does not reuse a GCM nonce. H.264
uses one NAL-aware AEAD per access unit; VP8 uses whole-frame v5. AV1 screen remains SVC or a
single stream and never simulcasts as a product layering contract; its full-random per-OBU IVs do
not themselves imply simulcast support. Never bind SSRC/RID into an IV or the H.264 AAD. The
media-plane screen gate remains authoritative.

**Forward-secrecy posture (Decision B, unchanged from v3):** the keyId ratchet is synchronization,
not an intra-version access boundary. CSK rotation/re-wrap and the server's versioned-key access
gate provide inter-version forward secrecy for removed members. The mini-header/trailer
`keyVersion` selects the key; tampering causes a key miss or authentication failure and a
fail-closed frame drop.

**References:** historical AV1 v4 design
`2026-06-26-1895-av1-obu-aware-frame-crypto-v4-design.md`
and the v5 implementation plan
`2026-07-15-h264-hdr-media-pipeline.md`.

### Attachment crypto v2/v3 (chunked, #2157)

Attachments larger than a single request can carry use a **chunked AES-GCM envelope**.
Media frames and attachments are different problems and are deliberately solved
differently; do not harmonise them.

**Layout.** `header(28) ‖ chunk[0..n-1]`

```text
header : magic:2 ("CV") | version:1 | flags:1 | chunkSize:4 BE | totalChunks:4 BE | fileNonce:16
chunk  : IV:12 | AES-GCM(ciphertext ‖ tag:16)
```

**Geometry.** v2 gives chunk 0 the full `chunkSize` plaintext budget, so its
multipart part is 28 header bytes larger than its non-trailing siblings. v3
reserves those 28 bytes from chunk 0's plaintext budget; the nominal
`chunkSize` field stays unchanged, and every non-trailing part is uniform.

**Envelope selection is capability-negotiated.** A control plane that wires
`chunkedAttachmentUpload` advertises `attachmentEnvelopeVersions: [2]` while
`CLIENT_MIN_VERSION` is empty, malformed, or below `0.2.44`, and `[2, 3]` when
the configured reader floor is `0.2.44` or newer. v3 read support remains
enabled regardless. The desktop writer selects v3 only when both the chunked
route and that numeric capability advertise 3; a missing field or v2-only list
selects v2. A capability payload containing any other envelope version is
rejected rather than filtered. There is no retry or downgrade after encryption.
This keeps older control planes and older clients interoperable while allowing
uniform-part v3 only after every admitted client can read it.

**Reader-floor and R2 admission are separate controls.** `X-Concord-Client-Version`
and WebSocket `client_version` are untrusted exact stable `X.Y.Z` compatibility
declarations, never signed attestation, authentication, authorization, entitlement,
or cryptographic evidence. The authenticated REST and WebSocket admission floor
returns 403 `CLIENT_VERSION_TOO_OLD`; `/attestation/verify` remains AuthRequired-only
and outside the floor, while public config/auth/update recovery stays available.
Stored v1/v2 attachments remain readable forever. Only after the reader floor is
armed and capability `[2,3]` is published may an armed R2 selector reject a new v2
chunked session initialization before allocation. The older design's rule that new
v2 admission remains forever is superseded for an R2-armed SaaS deployment; its
stored-readability guarantee is retained.

**Per-chunk AAD is NORMATIVE — 34 bytes, in this order and with a
version-specific leading tag:**

```text
"CVA<version>":4 | version:1 | flags:1 | fileNonce:16 | chunkIndex:4 BE | totalChunks:4 BE | chunkSize:4 BE
```

The tag is `CVA2` for v2 and `CVA3` for v3. The version byte and the tag both
move with the format; changing either without the key fails authentication.

EVERY header field is bound. `flags` joined the AAD during this PR's review,
before release: it was refused-if-non-zero at two validation points, so tampering
already failed closed — but that defence lived in a rule rather than in the tag,
and the first version to give a flag bit meaning would have inherited an
attacker-selectable, unauthenticated selector. Adding it after release would have
required a format version bump, because it changes every stored ciphertext's AAD.
v3 introduces no header field, but it still uses a distinct `CVA3` domain so a
header version rewrite cannot re-frame v2 ciphertext as v3. Any future version
that introduces a header field must extend the AAD in the same change.

Every field earns its place, and dropping any one re-opens a specific attack:

| Field | Without it |
|---|---|
| `chunkIndex` | chunks reorder undetectably |
| `totalChunks` | the file truncates undetectably |
| `fileNonce` | chunks splice across two files encrypted under the same key |
| `chunkSize` | the file re-frames under a different chunking |

**WHY ATTACHMENTS BIND AAD WHERE MEDIA FRAMES DO NOT.** A media frame is one
independent unit whose loss is a dropped frame; there is no ordering or
completeness claim to forge, and v5 deliberately keeps AAD minimal because
binding rewritten container sizes would break interop. An attachment is a
*sequence* whose meaning depends on order and completeness, and it is
reassembled from parts an untrusted server holds. The AAD is what makes the
sequence itself authenticated rather than merely each part. This asymmetry is
intentional — see the v3/v5 sections above before "unifying" anything.

**The header is UNAUTHENTICATED and must be treated as untrusted input.** It is
outside every chunk's ciphertext, so it selects parameters, it does not attest
them.

What bounds the allocation is **arithmetic, not a cross-check** — an earlier
version of this paragraph described a comparison against chunk 0's AAD that does
not exist and never did. `classifyEnvelope` subtracts the header and the declared
per-chunk overhead from the observed blob length to recover the plaintext body,
then requires `chunkCountFor(version, chunkSize, body) === totalChunks`. For v2
that count is `ceil(body / chunkSize)`; for v3 chunk 0's budget is
`chunkSize - headerSize`, so the count is `1 + ceil((body - firstBudget) /
chunkSize)` after the first budget. `chunkSize` is also pinned to a single
allowlisted value before decryption. The loop count is therefore fixed by the
bytes actually present, under the declared version's geometry, before any chunk
is opened. A tampered header fails closed on the first GCM open rather than
steering a large allocation. The outcome the old sentence claimed was right;
the mechanism it named was fiction, and a maintainer could have "restored" or
relied on it.

**THE SERVER NEVER PARSES THE ENVELOPE.** The control plane sees opaque
ciphertext and a declared length, and validates only arithmetic — that the
declared byte count matches the chunk count and size the client asked for. It
could not verify framing without the key, and a check that cannot fail closed is
worse than no check. Session init carries `envelope_version`; absent or zero
normalizes to v2 for old-client compatibility, while v2 and v3 select their own
chunk arithmetic. That field is a declaration, not capability negotiation.

**Legacy dispatch is DETERMINISTIC, and the arithmetic is the discriminator —
not the magic.** A legacy blob opens with a random 12-byte IV, so roughly 1 in
65,536 begin with `"CV"` by chance. Classification is four-way — `v2`, `v3`,
`unsupported`, `legacy` — never two-way: a blob whose magic and version match a
FUTURE version must be refused, not decrypted as legacy. `classifyEnvelope`
accepts v2 or v3 only when that version's declared geometry reproduces the
observed blob length exactly.

**Client-side ceilings.** The chunked path removes the whole-file requirement for
transport but not for metadata stripping: EXIF/XMP removal needs the whole image
in hand, so images keep `IMAGE_STRIP_MAX_BYTES`. That ceiling is a property of
stripping, not of the plan or the server version, and no upgrade moves it.

**References:** design
`2026-08-21-2157-chunked-attachment-wire-format-design.md`.

### Age-claim signing — device-key reuse for RSA-PSS (#1624)

The age-verification system (#272) signs age claims with the **same install-time device
RSA key** used for E2EE — no new keypair is minted. Two methods on the canonical crypto
service back this:

- `e2eeService.deriveSigningKey()` re-unwraps the SAME `wrappedPrivateKey` (via
  `unwrapSigningKey` in `utils/crypto/crypto.ts`, a mirror of `unwrapPrivateKey`) as a
  **non-extractable** `RSA-PSS` / `['sign']` handle instead of the `RSA-OAEP` / `['decrypt']`
  handle `derivePrivateKey()` yields. The wrapped PKCS8 is algorithm-agnostic RSA key
  material; WebCrypto fixes the unwrapped key's algorithm + usages at unwrap time, so the
  one wrapped blob yields either handle. Raw PKCS8 is never exposed.
- `e2eeService.signAgeClaim(bytes)` derives that handle and signs under
  **RSA-PSS / SHA-256 / `saltLength: 32`** (the salt the Go verifier requires —
  `PSSSaltLengthAuto` is rejected), returning base64. Keeping `crypto.subtle.sign` here
  (a designated crypto module) satisfies the `concord-crypto-outside-module` Semgrep rule:
  the consumer `ageClaimService` orchestrates without ever touching `crypto.subtle` or a
  `CryptoKey`.

Two load-bearing caveats:

- **Modulus-reuse — NOT a second factor.** The age signature shares the E2EE key's modulus,
  so it is exactly as trustworthy as device-key custody, not an independent assurance factor.
  Downstream consumers (#1625 DOB, #1626 SSO) must not market it as one.
- **Byte-parity is the contract.** The client canonical serializer
  (`renderer/services/system/ageClaim/canonicalAgeClaim.ts`) MUST stay byte-identical to the Go
  server's `services/control-plane/internal/age/canonical.go` — the committed A↔B fixture
  (`internal/age/testdata/age-claim-canonical-v1.json`) is asserted by the client signing
  test. See `docs/age-claim-canonical-form.md` for the byte contract and the modulus-reuse
  note; do not re-derive either.

## Self-Review

- All crypto code MUST follow RCI pattern (see `docs/ai-workflows/rci-workflow.md`)
- Review against OWASP Top 10 and CWE Top 25 before presenting
- Minimum 2 review cycles for complex security code

## Incident Response

If a channel key, DM key, or user RSA private key is compromised — or rotation is required for any other reason — follow the Key-Compromise IR Playbook, §7.1 (E2EE channel / DM keys). The playbook covers detection, containment via the `key_revocations` epoch ledger for server channels and the `dm_key_revocations` epoch ledger for DM conversations, rotation, and post-incident review.

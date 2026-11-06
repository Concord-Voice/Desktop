# Authority contract, PR 2: published-chain verifier (TypeScript) — Plan

**Goal:** the desktop computes the same §2.12 Reason as the Go reference
(Concord-Voice/Self-Hosted `services/control-plane/internal/authoritycontract`)
for every published-chain verification vector. Section numbers (§) refer to the
account-key authority design of record.

**Constraints:** pure functions, async only for Web Crypto, no I/O, no clock
(time is a `nowMs` parameter), no `Buffer`, no `any`, no `!` in `src/`. Every
unexpected input is a refusal Reason; the public verifiers never throw. Tables
are frozen. `Floor` and `DeriveAssurance` stay unported (authority-only).

## Files (all under `desktop/src/renderer/services/e2ee/authority/`)

| File | Ports (Go) | Exports |
|---|---|---|
| `reason.ts` | `reason.go` | `Reason`, `Verdict`, `REASONS`, `verdictOf`, `noticeOf` |
| `messages.ts` | typed views of PR 1 layouts | `Intent`, `Result`, `Status`, `Bundle`, …, `decodeAs`, `sigMsg` |
| `trust.ts` | `trust.go` T1–T5, `CheckTrustEnvelope` | `Trust`, `newTrust`, `checkTrustEnvelope`, `HighWater`, `maxHW` |
| `trustcheck.ts` | `trustcheck.go` T6, T7, T8, T12 (client forms) | `checkT6`, `checkT7`, `checkT8`, `checkT12`, `rskRule` |
| `pub.ts` | `pub.go` | `Pub`, `FromCode`, `classify`, `activate`, `pubOfResult` |
| `table.ts` | `table.go` client-checkable columns | `ROWS`, `rowByN`, `rowsFor` |
| `assurance.ts` | `assurance.go` minus `DeriveAssurance` | `rank`, `capAt`, `segmentRule`, `knownSegment` |
| `post.ts` | `post.go` row interpreter | `selectRow`, `intentForOp`, `checkIntentValues`, `checkPost` |
| `replay.ts` | `replay.go` R1–R5 | `checkIssued`, `checkANB`, `hypotheses`, `pickMatch`, `fixAllows`, `checkR5` |
| `heads.ts` | `heads.go` chain-head, `headmove.go` chain parts | `ChainHead`, `parseChainHead`, `chainHeadBytes`, `genesisHead` |
| `bindproof.ts`, `restore.ts` | rows 20–22 checks | `checkBindingProof`, `checkPendingRecoveryKey`, `checkRestoreCancel` |
| `patterns.ts` | `RecoveryBindForKind`, `CheckRelayRecover` | same names, camelCase |
| `chain.ts` | `chain.go` | `verifyBundle`, `verifyChain` |
| `status.ts` | `status.go` minus R6 `WrapKey` | `verifyStatus`, `VerifiedStatus` |

## Vector types with verdict parity after this PR

`chain` (92), `bundle-verify` (145): Reason and verdict, plus `expect.head_b64`.
`for-op` (123): refusal code and reason context, as the Go harness checks it.
`pattern` (7): Reason. `p1` (2): status message unchanged. The test asserts each
of these types was exercised at least once.

Codec-only (need the private device ledger, later PRs): `device-ledger`,
`device-wrap-open`, `apply-device-op`, `normalize`.

## Review focus

1. R3/R4: exactly one hypothesis may match; a retained fix only removes one, and
   an activation fix is replaced only by an earlier activation (`keepsFix`).
2. Arithmetic above 2^53 − 1: every sum the Go code bounds with `addMs` or
   compares as uint64 is done exactly (BigInt or a pre-check), never rounded.
3. T7/T8 existential search over retained delegations is order-independent
   (`delegations` sorted by msg bytes, `bestOf` ranking).
4. A re-installed root (A-B1) and an EK seen before (`ekIndexHas`, pin, legacy
   digest) are `transition_invalid` on every installing row.
5. The first-sight pin: `chainSeq0Pin` at genesis, `pin_changed` past genesis in
   every state, and LD-28's accepted pin only for `new-secret`.

## Tasks

1. Extend `vectors.parity.test.ts` (failing first), then implement bottom-up:
   reason → messages → trust/trustcheck → pub/table/assurance/post → replay →
   heads → bindproof/restore/patterns → status → chain.
2. Focused tests for error paths the vectors miss (≥ 80% new-code coverage).
3. README, CHANGELOG `[Prerelease]`, lint, typecheck, prettier, one mutation check.

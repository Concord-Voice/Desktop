# Authority contract, PR 3: device ledger, device rules and wraps (TypeScript) — Plan

**Goal:** the desktop computes the same result as the Go reference
(Concord-Voice/Self-Hosted `services/control-plane/internal/authoritycontract`)
for every private-device-ledger, device-rule and device-wrap vector. Section
numbers (§) refer to the account-key authority design of record.

**Constraints:** as PR 2. Pure functions, async only for Web Crypto, no I/O, no
clock, no `Buffer`, no `any`, no `!` in `src/`, frozen tables, and the public
functions never throw. The wrap opener also zeroes every byte array of key
material it holds before it returns. `Floor`, `DeriveAssurance`, the seal side
of wraps and the authority-only device helpers stay unported.

## Files (all under `desktop/src/main/authority/`)

| File | Ports (Go) | Exports |
|---|---|---|
| `devicerules.ts` | `devicerules.go` (D-270, DR1–DR9) | `applyDeviceOp`, `normalizeDeviceSet`, `emptyDeviceSet`, `HeadInput`, `DeviceOpInput` |
| `patterns.ts` | `DeviceIntentForOp` (device-intent parts table) | `deviceIntentForOp` |
| `ledger.ts` | `ledger.go`, `view.go` (`VerifyDeviceLedger`, `DeviceView`) | `verifyDeviceLedger`, `DeviceView`, `MAX_LEDGER_HYPOTHESES` |
| `heads.ts` | `heads.go` device-head codec | `DeviceHead`, `parseDeviceHead`, `deviceHeadBytes`, `admittedRecord`, `secretsRecord` |
| `wrap.ts` | `wrap.go` open half (§2.5 device-wrap, device-secrets checks 1–4) | `verifyDeviceWrap`, `WrapOpened`, `DkxPair` |
| `chain.ts` | `verifyChainSteps` (the ledger reads each step) | `verifyChainSteps`, `ChainStep`, `STATE_REASONS` |
| `messages.ts`, `constants.ts` | device-* typed views; `MAX_DEVICES`, `RECOVERY_REPLACE_MS` | — |

## Vector types with parity after this PR

`apply-device-op` (103): refusal, Reason, verdict and the resulting set bytes.
`normalize` (35): the normalized set bytes. `device-ledger` (48): Reason, the
persisted chain-head and device-head bytes, and an unchanged `from` on a
refusal. `device-wrap-open` (20): Reason, and on `ok` the wrap's use. The
layout types `device-set` (25) and `device-wrap` (6) and the `device-id` (2)
primitive were already checked by PR 1. The coverage assertion now requires
every vector type to be exercised.

## Review focus

1. D-270's refusal order: parse set → pre-check → head gate → DR1 → DR4 →
   device limit → op body → encode.
2. Ledger hypotheses: the activation and completion forks, `take` (complete,
   then activate), dedupe, the cap of 8, and that a refuted hypothesis is
   dropped, not halted on.
3. DR8's entry-less change after rows 13, 14, 16, 17, 21 and 22, and the slot
   floor a persisted head carries.
4. Wrap checks 1–4: the head names the entry exactly once; the PKCS#8 is
   canonical (`exportKey(importKey(der))` equals the input); the root key signs
   the check message under the entry's root; the EK decrypts a fresh probe.
   Every refusal is `wrap_invalid` with no secrets.
5. Key hygiene in `wrap.ts`: Z, the plaintext and every imported copy are zeroed.

## Tasks

1. Extend `vectors.parity.test.ts` (failing first), then implement bottom-up:
   messages/constants → patterns → devicerules → chain steps → heads →
   ledger → wrap.
2. `device.test.ts` for paths the vectors miss (≥ 80% new-code coverage).
3. README, CHANGELOG `[Prerelease]`, lint, both typechecks, prettier, mutation
   spot-checks.

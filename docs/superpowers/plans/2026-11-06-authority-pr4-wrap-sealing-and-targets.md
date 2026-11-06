# Authority PR 4: wrap sealing and R6 wrap targets

**Goal:** port the two remaining pure functions that decide where a secret may
go: `SealDeviceWrap` (and its recipient rule `activeRecipient`) and R6's
`VerifiedStatus.WrapKey`, plus the client constant `RECOVER_CONFIRM_MS`.

**Reference:** Concord-Voice/Self-Hosted
`services/control-plane/internal/authoritycontract` `wrap.go`
(`SealDeviceWrap`, `sealTo`, `activeRecipient`) and `status.go` (`seal`,
`WrapKey`). Design of record §2.3, §2.5, §2.13 R6, E-S1, D-S2.

## Files

- `desktop/src/main/authority/ledger.ts`: `activeRecipient(h, r)`. The
  effective set is the persisted set, or the set a fix-shown new-root
  activation leaves (DR8); the recipient must be active with the same dkx.
- `desktop/src/main/authority/wrap.ts`: `sealDeviceWrap(h, recipient,
  entryDigest, secrets)`: a fresh non-extractable ephemeral P-384 key, Z by
  `deriveBits`, the same HKDF and AAD as the open path (now shared), a fresh
  12-byte nonce. Null on any refusal; the encoded plaintext and Z are zeroed.
- `desktop/src/main/authority/status.ts`: `verifyStatusAt` seals the wrap
  target in a module `WeakMap` keyed by the returned object, for ok and
  ok_accepted_pin only; `wrapKey(vs, servedSpki)` reads only that seal, for
  `new-secret` use, and returns a copy. Active → the verified EK (the pending
  one when R4 activated the raw pending head); absent or continuity pending →
  a served SPKI that is a valid EK whose SHA-384 is the status pin.
- `desktop/src/main/authority/constants.ts`: `RECOVER_CONFIRM_MS = 60_000`.

## Tests

- `device.test.ts`: seal→open round trip on `wrap/current` with a fresh epk
  and nonce; ct, tag, nonce and epk tampers are `wrap_invalid`; refusals for a
  stranger, another dkx, a 47-byte entry, no EK, an empty set, a malformed
  realm and a malformed admitted record; D-S2 on
  `ledger/status-shows-activation-before-completion` with and without the fix.
- `verifier.test.ts`: `wrapKey` on `head/after-rotations` (copy; a spread
  copy and a `history` verdict wrap nothing),
  `r4/status/pending-after-a-shown-activation` (the pending EK),
  `pin/accepted` and `row/02/pop-pending` (only the SPKI that hashes to the
  pin), and an edited `pin_changed` verdict.

## Review focus

1. A `VerifiedStatus` that did not come from `verifyStatusAt` must never wrap.
2. `served` must follow the status's state (absent) or a continuity pending
   verdict, exactly as the reference's `seal`.
3. The seal path must share the open path's info and AAD byte for byte.

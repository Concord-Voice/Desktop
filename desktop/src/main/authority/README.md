# Account-key authority contract (main-process port)

A TypeScript port of the account-key authority contract, protocol v1. Section
numbers (§) in this module refer to the account-key authority design of record.

**Where it runs.** This module runs in the **main process only**, inside the
signed binary. The renderer is hot-updated, so it must never import this
module, hold the realm anchors, or decide account-key trust. It asks for a
verdict over one IPC channel instead, which the first caller PR adds (with
sender validation and an `IPC_CONTRACT_VERSION` bump). The key-pin store lives
here too. The chain and ledger verifiers only handle public data
(signatures, public keys, anchors, digests), so they can later move into a
dedicated crypto process without changing that channel. `verifyDeviceWrap` and
`sealDeviceWrap` are the exception: one takes this device's ECDH private key
and returns the device's private keys, the other encrypts those keys to
another device. Where that key material lives is decided by the PR that first
calls them.

| File | Ports | Design of record |
|---|---|---|
| `codec.ts` | EN1–EN6, every layout, caps, cross-position rules | §2.3, §2.5, §2.6, §2.12 heads, §2.22 |
| `primitives.ts` | digests, P-384 and legacy RSA-PSS verify, EK SPKI checks, DeviceID, safety number, frozen texts | §2.4, §2.19, §2.20 |
| `bytes.ts`, `errors.ts` | strict base64, byte helpers, the `malformed` refusal | §2.3 |
| `reason.ts` | every Reason, its verdict and notice | §2.12, §2.13 |
| `messages.ts`, `constants.ts` | typed views of the layouts the verifier reads; protocol constants | §2.3, §2.5 |
| `trust.ts`, `trustcheck.ts` | T1–T5 (anchors, successions, delegations, halt, HW); client T6, T7, T8, T12 | §2.10 |
| `pub.ts`, `table.ts`, `post.ts`, `assurance.ts` | from-state codes, the §2.9 table (client columns), the row interpreter, segment rules | §2.7–§2.9 |
| `replay.ts` | R1–R5 | §2.11 |
| `heads.ts`, `headmove.ts` | the persisted chain-head and how a verified result moves it | §2.12 |
| `bindproof.ts`, `restore.ts`, `patterns.ts` | rows 20–22 checks; recovery-bind and relay-recover patterns | §2.9, §2.22 |
| `chain.ts`, `status.ts` | `verifyBundle`, `verifyChain`, `verifyStatus`, R6's `wrapKey` | §2.12, §2.13 |
| `devicerules.ts` | D-270 device rules DR1–DR9 (`applyDeviceOp`, `normalizeDeviceSet`) | §2.12, §2.22 |
| `ledger.ts` | the private device ledger (`verifyDeviceLedger`, `DeviceView`) | §2.12 |
| `wrap.ts` | sealing and opening a device wrap, and its device-secrets checks 1–4 | §2.5 |

The codec and primitives port `scripts/authority-vectors/gen.mjs` §1–3 in
Concord-Voice/Self-Hosted; the verifier ports the Go reference in
`services/control-plane/internal/authoritycontract` there. The module is pure:
no I/O, no stores, no clock reads, no `Buffer`. Nothing imports it yet, so it
has no runtime effect.

Entry points: `encode`, `decode`, `capOf` and `LAYOUTS` (codec); `sha384`,
`importP384`, `verifyP384`, `verifyLegacyPSS`, `checkEkSpkiWebCrypto`,
`deviceId`, `parseDev`, `safetyNumber` and `tlsPin` (primitives); `newTrust`
and `Trust` (trust); `parseChainHead`, `chainHeadBytes` and `genesisHead`
(heads); `verifyBundle` and `verifyChain` (chain); `verifyStatus` and
`wrapKey` (status);
`parseDeviceHead` and `deviceHeadBytes` (heads); `applyDeviceOp` and
`normalizeDeviceSet` (devicerules); `verifyDeviceLedger` (ledger);
`sealDeviceWrap` and `verifyDeviceWrap` (wrap); `pinnedEk` (primitives);
`verdictOf` and `noticeOf` (reason); `RECOVER_CONFIRM_MS` (constants).
`activeRecipient` (ledger) is exported only for tests: call `sealDeviceWrap`,
which applies it.

**Rules for callers:**

- `decode` returns nested-message positions (for example `bundle.intent` and
  `signed.msg`) as unvalidated bytes. Decode each with its own tag before use.
- `decode(tag, bytes, limit)` can only lower the tag's cap, never raise it.
- `safetyNumber` returns `''` for an invalid input. Treat `''` as an error;
  never display it.
- Decoding `device-secrets` yields private keys as base64 strings, which cannot
  be wiped from memory. Keep their lifetime short.

- Build a `Trust` with `newTrust(anchors)`, then `addSigned` or `addTrust` for
  every trust object. A `Trust` is not safe for concurrent use: await each
  call before the next, and do not admit trust objects while a verification
  that uses the same `Trust` is in flight (a verifier reads the halt only on
  entry). `delegations` and `lookup` return copies.
- Pass `verifyBundle`, `verifyChain` and `verifyStatus` only a head from
  `parseChainHead`, `genesisHead` or an earlier verification. A head that is not
  canonical is `malformed`.
- Time is a parameter: `nowMs` is the caller's clock in ms. `0`, or anything
  that is not a safe integer, is `malformed`.
- The verifiers never throw. Every unexpected input is a refusal Reason. On a
  refusal they return the head they were given, and that head is what to
  persist. Persist the returned head and HW only as bytes and numbers.
- `verifyBundle` keeps no fix from a call that fails. Pass the newest status you
  hold on every call.
- After an `ok` verdict on an account with no first-sight pin, store
  `VerifiedStatus.pin` as that pin (D-149).
- Pass `verifyDeviceLedger` only a device head from `parseDeviceHead` or an
  earlier ledger verification, and `verifyDeviceWrap` only the device head that
  `verifyDeviceLedger` returned. Persist both heads the ledger returns together.
- `verifyDeviceWrap` zeroes the byte arrays of key material it holds, on every
  path. That is best effort: strings inside the codec and the internals of
  every `CryptoKey` stay until garbage collection. The secrets it returns on
  `ok` are the caller's to zero after use.
- Wrap a secret only to the bytes `wrapKey` returns, never to a head's EK
  fields. Pass it a `VerifiedStatus` that `verifyStatus` or `verifyChain`
  just returned for `new-secret` use; a copy, a literal, an edited verdict or a
  `history` status wraps to nothing. It reads no clock: re-verify the status
  before each wrap.
- Pass `sealDeviceWrap` only the device head that `verifyDeviceLedger` just
  returned. It reads no clock, so an older head could wrap the root to a
  device whose removal the server is withholding. It seals only to an active
  device of that head with the dkx the head records. It copies the recipient
  and entry digest before the check, so the wrap uses the checked bytes.
- Pass `verifyDeviceWrap` a dkx key pair generated together: a non-extractable
  private key with the `deriveBits` usage only, and its own extractable public
  key.
- Pass `verifyDeviceLedger` device bundles only from a decoded `query-resp`
  (which caps them at 16), never from another source.
- Store the persisted heads where only the main process can write them, with
  integrity protection. A verifier trusts the head it is given.
- Before the first caller ships, run the wrap and ledger vectors in the
  Electron main process (see Runtime below).

**Verified now:** the published chain and the private device ledger. The parity test checks the port's Reason
and verdict against every `chain` (92), `bundle-verify` (145) and `pattern` (7)
vector. It also checks the persisted head for the 44 vectors that carry one. For
`for-op` (123) it checks the refusal code and its reason context, as the
reference harness does. For `p1` (2) it checks that the published status is
unchanged.

It also checks the private device ledger: the Reason and both persisted heads
for every `device-ledger` vector (48), the refusal and resulting set for every
`apply-device-op` vector (103), the set for every `normalize` vector (35), and
the Reason and use for every `device-wrap-open` vector (20).

It also round-trips `sealDeviceWrap` through `verifyDeviceWrap`, and checks
`wrapKey` on active, activated (R4), absent and continuity-pending vectors.

**Pending (later PRs):** verified-recipient handles, pin-store persistence,
the anchors, IPC, the distribution gate, the form-R and form-B confirmation
watches and the UI.

**Not ported:** `Floor` and `DeriveAssurance`, which only the authority
evaluates (§2.8, §2.12). The authority-only columns of the §2.9 table,
`AuthenticateDeviceBundle`, `BindTier` and the authority's device timing
helpers (`VisibleInstant`, `CompletionFirst`) are also not ported, nor are the
read-only `DeviceHead` helpers `View`, `HasActiveDSK`, `AdmittedBy` and
`BoundRecovery` (the ledger's outcome carries the view).

**Cost:** a step does not re-encode the head to check `HEAD_BLOB_MAX`. As in
the reference, every index edit records the bytes it adds (`headFits` in
`heads.ts`), and `seq_index` grows in place on a copy the call owns, so the
caller's head is never written. A chain of results that add no EK or root,
which is what the server's operator keys alone can produce, replays in linear
time (about 30 µs a step at 50,000 entries). Inserting into `ek_index`,
`root_index` and `recover_index` still copies that index, as the reference
does; those grow only with events the account's own devices sign. Verification
runs on the main process's thread, so a caller replaying a long chain should
split it across calls (each call resumes from the head the last one returned).

## Vectors

`docs/design/account-key-authority-vectors.json` is a verbatim copy of
`services/control-plane/internal/authoritycontract/testdata/vectors.json` in
Concord-Voice/Self-Hosted at commit `2ddd583` (`vectors_sha384`
`b9fe7a79…db43974f`). `tests/unit/main/authority/vectors.parity.test.ts`
pins that digest and checks every vector against this port. No automated check
compares the copy with upstream; protocol v1 is frozen, so it changes only when
the vectors are regenerated.

To re-vendor: copy the file from the Self-Hosted path above, set
`VECTORS_SHA384` in the parity test to the new header value, update the commit
here, and run the authority tests.

**Runtime:** the unit tests run on Node's Web Crypto, which is the
implementation the Electron main process uses. An earlier one-off run of the
36 Web Crypto vectors in headless Chromium 153 also passed. The first caller
PR adds an Electron main-process smoke test for these vectors.

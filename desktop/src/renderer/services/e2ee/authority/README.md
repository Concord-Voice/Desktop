# Account-key authority contract (renderer port)

A TypeScript port of the account-key authority contract, protocol v1. Section
numbers (§) in this module refer to the account-key authority design of record.

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
| `chain.ts`, `status.ts` | `verifyBundle`, `verifyChain`, `verifyStatus` | §2.12, §2.13 |

The codec and primitives port `scripts/authority-vectors/gen.mjs` §1–3 in
Concord-Voice/Self-Hosted; the verifier ports the Go reference in
`services/control-plane/internal/authoritycontract` there. The module is pure:
no I/O, no stores, no clock reads, no `Buffer`. Nothing imports it yet, so it
has no runtime effect.

Entry points: `encode`, `decode`, `capOf` and `LAYOUTS` (codec); `sha384`,
`importP384`, `verifyP384`, `verifyLegacyPSS`, `checkEkSpkiWebCrypto`,
`deviceId`, `parseDev`, `safetyNumber` and `tlsPin` (primitives); `newTrust`
and `Trust` (trust); `parseChainHead`, `chainHeadBytes` and `genesisHead`
(heads); `verifyBundle` and `verifyChain` (chain); `verifyStatus` (status);
`verdictOf` and `noticeOf` (reason).

**Rules for callers:**

- `decode` returns nested-message positions (for example `bundle.intent` and
  `signed.msg`) as unvalidated bytes. Decode each with its own tag before use.
- `decode(tag, bytes, limit)` can only lower the tag's cap, never raise it.
- `safetyNumber` returns `''` for an invalid input. Treat `''` as an error;
  never display it.
- Decoding `device-secrets` yields private keys as base64 strings, which cannot
  be wiped from memory. Keep their lifetime short.

- Build a `Trust` with `newTrust(anchors)`, then `addSigned` or `addTrust` for
  every trust object. A `Trust` is not safe for concurrent mutation: await each
  call before the next.
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

**Verified now:** the published chain. The parity test checks the port's Reason
and verdict against every `chain` (92), `bundle-verify` (145) and `pattern` (7)
vector. It also checks the persisted head for the 44 vectors that carry one. For
`for-op` (123) it checks the refusal code and its reason context, as the
reference harness does. For `p1` (2) it checks that the published status is
unchanged.

**Pending (later PRs):** the private device ledger, device rules and device
wraps. Their vector types (`device-ledger`, `device-wrap-open`,
`apply-device-op`, `normalize`) are checked at the codec layer only. Also
pending: R6's wrap target (`WrapKey`), verified-recipient handles, pin-store
persistence and the distribution gate.

**Not ported:** `Floor` and `DeriveAssurance`, which only the authority
evaluates (§2.8, §2.12). The authority-only columns of the §2.9 table are also
not ported.

**Cost:** each verified result re-encodes the whole chain-head once to check
that it stays within `HEAD_BLOB_MAX`, so first contact with a long chain is
quadratic in its length. The reference counts the bytes each step adds instead.
Bound the number of bundles fetched per call.

## Vectors

`docs/design/account-key-authority-vectors.json` is a verbatim copy of
`services/control-plane/internal/authoritycontract/testdata/vectors.json` in
Concord-Voice/Self-Hosted at commit `2ddd583` (`vectors_sha384`
`b9fe7a79…db43974f`). `tests/unit/services/e2ee/authority/vectors.parity.test.ts`
pins that digest and checks every vector against this port. No automated check
compares the copy with upstream; protocol v1 is frozen, so it changes only when
the vectors are regenerated.

To re-vendor: copy the file from the Self-Hosted path above, set
`VECTORS_SHA384` in the parity test to the new header value, update the commit
here, and run the authority tests.

**Chromium gate:** the unit tests run on Node's Web Crypto. The renderer uses
Chromium's. A one-off run of the 36 Web Crypto vectors (`ek-spki`, `pss-sig`,
`p384-point`, `p384-sig`, `tls-pin`, `device-id`, `safety-number`) in headless
Chromium 153 passed all 36 on 2026-11-06. The PR that adds the first caller
must add a Chromium test for these vectors to CI.

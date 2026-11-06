# Account-key authority contract (renderer port)

A TypeScript port of the account-key authority contract, protocol v1. Section
numbers (§) in this module refer to the account-key authority design of record.

| File | Ports | Design of record |
|---|---|---|
| `codec.ts` | EN1–EN6, every layout, caps, cross-position rules | §2.3, §2.5, §2.6, §2.12 heads, §2.22 |
| `primitives.ts` | digests, P-384 and legacy RSA-PSS verify, EK SPKI checks, DeviceID, safety number, frozen texts | §2.4, §2.19, §2.20 |
| `bytes.ts`, `errors.ts` | strict base64, byte helpers, the `malformed` refusal | §2.3 |

The reference is `scripts/authority-vectors/gen.mjs` §1–3 in
Concord-Voice/Self-Hosted. The module is pure: no I/O, no stores, no clock
reads, no `Buffer`. Nothing imports it yet, so it has no runtime effect.

Entry points: `encode`, `decode`, `capOf` and `LAYOUTS` (codec); `sha384`,
`importP384`, `verifyP384`, `verifyLegacyPSS`, `checkEkSpkiWebCrypto`,
`deviceId`, `parseDev`, `safetyNumber` and `tlsPin` (primitives).

**Rules for callers:**

- `decode` returns nested-message positions (for example `bundle.intent` and
  `signed.msg`) as unvalidated bytes. Decode each with its own tag before use.
- `decode(tag, bytes, limit)` can only lower the tag's cap, never raise it.
- `safetyNumber` returns `''` for an invalid input. Treat `''` as an error;
  never display it.
- Decoding `device-secrets` yields private keys as base64 strings, which cannot
  be wiped from memory. Keep their lifetime short.

**Not ported:** `Floor` and `DeriveAssurance`, which only the authority
evaluates (§2.8, §2.12). The §2.12 verifiers, verified-recipient handles and the
distribution gate come in later PRs.

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

# Account-key authority contract (renderer port)

A TypeScript port of the account-key authority contract, protocol v1
(epic Concord-Voice/Hosted#2553, child #2628). The design of record is
Concord-Voice/Hosted `docs/superpowers/specs/2026-10-07-2553-account-key-authority-design-of-record.md`.

| File | Ports | DoR |
|---|---|---|
| `codec.ts` | EN1–EN6, every layout, caps, cross-position rules | §2.3, §2.5, §2.6, §2.12 heads, §2.22 |
| `primitives.ts` | digests, P-384 and legacy RSA-PSS verify, EK SPKI checks, DeviceID, safety number, frozen texts | §2.4, §2.19, §2.20 |
| `bytes.ts`, `errors.ts` | strict base64, byte helpers, the `malformed` refusal | §2.3 |

The reference is Hosted `scripts/authority-vectors/gen.mjs` §1–3 (also public in
Concord-Voice/Self-Hosted). The module is pure: no I/O, no stores, no clock reads,
no `Buffer`. Nothing imports it yet, so it has no runtime effect.

**Not ported:** `Floor` and `DeriveAssurance`, which only the authority evaluates
(DoR §2.8, §2.12). The §2.12 verifiers, verified-recipient handles and the
distribution gate come in later #2628 PRs.

## Vectors

`docs/design/account-key-authority-vectors.json` is a verbatim copy of Hosted
`services/control-plane/internal/authoritycontract/testdata/vectors.json`.
`tests/unit/services/e2ee/authority/vectors.parity.test.ts` pins its
`vectors_sha384` and checks every vector against this port.

Protocol v1 is frozen, so the file changes only when Hosted regenerates it. To
re-vendor: copy the file, set `VECTORS_SHA384` in the parity test to the new
header value, and run the authority tests.

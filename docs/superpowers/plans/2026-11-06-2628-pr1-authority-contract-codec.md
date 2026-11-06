# #2628 PR 1: authority contract codec and primitives (TypeScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop renderer a typed, browser-safe port of the account-key authority contract's codec (EN1–EN6, every §2.5/§2.6/§2.12 layout) and §2.4 primitives, proven byte-for-byte against the committed Go/Node vectors.

**Architecture:** A pure module under `desktop/src/renderer/services/e2ee/authority/` with no I/O, no store access and no clock reads. It ports sections 1–3 of the Hosted second implementation (`scripts/authority-vectors/gen.mjs`), replacing every `Buffer` call with `Uint8Array` helpers so it runs in the sandboxed renderer. Nothing imports it yet, so it has no runtime effect. Later #2628 PRs build the §2.12 verifiers, handles and the distribution gate on top of it.

**Tech Stack:** TypeScript (ES2022, strict), Web Crypto (`globalThis.crypto.subtle`), BigInt, Vitest.

**Spec:** Concord-Voice/Hosted `docs/superpowers/specs/2026-10-07-2553-account-key-authority-design-of-record.md` §2.3–§2.6, §2.12 persisted heads, §2.19 DeviceID, §4 (#2628 row). Reference implementation: Concord-Voice/Hosted `scripts/authority-vectors/gen.mjs` §1–3 and `vectors.parity.test.ts` (both also public in Concord-Voice/Self-Hosted).

## Global Constraints

- Protocol v1 is frozen (Class F). The port changes no byte, cap, layout, enum order or error rule; vectors are the authority.
- No new dependency, no custom crypto primitive: Web Crypto for SHA-384/512, ECDSA P-384, RSA-PSS and RSA-OAEP SPKI import only.
- `Floor` and `DeriveAssurance` are authority-only and are not ported (§2.8, §2.12).
- No logging of keys, proofs or message bytes.
- Renderer-safe: no `Buffer`, no `node:*` imports in `src/`.
- Vectors are vendored verbatim from Hosted `services/control-plane/internal/authoritycontract/testdata/vectors.json`; their `vectors_sha384` is pinned in the test.

## Review Focus

1. A vector file edited after vendoring: the test recomputes `vectors_sha384` over the body and compares it to the pinned value.
2. A layout added to Go/Node but not to the port: every `layout-fields` vector must match `LAYOUTS` field names, and a vector type with no handler and no layout fails rather than passing as a refusal.
3. Non-canonical base64 (`=` padding variants, URL alphabet) must be refused, not normalised.
4. Hybrid (0x06/0x07) or off-curve P-384 points must be refused before `importKey`.
5. Integers above `Number.MAX_SAFE_INTEGER` or with leading zeros must be refused at decode.

---

### Task 1: Vendor the vectors and pin them

**Files:**
- Create: `docs/design/account-key-authority-vectors.json` (verbatim copy, Hosted @ `477ed4a`)
- Create: `desktop/tests/unit/services/e2ee/authority/vectors.integrity.test.ts`

- [ ] Test `vectors file is the pinned Hosted copy`: read the file as text, split at the first `\n`, assert the header matches `HEADER_LINE`, assert SHA-384(hex) of the body equals the header's `vectors_sha384`, and equals the pinned constant `VECTORS_SHA384` from Hosted.
- [ ] Run, expect PASS; commit `test: vendor the account-key authority vectors`.

### Task 2: Codec (EN1–EN6, layouts, caps)

**Files:**
- Create: `desktop/src/renderer/services/e2ee/authority/bytes.ts` — `b64e(b: Uint8Array): string`, `b64d(s: string): Uint8Array` (strict RFC 4648 §3.5 plus re-encode equality), `utf8`, `concat`, `equalBytes`, `toHex`.
- Create: `desktop/src/renderer/services/e2ee/authority/codec.ts` — `Malformed`, `PREFIX`, `LAYOUTS`, `CAPS`, `capOf(tag)`, `encode(tag, v): Uint8Array`, `decode(tag, bytes, limit?): Promise<Values>`, `parseU`, `isUUID`, `isUUIDv4`, `FACTORS`.
- Test: `desktop/tests/unit/services/e2ee/authority/codec.test.ts`

**Interfaces:** Produces `encode`/`decode` keyed by layout tag (string union `LayoutTag`), returning `Record<string, string | number | Uint8Array | (string | Uint8Array)[]>`.

- [ ] Tests: `b64d` refuses `"AA"`, `"AA="`, `"A-=="`; `parseU` refuses `"01"`, `"9007199254740992"`; a decoded `intent` vector re-encodes to identical bytes; a byte outside EN2 is `Malformed('EN2')`.
- [ ] Port gen.mjs §1–2 one-to-one (kind table, `STRCHK`, `CROSS`, `writeValue`, `readValue`). `decode` parses with `JSON.parse(latin1)` via `TextDecoder('latin1')` after the EN2 byte check.
- [ ] Run, expect PASS; commit `feat: port the authority contract codec to the desktop`.

### Task 3: §2.4 primitives and canonical texts

**Files:**
- Create: `desktop/src/renderer/services/e2ee/authority/primitives.ts` — `checkPoint`, `checkEkSpkiTemplate`, `checkEkSpkiWebCrypto`, `sha384`, `importP384`, `verifyP384`, `verifyLegacyPSS`, `deviceId`, `parseDev`, `safetyNumber`, `ageClaimV2Bytes`, `sessionBindBytes`, `credentialEpochDigest`, `populationDigest`, `tlsPin`.
- Test: covered by Task 4's parity run plus `primitives.test.ts` for the two pre-import refusals (0x06 prefix, off-curve point).

- [ ] Port gen.mjs §3 (without generator/drift helpers). The codec's `dev` check calls `parseDev`, so `codec.ts` imports it; keep the cycle out by putting `checkPoint`/`checkEkSpkiTemplate` (sync, no Web Crypto) in `primitives.ts` and `parseDev` there too.
- [ ] Run, expect PASS; commit `feat: port the authority contract primitives to the desktop`.

### Task 4: Vector parity

**Files:**
- Create: `desktop/tests/unit/services/e2ee/authority/vectors.parity.test.ts`

- [ ] Port Hosted `vectors.parity.test.ts`: the `PRIM` handlers, the codec layer of every A2 verification vector (`A2_TYPES`, `VERDICT` table copied as test data), and the layout handler that fails on an unknown type. Drop the generator-digest drift case (Task 1 covers integrity).
- [ ] Run `npx vitest run tests/unit/services/e2ee/authority`, expect all 1,046 vectors PASS.
- [ ] Commit `test: verify the desktop authority codec against the Go vectors`.

### Task 5: Docs and gates

- [ ] Add a short `desktop/src/renderer/services/e2ee/authority/README.md`: what is ported, what is not (`Floor`, `DeriveAssurance`), how to re-vendor vectors when Hosted regenerates them.
- [ ] `npm run lint`, `npm run typecheck`, the authority tests with coverage ≥ 80% on the new files.
- [ ] Commit `docs: describe the desktop authority contract port`.

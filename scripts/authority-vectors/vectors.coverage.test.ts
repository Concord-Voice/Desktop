// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as gen from './gen.mjs';

type Vec = { name: string; type: string; expect: { reason: string } };

// The DoR §3.1 codec vectors that A1 owns, by name.
const REQUIRED = [
  'neg/status/u-2^53', 'neg/status/u-1.0', 'neg/status/u-1e0', 'neg/status/bom', 'neg/status/space',
  'neg/status/escape', 'neg/status/non-ascii', 'neg/status/invalid-utf8',
  'neg/anchors/cap-plus-one', 'neg/signed/cap-plus-one', 'neg/device-set/cap-plus-one', 'neg/device-wrap/cap-plus-one',
  'neg/device-intent/cap-plus-one', 'neg/device-bundle/cap-plus-one', 'neg/device-history/cap-plus-one',
  'neg/recovery-bind/cap-plus-one', 'neg/relay-recover/cap-plus-one', 'neg/device-result/cap-plus-one',
  'neg/device-secrets/cap-plus-one',
  'neg/delegation/a-unsorted', 'neg/delegation/a-duplicate', 'neg/delegation/a-nested-array',
  'neg/query/base64-QR', 'neg/query/base64-trailing-bits', 'neg/query/base64-missing-padding', 'neg/query/base64-newline',
  'neg/anchors/point-compressed', 'neg/anchors/point-off-curve', 'neg/anchors/point-hybrid',
  'prim/p384-point/hybrid-06', 'prim/p384-point/hybrid-07', 'prim/p384-point/compressed', 'prim/p384-point/off-curve',
  'neg/bundle/sig-95', 'neg/bundle/sig-97', 'neg/bundle/sig-der', 'neg/bundle/pss-511',
  'prim/p384-sig/95', 'prim/p384-sig/97', 'prim/p384-sig/der', 'prim/pss-sig/511',
  'prim/p384-sig/high-s', 'prim/p384-sig/r-zero', 'prim/p384-sig/s-zero', 'prim/p384-sig/r-eq-n', 'prim/p384-sig/s-eq-n',
  'neg/ek-binding/spki-2048-bit', 'neg/ek-binding/spki-e-3', 'neg/ek-binding/spki-e-65539',
  'neg/ek-binding/spki-pss-oid', 'neg/ek-binding/spki-absent-null', 'neg/ek-binding/spki-trailing-bytes',
  'neg/intent/request-id-v1', 'neg/legacy-ek-pop/age-claim-text', 'neg/query/age-claim-text', 'neg/sig/session-bind-text',
  'neg/signed/type-not-msg2', 'neg/signed/delegation-sig-b-empty', 'neg/signed/succession-sig-b-empty',
  'neg/signed/status-sig-b-present', 'neg/signed/device-status-sig-b-present',
  'pos/delegation/max', 'pos/bundle/max', 'pos/recovery-bind/max', 'pos/relay-recover/max', 'pos/device-set/max',
  'pos/device-set/dev-319', 'neg/device-set/dev-320', 'neg/device-set/dev-id-mismatch',
  'neg/device-set/key-without-digest', 'neg/device-set/unbind-without-bound-key', 'neg/device-set/refresh-to-bound-key',
  'neg/device-set/pending-in-active', 'neg/device-set/duplicate-id',
  'pos/device-set/bound-no-slot', 'neg/device-set/pending-same-id-other-maturity',
  'neg/device-set/pending-same-id-other-dkx',
  'pos/cp-evidence/all-14-factors', 'neg/cp-evidence/backup-email-recovery', 'neg/cp-evidence/duplicate-factor',
  'pos/recovery-bind/bind', 'pos/recovery-bind/cancel', 'pos/recovery-bind/unbind',
  'neg/recovery-bind/escrow-equals-recovery-key', 'neg/recovery-bind/escrow-off-curve',
  'pos/relay-recover/form-r', 'pos/relay-recover/form-c', 'pos/relay-recover/form-b', 'neg/relay-recover/c-plus-ek-binding',
  'pos/query-resp/failure-form',
  'pos/chain-head/genesis', 'pos/device-head/genesis-monitor', 'pos/device-head/genesis-own',
  'pos/chain-head/records-at-caps', 'pos/device-head/records-at-caps', 'neg/chain-head/seq-record-over',
  'neg/chain-head/root-record-over', 'neg/chain-head/recover-record-over', 'neg/device-head/admitted-record-over',
  'neg/device-head/secrets-record-over', 'neg/device-head/chain-head-digest-mismatch',
  'prim/device-id/a', 'prim/safety-number/a', 'prim/age-claim-v2/valid', 'prim/session-bind-v1/valid',
  'prim/credential-epoch-digest/null', 'prim/credential-epoch-digest/empty', 'prim/credential-epoch-digest/value',
  'prim/population-digest/three', 'prim/tls-pin/a', 'prim/ek-spki/valid',
  'prim/ek-spki/bitstring-unused-bits', 'prim/ek-spki/modulus-4097',
];

describe('vectors.json coverage (DoR §3.1, AC7)', () => {
  it('exists and was written by this gen.mjs', async () => {
    expect(existsSync(gen.VECTORS_PATH)).toBe(true);
    const text = readFileSync(gen.VECTORS_PATH, 'utf8');
    const file = JSON.parse(text);
    expect(file.generator_sha384).toBe(await gen.generatorDigest());
    expect(text.slice(0, text.indexOf('\n'))).toMatch(gen.HEADER_LINE);
    expect(file.vectors_sha384).toBe(await gen.vectorsDigest(text.slice(text.indexOf('\n') + 1)));
  });

  it('has unique names, every required vector, and both polarities for every layout', () => {
    const vectors: Vec[] = JSON.parse(readFileSync(gen.VECTORS_PATH, 'utf8')).vectors;
    const names = new Set(vectors.map((v) => v.name));
    expect(names.size).toBe(vectors.length);
    for (const n of REQUIRED) expect(names.has(n), n).toBe(true);
    for (const tag of Object.keys(gen.LAYOUTS)) {
      expect(vectors.some((v) => v.type === tag && v.expect.reason === 'ok'), `${tag} positive`).toBe(true);
      expect(vectors.some((v) => v.type === tag && v.expect.reason === 'malformed'), `${tag} negative`).toBe(true);
    }
  });

  it('pins the ordered position names of every layout, once each', () => {
    const vectors: Vec[] = JSON.parse(readFileSync(gen.VECTORS_PATH, 'utf8')).vectors;
    const fieldVectors = vectors.filter((v) => v.type === 'layout-fields');
    for (const tag of Object.keys(gen.LAYOUTS)) {
      expect(fieldVectors.filter((v) => v.name === `prim/layout-fields/${tag}`), `${tag} layout-fields`).toHaveLength(1);
    }
    expect(fieldVectors).toHaveLength(Object.keys(gen.LAYOUTS).length);
  });
});

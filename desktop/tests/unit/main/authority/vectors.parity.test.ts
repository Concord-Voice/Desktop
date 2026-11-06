// @vitest-environment node
// Design of record §3.1 cross-language check, desktop side: every committed vector
// verifies under the TypeScript port. A port of Concord-Voice/Self-Hosted
// scripts/authority-vectors/vectors.parity.test.ts; the vectors are vendored at
// docs/design/account-key-authority-vectors.json and pinned below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { b64d, b64e, equalBytes, toHex } from '@/main/authority/bytes';
import { decode, encode, LAYOUTS, Malformed, type Values } from '@/main/authority/codec';
import * as prim from '@/main/authority/primitives';
import { verifyBundle, verifyChain } from '@/main/authority/chain';
import { chainHeadBytes, parseChainHead } from '@/main/authority/heads';
import { decodeAs } from '@/main/authority/messages';
import { checkRelayRecover, recoveryBindForKind } from '@/main/authority/patterns';
import { intentForOp } from '@/main/authority/post';
import { REASONS, verdictOf } from '@/main/authority/reason';
import type { AccountMemory, Use } from '@/main/authority/status';
import { newTrust, type HighWater, type Trust } from '@/main/authority/trust';

// Concord-Voice/Self-Hosted services/control-plane/internal/authoritycontract/testdata/vectors.json
// @ 2ddd583. Re-vendor (and update this pin) only when the vectors are regenerated.
const VECTORS_SHA384 =
  'b9fe7a790486e1266fc54658209716340a404ee1a02cb363259804d41f484863b06c1d350754036a32370c55db43974f';
const HEADER_LINE =
  /^\{"generator_sha384":"[0-9a-f]{96}","vectors_sha384":"[0-9a-f]{96}","vectors":\[$/;
const VECTORS_PATH = resolve(
  __dirname,
  '../../../../../docs/design/account-key-authority-vectors.json'
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vector inputs are heterogeneous JSON fixtures
type Json = Record<string, any>;
type Vec = { name: string; type: string; bytes_b64?: string; input?: Json; expect: Json } & Json;

const text = readFileSync(VECTORS_PATH, 'utf8');
const file = JSON.parse(text);
const vectors: Vec[] = file.vectors;
const ok = (v: Vec): boolean => v.expect.reason === 'ok';

// Design of record §2.12 Reason → Verdict (the generator's copy; the verifier PR owns the real table).
const VERDICT: Record<string, string> = Object.fromEntries([
  ...['ok', 'ok_accepted_pin'].map((r) => [r, 'ok']),
  ...[
    'network',
    'status_stale_tau',
    'superseded_uncovered',
    'status_expired',
    'chain_behind',
    'delegation_unknown',
    'device_behind',
    'device_status_stale',
  ].map((r) => [r, 'transient']),
  ...[
    'suspended',
    'disputed',
    'held',
    'erased',
    'pending_erase',
    'root_revoked',
    'pending_from_active',
    'pending_from_suspended',
    'pending_from_absent',
    'pin_revoked',
    'fork',
    'hypothesis_conflict',
    'field_mismatch',
    'anb_mismatch',
    'issued_bounds',
    'pin_changed',
    'malformed',
    'bad_signature',
    'cak_unlisted',
    'transition_invalid',
    'chain_gap',
    'head_mismatch',
    'status_future',
    'absent_unpinned',
    'absent_after_cutover',
    'absent_after_enrolled',
    'delegation_window',
    'out_of_scope',
    'status_superseded',
    'realm_mismatch',
    'device_status_mismatch',
    'device_gap',
    'device_fork',
    'device_rule',
    'wrap_invalid',
  ].map((r) => [r, 'withhold']),
  ['trust_halt', 'halt'],
  ['sender_side', 'refuse-op'],
]);
const A2_TYPES = [
  'chain',
  'bundle-verify',
  'device-ledger',
  'device-wrap-open',
  'apply-device-op',
  'normalize',
  'pattern',
  'for-op',
  'p1',
];

async function settles(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch (e) {
    if (!(e instanceof Malformed)) throw e;
    return false;
  }
}

const PRIM: Record<string, (v: Vec) => Promise<void>> = {
  'p384-point': async (v) =>
    expect(await settles(prim.importP384(b64d(v.input!.point_b64)))).toBe(ok(v)),
  'p384-sig': async (v) =>
    expect(
      await prim.verifyP384(
        b64d(v.input!.point_b64),
        b64d(v.input!.msg_b64),
        b64d(v.input!.sig_b64)
      )
    ).toBe(ok(v)),
  'pss-sig': async (v) =>
    expect(
      await prim.verifyLegacyPSS(
        b64d(v.input!.spki_b64),
        b64d(v.input!.msg_b64),
        b64d(v.input!.sig_b64)
      )
    ).toBe(ok(v)),
  'ek-spki': async (v) => {
    expect(await settles(prim.checkEkSpkiWebCrypto(b64d(v.input!.spki_b64)))).toBe(ok(v));
    expect(await settles((async () => prim.checkEkSpkiTemplate(b64d(v.input!.spki_b64)))())).toBe(
      ok(v)
    );
  },
  'device-id': async (v) =>
    expect(await prim.deviceId(b64d(v.input!.dsk_b64))).toBe(v.expect.device_id),
  'safety-number': async (v) =>
    expect(await prim.safetyNumber(v.input!.account_id, b64d(v.input!.pin_digest_b64))).toBe(
      v.expect.safety_number
    ),
  'age-claim-v2': async (v) => {
    const t = prim.ageClaimV2Bytes(v.input as prim.AgeClaimV2);
    expect(t ? b64e(t) : null).toBe(ok(v) ? v.expect.text_b64 : null);
  },
  'session-bind-v1': async (v) => {
    const t = prim.sessionBindBytes(v.input as prim.SessionBind);
    expect(t ? b64e(t) : null).toBe(ok(v) ? v.expect.text_b64 : null);
  },
  'credential-epoch-digest': async (v) => {
    const d = await prim.credentialEpochDigest(v.input!.epoch_valid ? v.input!.epoch : null);
    expect(d ? b64e(d) : '').toBe(v.expect.digest_b64);
  },
  'population-digest': async (v) => {
    const recs = v.input!.records.map((r: Json) => ({
      account_id: r.account_id,
      legacy_ek_digest: b64d(r.legacy_ek_digest_b64),
    }));
    if (!ok(v)) return expect(await settles(prim.populationDigest(recs))).toBe(false);
    expect(b64e(await prim.populationDigest(recs))).toBe(v.expect.digest_b64);
  },
  'tls-pin': async (v) =>
    expect(b64e(await prim.tlsPin(b64d(v.input!.point_b64)))).toBe(v.expect.digest_b64),
  'layout-fields': async (v) => {
    const fields = LAYOUTS[v.input!.layout as string];
    expect(fields, `unknown layout ${v.input!.layout}`).toBeDefined();
    expect(fields.map(([name]) => name)).toEqual(v.input!.fields);
  },
  'device-head': async (v) => {
    const dh = b64d(v.bytes_b64!);
    const ch = b64d(v.input!.chain_head_b64);
    // The pairing check is only about the digest: a negative must not pass
    // because the chain-head it travels with is itself broken.
    expect(await settles(decode('chain-head', ch)), 'the paired chain-head decodes').toBe(true);
    let head: Values | undefined;
    let paired = false;
    try {
      head = await decode('device-head', dh);
      paired = equalBytes(head.chain_head_digest as Uint8Array, await prim.sha384(ch));
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
    }
    expect(paired).toBe(ok(v));
    if (ok(v)) expect(b64e(encode('device-head', head!))).toBe(v.expect.reencoded_b64);
  },
};

// The codec layer of every verification vector. Reasons are the verifier's to
// check (a later verifier PR), not this file's.
async function decodes(tag: string, s?: string): Promise<Values | null> {
  if (!s) return null;
  const bytes = b64d(s);
  const values = await decode(tag, bytes);
  expect(equalBytes(encode(tag, values), bytes), `${tag} re-encodes`).toBe(true);
  return values;
}

async function bundleParts(s: string): Promise<void> {
  const v = (await decodes('bundle', s))!;
  for (const [n, t] of [
    ['intent', 'intent'],
    ['result', 'result'],
    ['cp_authz', 'cp-authz'],
    ['ek_binding', 'ek-binding'],
    ['recovery_bind', 'recovery-bind'],
    ['held_status', 'signed'],
  ] as const) {
    const part = v[n] as Uint8Array;
    if (part.length) await decodes(t, b64e(part));
  }
}

async function deviceBundleParts(s: string): Promise<void> {
  const v = (await decodes('device-bundle', s))!;
  for (const [n, t] of [
    ['device_intent', 'device-intent'],
    ['recovery_bind', 'recovery-bind'],
    ['cp_authz', 'cp-authz'],
    ['device_result', 'device-result'],
  ] as const) {
    const part = v[n] as Uint8Array;
    if (part.length) await decodes(t, b64e(part));
  }
}

const A2_HANDLERS: Record<string, (v: Vec) => Promise<void>> = {};

const PRIMARY_TAG: Record<string, string> = {
  chain: 'signed',
  'device-ledger': 'signed',
  'device-wrap-open': 'device-wrap',
  'apply-device-op': 'device-set',
  normalize: 'device-set',
};
// The committed p1 vectors use only mode `status`; another mode fails as an unknown layout.
const P1_TAG: Record<string, string> = { status: 'signed' };

async function verificationVector(v: Vec): Promise<void> {
  expect(VERDICT[v.expect.reason], `reason ${v.expect.reason}`).toBeDefined();
  expect(v.expect.verdict).toBe(VERDICT[v.expect.reason]);
  await decodes('chain-head', v.expect.head_b64);
  await decodes('device-set', v.expect.set_b64);
  if (v.expect.device_head_b64) await decodes('device-head', v.expect.device_head_b64);
  if (v.expect.reason === 'malformed') return;
  await decodes('anchors', v.anchors);
  for (const s of v.trust ?? []) await decodes('signed', s);
  await decodes('chain-head', v.prev_head);
  for (const s of v.bundles ?? []) await bundleParts(s);
  await decodes('signed', v.fix);
  for (const s of v.device_bundles ?? []) await deviceBundleParts(s);
  await decodes('signed', v.device_status);
  if (v.prev_device_head) {
    const dh = (await decodes('device-head', v.prev_device_head))!;
    expect(
      equalBytes(dh.chain_head_digest as Uint8Array, await prim.sha384(b64d(v.prev_head)))
    ).toBe(true);
  }
  if (v.input?.bind_b64) await decodes('recovery-bind', v.input.bind_b64);
  if (v.input?.new_dev) await prim.parseDev(v.input.new_dev);
  const okish = v.expect.reason === 'ok' || v.expect.reason === 'ok_accepted_pin';
  if (!v.bytes_b64 || (!okish && ['device-wrap-open', 'pattern', 'for-op'].includes(v.type)))
    return;
  if (v.type === 'bundle-verify') return bundleParts(v.bytes_b64);
  if (v.type === 'p1') {
    await decodes(P1_TAG[v.input!.mode], v.bytes_b64);
    await decodes(P1_TAG[v.input!.mode], v.input!.other_b64);
    return;
  }
  await decodes(PRIMARY_TAG[v.type] ?? v.input!.tag, v.bytes_b64);
}

for (const t of A2_TYPES) PRIM[t] = A2_HANDLERS[t] = verificationVector;

// ── Verdict parity (§2.12): the port's Reason for every published-chain vector ──
// The private device ledger (device-ledger, device-wrap-open, apply-device-op,
// normalize) comes in a later PR; those types stay codec-only above.

const exercised: Record<string, number> = {};
const count = (v: Vec): void => {
  exercised[v.type] = (exercised[v.type] ?? 0) + 1;
};

const b64OrEmpty = (s?: string): Uint8Array => (s ? b64d(s) : new Uint8Array(0));
const hwOf = (h: Json): HighWater => ({ gen: h.gen, serial: h.serial, minValid: h.min_valid });
function memOf(m: Json): AccountMemory {
  expect([0, 1]).toContain(m.everEnrolled); // u01: any other value is a broken vector
  return {
    pin: b64OrEmpty(m.pin),
    everEnrolled: m.everEnrolled === 1,
    acceptedPin: b64OrEmpty(m.acceptedPin),
  };
}

// NewTrust over `anchors` (a T1 failure is malformed), then every `trust`
// item in order, admitting each even after a halt (T4 is a property of the set).
async function trustOf(v: Vec): Promise<Trust | null> {
  const t = await newTrust(b64d(v.anchors));
  for (const s of v.trust ?? []) await t?.addSigned(b64d(s));
  return t;
}

async function prevHeadOf(v: Vec) {
  const h = await parseChainHead(b64d(v.prev_head));
  expect(h, 'prev_head parses').not.toBeNull();
  return h as NonNullable<typeof h>;
}

function expectReason(v: Vec, reason: string): void {
  expect(reason).toBe(v.expect.reason);
  expect(verdictOf(reason)).toBe(v.expect.verdict);
}

function expectHead(v: Vec, head: Parameters<typeof chainHeadBytes>[0]): void {
  if (!v.expect.head_b64) return;
  const b = chainHeadBytes(head);
  expect(b && b64e(b), 'the persisted head (D-269)').toBe(v.expect.head_b64);
}

const VERDICT_CHECKS: Record<string, (v: Vec) => Promise<void>> = {
  chain: async (v) => {
    const t = await trustOf(v);
    if (!t) return expectReason(v, 'malformed');
    expect(['new-secret', 'history']).toContain(v.use);
    const out = await verifyChain(
      t,
      hwOf(v.hw),
      await prevHeadOf(v),
      { bundles: (v.bundles as string[]).map(b64d), status: b64d(v.bytes_b64!) },
      memOf(v.mem),
      v.now_ms,
      v.use as Use
    );
    expectReason(v, out.reason);
    expect(out.status.reason).toBe(out.reason);
    expectHead(v, out.head);
  },
  'bundle-verify': async (v) => {
    const t = await trustOf(v);
    expect(t, 'bundle-verify anchors are valid').not.toBeNull();
    const fix = v.fix ? b64d(v.fix) : undefined;
    const out = await verifyBundle(
      t as Trust,
      hwOf(v.hw),
      await prevHeadOf(v),
      b64d(v.bytes_b64!),
      fix
    );
    expectReason(v, out.reason);
    expectHead(v, out.head);
  },
  'for-op': async (v) => {
    const b = b64d(v.bytes_b64!);
    let refusal: string;
    let contexts: string[];
    if (v.input!.tag === 'intent') {
      const x = await decodeAs('intent', b);
      expect(x).not.toBeNull();
      refusal = intentForOp(x!, v.input!.actor, v.input!.pop, v.input!.root_cancels);
      contexts = ['transition_invalid'];
    } else {
      expect(v.input!.tag).toBe('recovery-bind');
      const x = await decodeAs('recovery-bind', b);
      expect(x).not.toBeNull();
      refusal = recoveryBindForKind(x!);
      contexts = ['device_rule', 'malformed'];
    }
    // As the reference harness checks it: the refusal code, and a reason the
    // refusal's context allows (an admitted call is ok).
    expect(refusal).toBe(v.expect.refusal);
    if (refusal === '') expect(v.expect.reason).toBe('ok');
    else expect(contexts).toContain(v.expect.reason);
    expect(verdictOf(v.expect.reason)).toBe(v.expect.verdict);
  },
  pattern: async (v) => {
    expect(v.input!.tag).toBe('relay-recover');
    expectReason(v, await checkRelayRecover(b64d(v.bytes_b64!)));
  },
  p1: async (v) => {
    expect(v.input!.mode).toBe('status');
    const msgOf = async (s: string): Promise<Uint8Array> => {
      const sg = await decodeAs('signed', b64d(s));
      expect(sg?.type).toBe('status');
      return sg!.msg;
    };
    const after = await msgOf(v.bytes_b64!);
    const before = await msgOf(v.input!.other_b64);
    expect(equalBytes(before, after), 'a private op moved the published status').toBe(true);
    expect(b64e(after)).toBe(v.expect.reencoded_b64);
    expectReason(v, 'ok');
  },
};

for (const [t, check] of Object.entries(VERDICT_CHECKS)) {
  PRIM[t] = async (v) => {
    if (Object.hasOwn(A2_HANDLERS, t)) await A2_HANDLERS[t](v);
    await check(v);
    count(v);
  };
}

// A vector type with no PRIM handler is a layout vector. An unregistered type
// must fail here: decode() refuses an unknown layout as Malformed, which a
// non-ok vector would otherwise read as a pass for the wrong reason.
async function layout(v: Vec): Promise<void> {
  expect(Object.hasOwn(LAYOUTS, v.type), `${v.type}: no PRIM handler and no layout`).toBe(true);
  const bytes = b64d(v.bytes_b64!);
  if (!ok(v)) return expect(await settles(decode(v.type, bytes))).toBe(false);
  const values = await decode(v.type, bytes);
  expect(b64e(encode(v.type, values))).toBe(v.expect.reencoded_b64);
}

describe('authority vectors', () => {
  it('are the pinned, unedited upstream copy', async () => {
    const newline = text.indexOf('\n');
    expect(HEADER_LINE.test(text.slice(0, newline))).toBe(true);
    const body = new TextEncoder().encode(text.slice(newline + 1));
    const digest = toHex(await prim.sha384(body));
    expect(digest).toBe(file.vectors_sha384);
    expect(digest).toBe(VECTORS_SHA384);
  });

  it('cover every layout the port declares', () => {
    const declared = new Set(
      vectors.filter((v) => v.type === 'layout-fields').map((v) => v.input!.layout)
    );
    expect([...declared].sort()).toEqual(Object.keys(LAYOUTS).sort());
  });
});

describe('authority vectors verify under the TypeScript port', () => {
  for (const v of vectors) {
    it(
      v.name,
      async () => {
        expect.hasAssertions();
        // Own keys only: PRIM[v.type] alone would resolve 'toString' or 'constructor'.
        await (Object.hasOwn(PRIM, v.type) ? PRIM[v.type] : layout)(v);
      },
      30_000
    );
  }
});

describe('verdict parity coverage', () => {
  it('exercised every verdict-checked vector type, every vector of it', () => {
    for (const t of Object.keys(VERDICT_CHECKS)) {
      const n = vectors.filter((v) => v.type === t).length;
      expect(n, `${t} has vectors`).toBeGreaterThan(0);
      expect(exercised[t] ?? 0, `${t} verdict-checked`).toBe(n);
    }
  });

  it('keeps the Reason table of the contract', () => {
    expect(Object.keys(REASONS).sort()).toEqual(Object.keys(VERDICT).sort());
    for (const [r, verdict] of Object.entries(VERDICT)) expect(verdictOf(r), r).toBe(verdict);
    expect(verdictOf('no-such-reason')).toBe('withhold');
  });
});

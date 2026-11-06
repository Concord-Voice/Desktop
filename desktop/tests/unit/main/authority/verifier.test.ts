// @vitest-environment node
// Error paths of the published-chain verifier that the committed vectors do not
// reach. The vectors decide every verdict (vectors.parity.test.ts); these tests
// pin the fail-closed edges: unset clocks, hand-built heads, inputs that throw.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { b64d, utf8 } from '@/main/authority/bytes';
import { capAt, knownSegment, segmentRule } from '@/main/authority/assurance';
import { verifyBundle, verifyChain } from '@/main/authority/chain';
import { encode } from '@/main/authority/codec';
import { addMs, sumBelow } from '@/main/authority/constants';
import {
  canonicalHead,
  chainHeadBytes,
  genesisHead,
  insertSorted,
  parseChainHead,
  rootByDigest,
  type ChainHead,
} from '@/main/authority/heads';
import { formHypothesis } from '@/main/authority/headmove';
import { decodeAs, encodeAs, sigMsg } from '@/main/authority/messages';
import {
  checkRelayRecover,
  recoveryBindForKind,
} from '@/main/authority/patterns';
import { intentForOp } from '@/main/authority/post';
import { activate, classify, genesisPub } from '@/main/authority/pub';
import { noticeOf, verdictOf } from '@/main/authority/reason';
import { fixAllows, fixStatus, pickMatch } from '@/main/authority/replay';
import { verifyStatus, type AccountMemory } from '@/main/authority/status';
import { rowByN, rowsFor } from '@/main/authority/table';
import {
  checkTrustEnvelope,
  maxHW,
  newTrust,
  ZERO_HW,
  type Trust,
} from '@/main/authority/trust';

type Json = Record<string, unknown>;
interface Vec extends Json {
  name: string;
  type: string;
  anchors: string;
  trust: string[];
  prev_head: string;
  bundles?: string[];
  bytes_b64: string;
  now_ms: number;
  expect: { reason: string; head_b64?: string };
}

const VECTORS: Vec[] = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../docs/design/account-key-authority-vectors.json'),
    'utf8'
  )
).vectors;
const byName = (n: string): Vec => {
  const v = VECTORS.find((x) => x.name === n);
  if (!v) throw new Error(`no vector ${n}`);
  return v;
};

const NO_MEM: AccountMemory = {
  pin: new Uint8Array(0),
  everEnrolled: false,
  acceptedPin: new Uint8Array(0),
};
const BAD = utf8('not a message');

async function trustOf(v: Vec, items = v.trust): Promise<Trust> {
  const t = await newTrust(b64d(v.anchors));
  if (!t) throw new Error('anchors');
  for (const s of items) await t.addSigned(b64d(s));
  return t;
}

async function headOf(s: string): Promise<ChainHead> {
  const h = await parseChainHead(b64d(s));
  if (!h) throw new Error('head');
  return h;
}

/** An ok chain vector with bundles and a persisted head. */
const OK_CHAIN = byName('head/after-rotations');
/** An ok bundle-verify vector with one delegation. */
const OK_BUNDLE = byName('row/01/enroll-new');

async function signedTypeOf(s: string): Promise<string | undefined> {
  return (await decodeAs('signed', b64d(s)))?.type;
}

describe('trust (T1–T5)', () => {
  it('refuses anchors that do not decode', async () => {
    expect(await newTrust(BAD)).toBeNull();
  });

  it('admits, ignores and refuses trust objects', async () => {
    const t = await trustOf(OK_BUNDLE, []);
    expect(t.halted()).toMatch(/no valid delegation/); // T4: nothing for current_gen yet
    expect(t.haltReason()).toBe('trust_halt');
    const del = b64d(OK_BUNDLE.trust[0]);
    expect(await t.addSigned(BAD)).toBe('malformed');
    expect(await t.addSigned(del)).toBe('admitted');
    expect(await t.addSigned(del)).toBe('ignored'); // D-222: msg already accepted
    expect(t.halted()).toBeNull();
    expect(t.currentGen()).toBe(0);
    expect(t.sortedKeys()).toHaveLength(1);
    const [gen, serial] = t.sortedKeys()[0];
    expect(t.lookup(gen, serial)?.serial).toBe(serial);
    expect(t.lookup(gen, serial + 1)).toBeNull();
    expect(t.highWater().serial).toBe(serial);
  });

  it('refuses a status where a trust object belongs', async () => {
    const t = await trustOf(OK_BUNDLE, []);
    expect(await t.addSigned(b64d(OK_CHAIN.bytes_b64))).toBe('malformed');
  });

  it('reports a halt that admission reaches (T4)', async () => {
    const v = byName('trust/t4/succession-pair/ab');
    const t = await trustOf(v, []);
    const outcomes = [];
    for (const s of v.trust) outcomes.push(await t.addSigned(b64d(s)));
    expect(outcomes).toContain('halt');
    expect(t.halted()).toMatch(/T4/);
    expect(t.haltReason()).toBe('trust_halt');
  });

  it('checks the trust envelope order (§2.6) before admitting it', async () => {
    const v = byName('trust/t4/succession-pair/ab');
    const types = await Promise.all(v.trust.map(signedTypeOf));
    const del = v.trust[types.indexOf('delegation')];
    const succ = v.trust[types.indexOf('succession')];
    const env = (items: string[]): Uint8Array => encode('trust', { items: items.map(b64d) });

    expect(await checkTrustEnvelope(env([succ, del]))).not.toBeNull();
    expect(await checkTrustEnvelope(env([del, succ]))).toBeNull(); // a succession after a delegation
    expect(await checkTrustEnvelope(env([succ, succ]))).toBeNull(); // not strictly ascending
    expect(await checkTrustEnvelope(env([del, del]))).toBeNull();
    expect(await checkTrustEnvelope(env([OK_CHAIN.bytes_b64]))).toBeNull(); // a status
    expect(await checkTrustEnvelope(BAD)).toBeNull();

    const t = await trustOf(v, []);
    expect(await t.addTrust(BAD)).toBe('malformed');
    expect(await t.addTrust(env([succ, del]))).toBe('admitted');
  });

  it('keeps the high-water mark from decreasing (T5)', () => {
    const a = { gen: 1, serial: 2, minValid: 1 };
    expect(maxHW(a, ZERO_HW)).toBe(a);
    expect(maxHW(ZERO_HW, a)).toBe(a);
    expect(maxHW(a, { ...a, minValid: 2 }).minValid).toBe(2);
    expect(maxHW({ ...a, minValid: 2 }, a).minValid).toBe(2);
  });
});

describe('verifyChain and verifyBundle fail closed', () => {
  it('refuses an unset or invalid clock as malformed (Sec-N4)', async () => {
    const t = await trustOf(OK_CHAIN);
    const from = await headOf(OK_CHAIN.prev_head);
    const input = { bundles: [], status: b64d(OK_CHAIN.bytes_b64) };
    for (const now of [0, -1, Number.NaN, 1.5, 2 ** 53]) {
      const out = await verifyChain(t, ZERO_HW, from, input, NO_MEM, now, 'new-secret');
      expect(out.reason, String(now)).toBe('malformed');
      expect(out.head).toBe(from);
    }
  });

  it('refuses everything under a halted trust', async () => {
    const t = await trustOf(OK_CHAIN, []);
    const from = await headOf(OK_CHAIN.prev_head);
    const input = { bundles: [], status: b64d(OK_CHAIN.bytes_b64) };
    expect((await verifyChain(t, ZERO_HW, from, input, NO_MEM, 1, 'new-secret')).reason).toBe(
      'trust_halt'
    );
    expect((await verifyBundle(t, ZERO_HW, from, BAD)).reason).toBe('trust_halt');
  });

  it('refuses a head that is not canonical before reading a record', async () => {
    const t = await trustOf(OK_CHAIN);
    const from = await headOf(OK_CHAIN.prev_head);
    const forged: ChainHead = { ...from, root_index: ['b', 'a'] };
    expect(canonicalHead(forged)).toBe(false);
    const input = {
      bundles: (OK_CHAIN.bundles ?? []).map(b64d),
      status: b64d(OK_CHAIN.bytes_b64),
    };
    const out = await verifyChain(t, ZERO_HW, forged, input, NO_MEM, OK_CHAIN.now_ms, 'new-secret');
    expect(out.reason).toBe('malformed');
    expect(out.head).toBe(forged);
    expect((await verifyBundle(t, ZERO_HW, forged, BAD)).reason).toBe('malformed');
  });

  it('refuses a status or bundle that does not decode', async () => {
    const t = await trustOf(OK_CHAIN);
    const from = await headOf(OK_CHAIN.prev_head);
    const out = await verifyChain(
      t,
      ZERO_HW,
      from,
      { bundles: [], status: BAD },
      NO_MEM,
      1,
      'history'
    );
    expect(out.reason).toBe('malformed');
    expect(out.status.status).toBeNull();
    expect((await verifyBundle(t, ZERO_HW, from, BAD)).reason).toBe('malformed');
    expect((await verifyBundle(t, ZERO_HW, from, BAD, BAD)).reason).toBe('malformed');
  });

  it('returns malformed rather than throwing on a value that is not a head', async () => {
    const t = await trustOf(OK_CHAIN);
    const notAHead = {} as ChainHead;
    const status = b64d(OK_CHAIN.bytes_b64);
    const out = await verifyChain(
      t,
      ZERO_HW,
      notAHead,
      { bundles: [BAD], status },
      NO_MEM,
      OK_CHAIN.now_ms,
      'new-secret'
    );
    expect(out.reason).toBe('malformed');
    const fix = b64d(OK_CHAIN.bytes_b64);
    expect((await verifyBundle(t, ZERO_HW, notAHead, BAD, fix)).reason).toBe('malformed');
  });

  it('verifies a status against the head the chain reached', async () => {
    const t = await trustOf(OK_CHAIN);
    const from = await headOf(OK_CHAIN.prev_head);
    const status = b64d(OK_CHAIN.bytes_b64);
    const bundles = (OK_CHAIN.bundles ?? []).map(b64d);
    const out = await verifyChain(
      t,
      ZERO_HW,
      from,
      { bundles, status },
      NO_MEM,
      OK_CHAIN.now_ms,
      'new-secret'
    );
    expect(out.reason).toBe('ok');
    const [vs] = await verifyStatus(
      t,
      ZERO_HW,
      out.head,
      status,
      NO_MEM,
      OK_CHAIN.now_ms,
      'new-secret'
    );
    expect(vs.reason).toBe('ok');
    expect(vs.status?.seq).toBe(bundles.length + (await headSeq(from)));
    // the status names the verified head, not the one before it
    expect(
      (await verifyStatus(t, ZERO_HW, from, status, NO_MEM, OK_CHAIN.now_ms, 'new-secret'))[0]
        .reason
    ).toBe('chain_behind');
    // a Use outside the two modes, and an unset clock
    const bogus = 'bogus' as unknown as 'history';
    expect(
      (await verifyStatus(t, ZERO_HW, out.head, status, NO_MEM, OK_CHAIN.now_ms, bogus))[0].reason
    ).toBe('malformed');
    expect((await verifyStatus(t, ZERO_HW, out.head, status, NO_MEM, 0, 'history'))[0].reason).toBe(
      'malformed'
    );
    const partial = { realm_id: from.realm_id, account_id: from.account_id } as ChainHead;
    expect((await verifyStatus(t, ZERO_HW, partial, status, NO_MEM, 1, 'history'))[0].reason).toBe(
      'malformed'
    );
  });
});

async function headSeq(h: ChainHead): Promise<number> {
  return h.seq_index.length;
}

describe('replay and row helpers', () => {
  it('R3: exactly one of two hypotheses, else hypothesis_conflict', () => {
    expect(pickMatch(['ok', 'ok'])).toEqual([-1, 'hypothesis_conflict']);
    expect(pickMatch(['transition_invalid', 'bad_signature'])).toEqual([-1, 'hypothesis_conflict']);
    expect(pickMatch(['transition_invalid', 'ok'])).toEqual([1, 'ok']);
    expect(pickMatch(['chain_gap'])).toEqual([-1, 'chain_gap']);
  });

  it('R4 constrains nothing without a fix naming a raw pending head', async () => {
    expect(fixAllows(null, genesisPub(), 5, true)).toBe(true);
    expect(await fixStatus(new Uint8Array(0))).toBeNull();
    expect(await fixStatus(BAD)).toBe('malformed');
  });

  it('H_act without a previous result is a bad move', async () => {
    const h = genesisHead(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    );
    const moved = await formHypothesis(h, null, { p: genesisPub(), act: true });
    expect(moved.bad).toBe(true);
  });

  it('classifies and activates only what the table defines', () => {
    expect(classify({ ...genesisPub(), state: 'no-such-state' })).toBe('E');
    const g = genesisPub();
    expect(activate(g)).toBe(g);
  });

  it('refuses an op §2.7 does not list', async () => {
    const v = VECTORS.find((x) => x.type === 'for-op' && (x.input as Json).tag === 'intent');
    const inp = await decodeAs('intent', b64d(v?.bytes_b64 ?? ''));
    expect(inp).not.toBeNull();
    if (inp)
      expect(intentForOp({ ...inp, op: 'add_device' }, 'user', false, false)).toBe(
        'malformed_for_op'
      );
  });

  it('refuses a recovery-bind kind the rule does not know', async () => {
    const v = VECTORS.find((x) => x.type === 'for-op' && (x.input as Json).tag === 'recovery-bind');
    const b = await decodeAs('recovery-bind', b64d(v?.bytes_b64 ?? ''));
    expect(b).not.toBeNull();
    if (b) expect(recoveryBindForKind({ ...b, kind: 'other' })).toBe('malformed_for_op');
    expect(await checkRelayRecover(BAD)).toBe('malformed');
  });

  it('reads the table and the assurance order', () => {
    expect(rowByN(0)).toBeNull();
    expect(rowByN(23)).toBeNull();
    expect(rowByN(1.5)).toBeNull();
    expect(rowByN(22)?.actor).toBe('restore');
    expect(rowsFor('recover', 'user').map((r) => r.n)).toEqual([20]);
    expect(Object.isFrozen(rowByN(1))).toBe(true);
    expect(capAt('initial', 'recovery')).toBe('recovery');
    expect(capAt('unverified', 'recovery')).toBe('unverified');
    expect(segmentRule('initial')).toBe('continuity');
    expect(segmentRule('recovery')).toBe('recovery');
    expect(knownSegment('')).toBe('unverified');
    expect(knownSegment('bogus')).toBe('unverified');
  });

  it('maps every Reason to a verdict and a notice', () => {
    expect(verdictOf('trust_halt')).toBe('halt');
    expect(noticeOf('fork')).toBe(true);
    expect(noticeOf('held')).toBe(false);
    expect(noticeOf('no-such-reason')).toBe(false);
  });
});

describe('heads and messages', () => {
  it('encodes the genesis head and refuses an unencodable one', () => {
    const h = genesisHead(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    );
    expect(chainHeadBytes(h)).not.toBeNull();
    expect(canonicalHead(h)).toBe(true);
    expect(chainHeadBytes({ ...h, realm_id: 'x' })).toBeNull();
    expect(
      canonicalHead({ ...h, ek_index: [new Uint8Array(48).fill(2), new Uint8Array(48)] })
    ).toBe(false);
    expect(canonicalHead({} as ChainHead)).toBe(false);
  });

  it('keeps an a<s> sorted without duplicates', () => {
    expect(insertSorted(['a', 'c'], 'b')).toEqual(['a', 'b', 'c']);
    expect(insertSorted(['a', 'c'], 'c')).toEqual(['a', 'c']);
  });

  it('finds no root for a digest root_index does not hold', async () => {
    const h = await headOf(OK_CHAIN.prev_head);
    expect(rootByDigest(h, new Uint8Array(48))).toBeNull();
  });

  it('rebuilds nothing from an invalid message', () => {
    expect(sigMsg('no-such-role', new Uint8Array(48))).toBeNull();
    expect(encodeAs('anchors', {} as never)).toBeNull();
  });

  it('sums u values exactly', () => {
    expect(addMs(1, 2, 3)).toBe(6);
    expect(addMs(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(addMs(-1)).toBeNull();
    expect(sumBelow(Number.MAX_SAFE_INTEGER, 120_000, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(sumBelow(1, 1, 3)).toBe(true);
  });
});

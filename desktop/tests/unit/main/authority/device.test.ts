// @vitest-environment node
// Edges of the device rules, the device ledger and the wrap opener that the
// committed vectors do not reach. The vectors decide every verdict they carry
// (vectors.parity.test.ts); these tests pin the refusals the generator never
// recorded and the fail-closed paths: hand-built heads, inputs that throw.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { b64d, b64e, fromHex } from '@/main/authority/bytes';
import { RECOVERY_REPLACE_MS } from '@/main/authority/constants';
import {
  applyDeviceOp,
  deviceSetDigest,
  devString,
  emptyDeviceSet,
  normalizeDeviceSet,
  parseSet,
  type DeviceOpInput,
} from '@/main/authority/devicerules';
import {
  admittedRecord,
  deviceHeadBytes,
  genesisHead,
  parseDeviceHead,
  type DeviceHead,
} from '@/main/authority/heads';
import {
  activeRecipient,
  AFTER_EVENT,
  floorHolds,
  sharedReason,
  verifyDeviceLedger,
  type DeviceLedgerInput,
} from '@/main/authority/ledger';
import { decodeAs, encodeAs, type DeviceSet, type RecoveryBind } from '@/main/authority/messages';
import { attachedOp, deviceIntentForOp } from '@/main/authority/patterns';
import { deviceId, sha384, type DevRecord } from '@/main/authority/primitives';
import type { AccountMemory } from '@/main/authority/status';
import { newTrust, type HighWater, type Trust } from '@/main/authority/trust';
import { sealDeviceWrap, verifyDeviceWrap, type DkxPair } from '@/main/authority/wrap';

const { subtle } = globalThis.crypto;
const REALM = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const NONE = new Uint8Array(0);
const D48 = (x: number): Uint8Array => new Uint8Array(48).fill(x);

async function point(): Promise<Uint8Array> {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign']);
  return new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
}

async function dev(matureAtMs = 0): Promise<DevRecord> {
  const dsk = await point();
  return { id: await deviceId(dsk), dsk, dkx: await point(), matureAtMs };
}

function setOf(p: Partial<DeviceSet> & { act?: DevRecord[]; pend?: DevRecord }): Uint8Array {
  const { act = [], pend, ...rest } = p;
  const b = encodeAs('device-set', {
    realm_id: REALM,
    account_id: ACCOUNT,
    active: act.map(devString),
    pending: pend ? devString(pend) : '',
    recovery_key: NONE,
    recovery_bind_digest: NONE,
    replacement_key: NONE,
    replacement_bind_digest: NONE,
    replacement_nb_ms: 0,
    ...rest,
  });
  if (!b) throw new Error('test set does not encode');
  return b;
}

function bindB(p: Partial<RecoveryBind>): Uint8Array {
  const b = encodeAs('recovery-bind', {
    realm_id: REALM,
    account_id: ACCOUNT,
    request_id: '33333333-3333-4333-8333-333333333333',
    kind: 'bind',
    expires_at_ms: 0,
    recovery_key: NONE,
    target_digest: NONE,
    chain_seq: 1,
    chain_entry_digest: D48(1),
    binding_root_digest: D48(2),
    escrow_public_key: NONE,
    ...p,
  });
  if (!b) throw new Error('test recovery-bind does not encode');
  return b;
}

const HEAD = {
  state: 'active',
  seq: 1,
  entryDigest: D48(1),
  rootDigest: D48(2),
  forceUnverified: false,
};

const opIn = (p: Partial<DeviceOpInput>): DeviceOpInput => ({
  op: 'unsuspend',
  actor: '',
  new: null,
  removed: [],
  bind: NONE,
  bindWait: '',
  priorSig: false,
  rootForm: false,
  head: HEAD,
  outcome: '',
  proposingAnbMs: 0,
  ...p,
});

let a: DevRecord, b: DevRecord, n: DevRecord, young: DevRecord;
let key1: Uint8Array, key2: Uint8Array, escrow: Uint8Array;
beforeAll(async () => {
  [a, b, n, young] = await Promise.all([dev(0), dev(0), dev(0), dev(5_000)]);
  [key1, key2, escrow] = await Promise.all([point(), point(), point()]);
});

const refusal = async (set: Uint8Array, p: Partial<DeviceOpInput>, issued = 1_000, delta = 10) =>
  (await applyDeviceOp(set, opIn(p), issued, delta))[1];

const after = async (set: Uint8Array, p: Partial<DeviceOpInput>, issued = 1_000, delta = 10) => {
  const [out, r] = await applyDeviceOp(set, opIn(p), issued, delta);
  expect(r).toBe('');
  return (await parseSet(out!))!;
};

describe('applyDeviceOp refusals (DR1, DR2, DR4–DR6, DR9)', () => {
  it('refuses a set, a B or a bind_wait pattern that does not hold', async () => {
    const set = setOf({ act: [a] });
    expect(await refusal(utf8Bytes('not a set'), {})).toBe('wrong_state');
    expect(await refusal(set, { op: 'bind_recovery', actor: a.id, bind: utf8Bytes('x') })).toBe(
      'wrong_state'
    );
    const noEscrow = bindB({ recovery_key: key1 }); // a bind with no escrow key fails its kind
    expect(await refusal(set, { op: 'bind_recovery', actor: a.id, bind: noEscrow })).toBe(
      'malformed_for_op'
    );
    const ok = bindB({ recovery_key: key1, escrow_public_key: escrow });
    // prior_sig must be set exactly when bind_wait is empty
    expect(await refusal(set, { op: 'bind_recovery', actor: a.id, bind: ok })).toBe(
      'malformed_for_op'
    );
    expect(await refusal(set, { op: 'bogus' })).toBe('wrong_state');
  });

  it('gates add_device and bind_recovery on an active, verified head, and a cancel on a live one', async () => {
    const set = setOf({ act: [a] });
    const add = { op: 'add_device', actor: a.id, new: n };
    expect(await refusal(set, { ...add, head: { ...HEAD, state: 'suspended' } })).toBe(
      'wrong_state'
    );
    expect(await refusal(set, { ...add, head: { ...HEAD, forceUnverified: true } })).toBe(
      'wrong_state'
    );
    const cancel = bindB({
      kind: 'cancel',
      expires_at_ms: 5,
      recovery_key: key1,
      chain_seq: 0,
      chain_entry_digest: NONE,
      binding_root_digest: NONE,
    });
    expect(
      await refusal(set, {
        op: 'cancel_recovery_bind',
        bind: cancel,
        head: { ...HEAD, state: 'erased' },
      })
    ).toBe('wrong_state');
  });

  it('refuses unknown actors, removals and new devices (DR1) and a young actor (DR4)', async () => {
    const set = setOf({ act: [a, b, young], pend: n });
    expect(await refusal(set, { op: 'rotate_ek', actor: n.id })).toBe('device_unknown');
    expect(await refusal(set, { op: 'rotate_ek', actor: a.id, removed: [a.id] })).toBe(
      'device_unknown'
    );
    expect(await refusal(set, { op: 'rotate_ek', actor: a.id, removed: [n.id] })).toBe(
      'device_unknown'
    );
    const add = { op: 'add_device', actor: a.id };
    expect(await refusal(set, { ...add, new: b })).toBe('device_unknown');
    expect(await refusal(set, { ...add, new: n })).toBe('device_unknown');
    expect(await refusal(set, { ...add, new: { ...(await dev()), id: a.id } })).toBe(
      'device_unknown'
    );
    expect(await refusal(set, { op: 'rotate_ek', actor: young.id }, 4_999)).toBe('device_too_new');
    expect(await refusal(set, { op: 'rotate_ek', actor: young.id }, 5_000)).toBe('');
  });

  it('caps the active set at MAX_DEVICES', async () => {
    const ten = await Promise.all(Array.from({ length: 10 }, () => dev()));
    const set = setOf({ act: ten });
    expect(await refusal(set, { op: 'add_device', actor: ten[0].id, new: n })).toBe('device_limit');
    const nine = setOf({ act: ten.slice(0, 9) });
    expect(await refusal(nine, { op: 'add_device', actor: ten[0].id, new: n })).toBe('');
  });

  it('applies the enroll, propose, rotate and add bodies', async () => {
    const empty = emptyDeviceSet(REALM, ACCOUNT)!;
    expect(await refusal(empty, { op: 'enroll_new' })).toBe('malformed_for_op');
    const enrolled = await after(empty, { op: 'enroll_new', new: n }, 7);
    expect(enrolled.act.map((e) => [e.id, e.matureAtMs])).toEqual([[n.id, 7]]);

    const set = setOf({ act: [a, b] });
    expect(await refusal(set, { op: 'replace_root', outcome: 'P' })).toBe('malformed_for_op');
    expect(await refusal(set, { op: 'replace_root', new: n, outcome: '' })).toBe('wrong_state');
    const proposed = await after(set, {
      op: 'replace_root',
      new: n,
      outcome: 'P',
      proposingAnbMs: 9,
    });
    expect([proposed.pend?.id, proposed.pend?.matureAtMs]).toEqual([n.id, 9]);
    const disputed = await after(setOf({ act: [a], pend: n }), {
      op: 'enroll_existing',
      new: b,
      outcome: 'D',
    });
    expect(disputed.pend).toBeNull();

    const rotated = await after(
      setOf({
        act: [a, b],
        recovery_key: key1,
        recovery_bind_digest: D48(3),
        replacement_key: key2,
        replacement_bind_digest: D48(4),
        replacement_nb_ms: 50,
      }),
      { op: 'rotate_root', actor: a.id, removed: [b.id] }
    );
    expect(rotated.act.map((e) => e.id)).toEqual([a.id]);
    expect(rotated.v.replacement_bind_digest).toHaveLength(0);
    expect(rotated.v.recovery_key).toEqual(key1);

    expect(await refusal(set, { op: 'add_device', actor: a.id })).toBe('malformed_for_op');
    expect(
      await refusal(set, { op: 'add_device', actor: a.id, new: n }, Number.MAX_SAFE_INTEGER, 1)
    ).toBe('wrong_state');
    const added = await after(set, { op: 'add_device', actor: a.id, new: n }, 100, 25);
    expect(added.act.find((e) => e.id === n.id)?.matureAtMs).toBe(125);
    expect((await after(set, { op: 'unsuspend', actor: a.id })).v).toEqual(
      (await parseSet(set))!.v
    );
  });

  it('admits a recover only under the bound B, as a pending proposal that empties the slot', async () => {
    const recoverB = bindB({ recovery_key: key1, escrow_public_key: escrow });
    const h = await sha384(recoverB);
    const bound = {
      act: [a],
      recovery_key: key1,
      recovery_bind_digest: h,
      replacement_key: key2,
      replacement_bind_digest: D48(4),
      replacement_nb_ms: 50,
    };
    const rec = { op: 'recover', new: n, bind: recoverB, outcome: 'P' };
    expect(await refusal(setOf({ act: [a] }), rec)).toBe('recovery_key_unbound');
    expect(await refusal(setOf({ ...bound, recovery_bind_digest: D48(9) }), rec)).toBe(
      'recovery_key_unbound'
    );
    expect(await refusal(setOf(bound), { ...rec, outcome: 'D' })).toBe('wrong_state');
    const out = await after(setOf(bound), rec);
    expect(out.pend?.id).toBe(n.id);
    expect(out.v.replacement_bind_digest).toHaveLength(0);
    expect(out.v.recovery_key).toEqual(key1);
  });
});

describe('applyDeviceOp bind_recovery and cancel_recovery_bind (DR9 (a), (b), (e))', () => {
  const bindOp = (bind: Uint8Array, p: Partial<DeviceOpInput> = {}): Partial<DeviceOpInput> => ({
    op: 'bind_recovery',
    actor: a.id,
    bind,
    bindWait: 'now',
    ...p,
  });
  const bound = (): Partial<DeviceSet> & { act: DevRecord[] } => ({
    act: [a],
    recovery_key: key1,
    recovery_bind_digest: D48(3),
  });
  const slot = (): Partial<DeviceSet> => ({
    replacement_key: key2,
    replacement_bind_digest: D48(4),
    replacement_nb_ms: 50,
  });

  it('refuses a cancel B, a stale or foreign head, and an unknown wait', async () => {
    const set = setOf({ act: [a] });
    const cancel = bindB({
      kind: 'cancel',
      expires_at_ms: 5,
      recovery_key: key1,
      chain_seq: 0,
      chain_entry_digest: NONE,
      binding_root_digest: NONE,
    });
    expect(await refusal(set, bindOp(cancel))).toBe('wrong_state');
    const bnd = bindB({ recovery_key: key1, escrow_public_key: escrow });
    expect(await refusal(set, bindOp(bnd, { head: { ...HEAD, seq: 2 } }))).toBe('stale_seq');
    expect(await refusal(set, bindOp(bnd, { head: { ...HEAD, entryDigest: D48(7) } }))).toBe(
      'stale_head'
    );
    expect(await refusal(set, bindOp(bnd, { head: { ...HEAD, rootDigest: D48(7) } }))).toBe(
      'wrong_state'
    );
    expect(await refusal(set, bindOp(bnd, { bindWait: 'later' }))).toBe('wrong_state');
    expect(await refusal(set, bindOp(bnd, { bindWait: 'delta' }), Number.MAX_SAFE_INTEGER, 1)).toBe(
      'wrong_state'
    );
  });

  it('binds now, after a wait, or replaces under the prior key', async () => {
    const bnd = bindB({ recovery_key: key2, escrow_public_key: escrow });
    const h = await sha384(bnd);
    const now = await after(setOf({ act: [a] }), bindOp(bnd));
    expect([now.v.recovery_key, now.v.recovery_bind_digest]).toEqual([key2, h]);
    const later = await after(setOf({ act: [a] }), bindOp(bnd, { bindWait: 'replace' }), 100);
    expect(later.v.replacement_nb_ms).toBe(100 + RECOVERY_REPLACE_MS);
    expect(later.v.recovery_key).toHaveLength(0);
    expect(await refusal(setOf({ ...bound(), ...slot() }), bindOp(bnd))).toBe('wrong_state');
    const prior = bindOp(bnd, { bindWait: '', priorSig: true });
    expect(await refusal(setOf({ act: [a] }), prior)).toBe('wrong_state');
    const replaced = await after(setOf({ ...bound(), ...slot() }), prior);
    expect([replaced.v.recovery_key, replaced.v.replacement_bind_digest.length]).toEqual([key2, 0]);
  });

  it('unbinds now, after a wait, or at once under the prior key', async () => {
    const unb = bindB({ kind: 'unbind' });
    const h = await sha384(unb);
    expect(await refusal(setOf({ act: [a] }), bindOp(unb))).toBe('wrong_state');
    expect((await after(setOf(bound()), bindOp(unb))).v.recovery_key).toHaveLength(0);
    const waiting = await after(setOf(bound()), bindOp(unb, { bindWait: 'delta' }), 100, 7);
    expect([waiting.v.replacement_key.length, waiting.v.replacement_bind_digest]).toEqual([0, h]);
    expect(waiting.v.replacement_nb_ms).toBe(107);
    expect(await refusal(setOf({ ...bound(), ...slot() }), bindOp(unb))).toBe('wrong_state');
    const prior = await after(
      setOf({ ...bound(), ...slot() }),
      bindOp(unb, { bindWait: '', priorSig: true })
    );
    expect([prior.v.recovery_key.length, prior.v.replacement_bind_digest.length]).toEqual([0, 0]);
  });

  it('cancels a pending slot only under the key and target it names', async () => {
    const cancel = (p: Partial<RecoveryBind>) =>
      bindB({
        kind: 'cancel',
        expires_at_ms: 5,
        recovery_key: key1,
        chain_seq: 0,
        chain_entry_digest: NONE,
        binding_root_digest: NONE,
        ...p,
      });
    const sheet = (bind: Uint8Array): Partial<DeviceOpInput> => ({
      op: 'cancel_recovery_bind',
      bind,
    });
    const root = (bind: Uint8Array): Partial<DeviceOpInput> => ({
      ...sheet(bind),
      actor: a.id,
      rootForm: true,
    });
    const withSlot = setOf({ ...bound(), ...slot() });
    expect(await refusal(setOf(bound()), sheet(cancel({})))).toBe('wrong_state');
    expect(await refusal(withSlot, sheet(cancel({ target_digest: D48(9) })))).toBe('wrong_state');
    expect(await refusal(withSlot, sheet(cancel({ recovery_key: key2 })))).toBe(
      'recovery_key_unbound'
    );
    const unboundSlot = setOf({ act: [a], ...slot() });
    expect(await refusal(unboundSlot, sheet(cancel({})))).toBe('recovery_key_unbound');
    const cleared = await after(withSlot, sheet(cancel({ target_digest: D48(4) })));
    expect(cleared.v.replacement_bind_digest).toHaveLength(0);
    // The root form cancels only a first bind's pending key (nothing bound yet).
    expect(await refusal(withSlot, root(cancel({ recovery_key: key2 })))).toBe('wrong_state');
    expect(await refusal(unboundSlot, root(cancel({})))).toBe('wrong_state');
    const rootCleared = await after(unboundSlot, root(cancel({ recovery_key: key2 })));
    expect(rootCleared.v.replacement_bind_digest).toHaveLength(0);
  });
});

describe('normalizeDeviceSet (DR8, DR9 (c))', () => {
  it('completes, activates and burns in its fixed order, and refuses a set that does not decode', async () => {
    expect(await normalizeDeviceSet(utf8Bytes('x'), { activate: true })).toBeNull();
    const slotted = setOf({
      act: [a],
      pend: n,
      recovery_key: key1,
      recovery_bind_digest: D48(3),
      replacement_key: key2,
      replacement_bind_digest: D48(4),
      replacement_nb_ms: 50,
    });
    const completed = (await parseSet(
      (await normalizeDeviceSet(slotted, { completeSlot: true }))!
    ))!;
    expect([completed.v.recovery_key, completed.v.recovery_bind_digest]).toEqual([key2, D48(4)]);
    const unbindSlot = setOf({
      act: [a],
      recovery_key: key1,
      recovery_bind_digest: D48(3),
      replacement_bind_digest: D48(4),
      replacement_nb_ms: 50,
    });
    const unbound = (await parseSet(
      (await normalizeDeviceSet(unbindSlot, { completeSlot: true }))!
    ))!;
    expect(unbound.v.recovery_key).toHaveLength(0);
    const act = (await parseSet(
      (await normalizeDeviceSet(slotted, { activate: true, burnRecovery: true }))!
    ))!;
    expect([act.act.map((e) => e.id), act.pend, act.v.replacement_bind_digest.length]).toEqual([
      [n.id],
      null,
      0,
    ]);
    expect(act.v.recovery_key).toHaveLength(0);
    const noPending = (await parseSet(
      (await normalizeDeviceSet(unbindSlot, { activate: true }))!
    ))!;
    expect(noPending.act.map((e) => e.id)).toEqual([a.id]);
    const cleared = (await parseSet(
      (await normalizeDeviceSet(slotted, { clearPending: true, emptySlot: true }))!
    ))!;
    expect([cleared.pend, cleared.v.replacement_bind_digest.length]).toEqual([null, 0]);
    expect(await deviceSetDigest(utf8Bytes('x'))).toBeNull();
  });
});

describe('the ledger internals the vectors do not pin', () => {
  it('maps each published row to its entry-less change, and only row 22 empties the slot', async () => {
    expect(Object.keys(AFTER_EVENT).map(Number)).toEqual([13, 14, 16, 17, 21, 22]);
    const slotted = setOf({
      act: [a],
      pend: n,
      recovery_key: key1,
      recovery_bind_digest: D48(3),
      replacement_key: key2,
      replacement_bind_digest: D48(4),
      replacement_nb_ms: 50,
    });
    const after = async (row: number) =>
      (await parseSet((await normalizeDeviceSet(slotted, AFTER_EVENT[row]))!))!;
    for (const row of [13, 14, 16, 17, 21]) {
      const kept = await after(row);
      expect([kept.pend, kept.v.replacement_bind_digest], `row ${row}`).toEqual([null, D48(4)]);
    }
    const emptied = await after(22);
    expect([emptied.pend, emptied.v.replacement_bind_digest.length]).toEqual([null, 0]);
    expect(AFTER_EVENT[15]).toBeUndefined();
  });

  it('holds the slot floor at its as_of and not one ms after (RT6-9), and always under C4-4', () => {
    const f = { digest: D48(4), after: 30_000, never: false };
    expect(floorHolds(f, D48(4), 29_999)).toBe(true);
    expect(floorHolds(f, D48(4), 30_000)).toBe(true);
    expect(floorHolds(f, D48(4), 30_001)).toBe(false);
    expect(floorHolds(f, D48(5), 30_000)).toBe(false);
    expect(floorHolds({ ...f, never: true }, D48(4), 1e12)).toBe(true);
    expect(floorHolds({ ...f, never: true }, D48(5), 0)).toBe(false);
  });

  it('refuses with the one Reason every hypothesis shares, else device_rule (DR9 (c))', () => {
    expect(sharedReason(['wrong_state', 'wrong_state'])).toBe('wrong_state');
    expect(sharedReason(['wrong_state', 'malformed'])).toBe('device_rule');
  });
});

describe('the device-intent per-op table (§2.5)', () => {
  it('reads the attached and private ops and refuses an op it does not list', async () => {
    expect(attachedOp('recover')).toBe(true);
    expect(attachedOp('add_device')).toBe(false);
    expect(attachedOp('toString')).toBe(false);
    const di = {
      realm_id: REALM,
      account_id: ACCOUNT,
      request_id: '33333333-3333-4333-8333-333333333333',
      op: 'add_device',
      salt: new Uint8Array(32),
      expires_at_ms: 9,
      expected_seq: 1,
      expected_head_digest: D48(1),
      expected_dseq: 1,
      expected_device_head: D48(2),
      actor_device_id: a.id,
      new_device_id: n.id,
      new_device_dsk: n.dsk,
      new_device_dkx: n.dkx,
      removed_device_ids: [],
      recovery_bind_digest: NONE,
      bind_wait: '',
    };
    expect(deviceIntentForOp(di, NONE)).toBe('');
    expect(deviceIntentForOp({ ...di, op: 'bogus' }, NONE)).toBe('malformed_for_op');
    expect(deviceIntentForOp({ ...di, new_device_dkx: n.dsk }, NONE)).toBe('malformed_for_op');
    const attached = {
      ...di,
      op: 'recover',
      expires_at_ms: 0,
      actor_device_id: '',
      expected_dseq: 0,
      expected_device_head: NONE,
    };
    expect(deviceIntentForOp(attached, key1)).toBe('');
    expect(deviceIntentForOp(attached, n.dsk)).toBe('malformed_for_op');
    expect(deviceIntentForOp(attached, NONE)).toBe('malformed_for_op'); // an attached new device needs a candidate
  });
});

// ── Ledger and wrap: the committed fixtures, edited where a test needs it ─────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vector fixtures are heterogeneous JSON
type Vec = Record<string, any>;
const VECTORS: Vec[] = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../docs/design/account-key-authority-vectors.json'),
    'utf8'
  )
).vectors;
const vec = (name: string): Vec => {
  const v = VECTORS.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  return v;
};
const utf8Bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

async function trustOf(v: Vec): Promise<Trust> {
  const t = await newTrust(b64d(v.anchors));
  for (const s of v.trust ?? []) await t!.addSigned(b64d(s));
  return t!;
}
const hwOf = (h: Vec): HighWater => ({ gen: h.gen, serial: h.serial, minValid: h.min_valid });
const memOf = (m: Vec): AccountMemory => ({
  pin: m.pin ? b64d(m.pin) : NONE,
  everEnrolled: m.everEnrolled === 1,
  acceptedPin: m.acceptedPin ? b64d(m.acceptedPin) : NONE,
});
const inputOf = (v: Vec): DeviceLedgerInput => ({
  chainBundles: v.bundles.map(b64d),
  deviceBundles: v.device_bundles.map(b64d),
  status: b64d(v.bytes_b64),
  deviceStatus: b64d(v.device_status),
});

async function ledger(
  v: Vec,
  edit: Partial<DeviceLedgerInput> = {},
  from?: DeviceHead,
  nowMs?: number,
  use?: string
) {
  const h = from ?? (await parseDeviceHead(b64d(v.prev_device_head), b64d(v.prev_head)))!;
  return verifyDeviceLedger(
    await trustOf(v),
    hwOf(v.hw),
    h,
    { ...inputOf(v), ...edit },
    memOf(v.mem),
    nowMs ?? Number(v.now_ms),
    (use ?? v.use) as 'new-secret' | 'history'
  );
}

const WRAP_LEDGER = 'wrap/head-from-verified-ledger';

describe('verifyDeviceLedger', () => {
  it("persists the head every wrap vector opens against, with self's three secrets entries", async () => {
    const v = vec(WRAP_LEDGER);
    const out = await ledger(v);
    expect(out.reason).toBe('ok');
    const [dh, ch] = (await deviceHeadBytes(out.device))!;
    expect(b64e(dh)).toBe(v.expect.device_head_b64);
    expect(b64e(ch)).toBe(v.expect.head_b64);
    expect(out.device.secrets.map((r) => r.split('.')[1])).toEqual([
      'add_device',
      'rotate_ek',
      'rotate_root',
    ]);
    const wraps = VECTORS.filter((x) => x.type === 'device-wrap-open');
    expect(wraps).toHaveLength(20);
    for (const w of wraps) {
      expect(w.prev_device_head, w.name).toBe(v.expect.device_head_b64);
      expect(w.prev_head, w.name).toBe(v.expect.head_b64);
    }
    // The view: self is active, every active device has its admitter recorded.
    const self = out.device.self_device_id;
    expect(out.view.active.some((e) => e.id === self)).toBe(true);
    expect(out.view.admitted.has(self)).toBe(true);
    expect(out.view.dseq).toBeGreaterThan(0);
    expect(out.hw).toEqual(expect.objectContaining({ gen: expect.any(Number) }));
  });

  it('holds the device-status to τ under every Use (DoR:919)', async () => {
    const v = vec(WRAP_LEDGER);
    const st = (await decodeAs('signed', b64d(v.bytes_b64)))!;
    const status = (await decodeAs('status', st.msg))!;
    // After τ but before valid_until: the chain status passes under history, the device-status does not.
    const t = await trustOf(v);
    const d = t.lookup(status.delegation_gen, status.delegation_serial)!;
    const now = status.as_of_ms + d.tau_ms + 1;
    expect(now).toBeLessThanOrEqual(status.valid_until_ms);
    expect((await ledger(v, {}, undefined, now, 'history')).reason).toBe('device_status_stale');
    expect((await ledger(v, {}, undefined, now, 'new-secret')).reason).toBe('status_stale_tau');
  });

  it('refuses a device-status or entry that does not decode, and a ledger that stops short', async () => {
    const v = vec(WRAP_LEDGER);
    expect((await ledger(v, { deviceStatus: utf8Bytes('x') })).reason).toBe('malformed');
    expect((await ledger(v, { deviceBundles: [utf8Bytes('x')] })).reason).toBe('malformed');
    expect((await ledger(v, { deviceStatus: b64d(v.bytes_b64) })).reason).toBe('malformed');
    expect(
      (await ledger(v, { deviceBundles: v.device_bundles.slice(0, -1).map(b64d) })).reason
    ).toMatch(/^device_/);
    expect((await ledger(v, {}, undefined, 0)).reason).toBe('malformed');
  });

  it('refuses a hand-built device-head the codec or the pairing would refuse', async () => {
    const v = vec(WRAP_LEDGER);
    const h = (await parseDeviceHead(b64d(v.prev_device_head), b64d(v.prev_head)))!;
    const realm = { ...h, realm_id: '99999999-9999-4999-8999-999999999999' };
    expect((await ledger(v, {}, realm)).reason).toBe('malformed');
    const unpaired = {
      ...h,
      device_set: emptyDeviceSet(REALM, ACCOUNT)!,
      last_device_result: NONE,
    };
    expect((await ledger(v, {}, unpaired)).reason).toBe('malformed');
    const badRecord = { ...h, admitted_by: ['not-a-record'] };
    expect((await ledger(v, {}, badRecord)).reason).toBe('malformed');
    const out = await ledger(v, {}, badRecord);
    expect(out.device).toBe(badRecord);
    expect(out.view.active).toEqual([]);
    const broken = {
      ...h,
      chain: { ...genesisHead(REALM, ACCOUNT), seq_index: null },
    } as unknown as DeviceHead;
    expect((await ledger(v, {}, broken)).reason).toBe('malformed');
    const other = vec('wrap/current').prev_head;
    const paired = await parseDeviceHead(b64d(v.prev_device_head), b64d(other));
    expect(paired === null).toBe(other !== v.prev_head); // the chain_head_digest pairing
    expect(await parseDeviceHead(b64d(v.prev_device_head), utf8Bytes('x'))).toBeNull();
    expect(await deviceHeadBytes({ ...h, admitted_by: ['x'] })).toBeNull();
    expect(admittedRecord(a.id, '')).toBe(`${a.id}.`);
  });
});

// A P-384 PKCS#8 holding only the scalar d; the runtime derives the public point.
const P384_D_PKCS8 = '304e020100301006072a8648ce3d020106052b81040022043730350201010430';
async function dkxPair(d: Uint8Array): Promise<DkxPair> {
  const alg = { name: 'ECDH', namedCurve: 'P-384' };
  const der = new Uint8Array([...fromHex(P384_D_PKCS8), ...d]);
  const privateKey = await subtle.importKey('pkcs8', der, alg, true, ['deriveBits']);
  const { x, y } = await subtle.exportKey('jwk', privateKey);
  const publicKey = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-384', x, y }, alg, true, []);
  return { privateKey, publicKey };
}

describe('verifyDeviceWrap', () => {
  it("opens only against a head that names the entry once, for self, under self's key", async () => {
    const v = vec('wrap/current');
    const h = (await parseDeviceHead(b64d(v.prev_device_head), b64d(v.prev_head)))!;
    const dkx = await dkxPair(b64d(v.recipient_dkx_d));
    const wrap = b64d(v.bytes_b64);
    const open = (head: DeviceHead, k = dkx, w = wrap) => verifyDeviceWrap(head, w, k);
    const ok = await open(h);
    expect([ok.reason, ok.use]).toEqual(['ok', 'current']);
    expect(ok.secrets!.root_pkcs8.length).toBeGreaterThan(0);
    const last = h.secrets.at(-1)!;
    // Named twice: no entry. A record that does not parse: no entry.
    expect((await open({ ...h, secrets: [...h.secrets, last] })).reason).toBe('wrap_invalid');
    expect((await open({ ...h, secrets: ['x', ...h.secrets] })).reason).toBe('wrap_invalid');
    const [e, , root, spki] = last.split('.');
    expect((await open({ ...h, secrets: [`${e}.rotate_ek.${root}.${spki}`] })).reason).toBe(
      'wrap_invalid'
    );
    expect((await open({ ...h, secrets: [`${e}.rotate_root.${root}.***`] })).reason).toBe(
      'wrap_invalid'
    );
    expect((await open({ ...h, self_device_id: '' })).reason).toBe('wrap_invalid');
    expect((await open({ ...h, account_id: REALM })).reason).toBe('wrap_invalid');
    // As the only entry it is the latest; ahead of another it is history.
    expect((await open({ ...h, secrets: [last] })).use).toBe('current');
    expect((await open({ ...h, secrets: [last, h.secrets[0]] })).use).toBe('history');
    const other = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, [
      'deriveBits',
    ]);
    expect((await open(h, other)).reason).toBe('wrap_invalid');
    expect((await open(h, dkx, utf8Bytes('x'))).reason).toBe('wrap_invalid');
    const refused = await open(h, { privateKey: null, publicKey: null } as unknown as DkxPair);
    expect([refused.reason, refused.secrets, refused.use]).toEqual(['wrap_invalid', null, null]);
  });
});

describe('sealDeviceWrap', () => {
  const fixture = async () => {
    const v = vec('wrap/current');
    const h = (await parseDeviceHead(b64d(v.prev_device_head), b64d(v.prev_head)))!;
    const dkx = await dkxPair(b64d(v.recipient_dkx_d));
    const w = (await decodeAs('device-wrap', b64d(v.bytes_b64)))!;
    const opened = await verifyDeviceWrap(h, b64d(v.bytes_b64), dkx);
    expect(opened.reason).toBe('ok');
    const self = (await parseSet(h.device_set))!.act.find((e) => e.id === h.self_device_id)!;
    return { h, dkx, w, secrets: opened.secrets!, self };
  };

  it('seals what verifyDeviceWrap opens, under a fresh epk and nonce, and refuses any tamper', async () => {
    const { h, dkx, w, secrets, self } = await fixture();
    const sealed = (await sealDeviceWrap(h, self, w.device_entry_digest, secrets))!;
    const back = await verifyDeviceWrap(h, sealed, dkx);
    expect([back.reason, back.use]).toEqual(['ok', 'current']);
    expect(back.secrets).toEqual(secrets);
    const x = (await decodeAs('device-wrap', sealed))!;
    expect(x.epk).not.toEqual(w.epk);
    expect(x.nonce).not.toEqual(w.nonce);
    const flip = (b: Uint8Array, i: number) => {
      const c = b.slice();
      c[i < 0 ? c.length + i : i] ^= 1;
      return c;
    };
    for (const [name, t] of [
      ['ct', { ...x, ct: flip(x.ct, 3) }],
      ['tag', { ...x, ct: flip(x.ct, -1) }],
      ['nonce', { ...x, nonce: flip(x.nonce, 0) }],
      ['epk', { ...x, epk: await point() }],
    ] as const) {
      const b = encodeAs('device-wrap', t);
      expect(b, name).not.toBeNull();
      expect((await verifyDeviceWrap(h, b!, dkx)).reason, name).toBe('wrap_invalid');
    }
  });

  it('seals only to an active member with its own dkx, under a 48-byte entry, a valid secrets', async () => {
    const { h, w, secrets, self } = await fixture();
    const entry = w.device_entry_digest;
    for (const [name, head, to, e, s] of [
      ['not in the set', h, { ...self, id: crypto.randomUUID() }, entry, secrets],
      ['another dkx', h, { ...self, dkx: await point() }, entry, secrets],
      ['short entry', h, self, entry.subarray(0, 47), secrets],
      ['no ek', h, self, entry, { ...secrets, ek_pkcs8: new Uint8Array(0) }],
      ['empty set', { ...h, device_set: new Uint8Array(0) }, self, entry, secrets],
      ['malformed realm', { ...h, realm_id: 'x' }, self, entry, secrets],
      ['malformed admitted', { ...h, admitted_by: ['x'] }, self, entry, secrets],
    ] as const) {
      expect(await sealDeviceWrap(head, to, e, s), name).toBeNull();
    }
  });

  it('follows a new-root activation the fix shows and the set has not recorded (D-S2)', async () => {
    const v = vec('ledger/status-shows-activation-before-completion');
    const h = (await parseDeviceHead(b64d(v.expect.device_head_b64), b64d(v.expect.head_b64)))!;
    const set = (await parseSet(h.device_set))!;
    expect(set.pend).not.toBeNull();
    expect(set.act).toHaveLength(1);
    const [old, next] = [set.act[0], set.pend!];
    expect(await activeRecipient(h, old)).toBe(false);
    expect(await activeRecipient(h, next)).toBe(true);
    // The seal itself refuses the device the shown activation dropped.
    const { secrets } = await fixture();
    expect(await sealDeviceWrap(h, old, new Uint8Array(48), secrets)).toBeNull();
    expect(await sealDeviceWrap(h, next, new Uint8Array(48), secrets)).not.toBeNull();
    const noFix = { ...h, chain: { ...h.chain, fix: new Uint8Array(0) } };
    expect(await activeRecipient(noFix, old)).toBe(true);
    expect(await activeRecipient(noFix, next)).toBe(false);
    // A fix that shows the raw pending head still pending (held) keeps the persisted set.
    const sg = (await decodeAs('signed', h.chain.fix))!;
    const st = (await decodeAs('status', sg.msg))!;
    const held = encodeAs('signed', { ...sg, msg: encodeAs('status', { ...st, held: 1 })! })!;
    const heldH = { ...h, chain: { ...h.chain, fix: held } };
    expect(await activeRecipient(heldH, old)).toBe(true);
    expect(await activeRecipient(heldH, next)).toBe(false);
  });
});

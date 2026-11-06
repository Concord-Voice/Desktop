// The private device rules (design of record §2.9 DR1, DR2, DR4–DR6, DR8 and
// DR9 (a), (b), (c), (e); D-270): the set an own device keeps, and the one code
// path both the authority and VerifyDeviceLedger apply to it. DR3's signatures
// are the caller's.

import { b64e, equalBytes } from './bytes';
import { addMs, MAX_DEVICES, RECOVERY_REPLACE_MS } from './constants';
import { decodeAs, encodeAs, type DeviceSet, type RecoveryBind } from './messages';
import { actorOpName, recoveryBindForKind } from './patterns';
import { deviceId, parseDev, sha384, type DevRecord } from './primitives';

const NONE = new Uint8Array(0);

/** The published head an op acted on, as DR1–DR9 read it. Empty bytes are "". */
export interface HeadInput {
  state: string;
  seq: number;
  entryDigest: Uint8Array;
  rootDigest: Uint8Array;
  forceUnverified: boolean;
}

/** One device op's input to applyDeviceOp (D-270). */
export interface DeviceOpInput {
  op: string;
  actor: string;
  new: DevRecord | null;
  removed: string[];
  bind: Uint8Array; // the recovery-bind B bytes, or empty
  bindWait: string;
  priorSig: boolean;
  rootForm: boolean;
  head: HeadInput;
  outcome: string; // "P" or "D" for a proposing result, else ""
  proposingAnbMs: number;
}

/** An authority refusal code applyDeviceOp can give; '' admits. */
export type Refusal =
  | ''
  | 'wrong_state'
  | 'malformed_for_op'
  | 'device_unknown'
  | 'device_too_new'
  | 'device_limit'
  | 'recovery_key_unbound'
  | 'stale_seq'
  | 'stale_head';

/** A decoded device-set with its devices parsed. */
export interface DevSet {
  v: DeviceSet;
  act: DevRecord[];
  pend: DevRecord | null;
}

/** A `dev` string: device_id.dsk.dkx.mature_at_ms. */
export const devString = (e: DevRecord): string =>
  `${e.id}.${b64e(e.dsk)}.${b64e(e.dkx)}.${e.matureAtMs}`;

/** The genesis private set: no device and no recovery state. */
export const emptyDeviceSet = (realm: string, account: string): Uint8Array | null =>
  encodeAs('device-set', {
    realm_id: realm,
    account_id: account,
    active: [],
    pending: '',
    recovery_key: NONE,
    recovery_bind_digest: NONE,
    replacement_key: NONE,
    replacement_bind_digest: NONE,
    replacement_nb_ms: 0,
  });

/** EN5 over a device-set and every `dev` in it; null when malformed. */
export async function parseSet(b: Uint8Array): Promise<DevSet | null> {
  const v = await decodeAs('device-set', b);
  if (!v) return null;
  const act: DevRecord[] = [];
  for (const d of v.active) act.push(await parseDev(d));
  return { v, act, pend: v.pending === '' ? null : await parseDev(v.pending) };
}

const encodeSet = (s: DevSet): Uint8Array | null =>
  encodeAs('device-set', {
    ...s.v,
    active: s.act.map(devString),
    pending: s.pend ? devString(s.pend) : '',
  });

/** device_set_digest over a valid device-set's exact bytes; null when it does not decode. */
export async function deviceSetDigest(set: Uint8Array): Promise<Uint8Array | null> {
  return (await decodeAs('device-set', set)) ? sha384(set) : null;
}

export const activeIdx = (s: DevSet, id: string): number => s.act.findIndex((e) => e.id === id);

function clearSlot(s: DevSet): void {
  s.v = { ...s.v, replacement_key: NONE, replacement_bind_digest: NONE, replacement_nb_ms: 0 };
}

function unbindKey(s: DevSet): void {
  s.v = { ...s.v, recovery_key: NONE, recovery_bind_digest: NONE };
}

function waitMs(w: string, deltaMs: number): number | null {
  switch (w) {
    case 'now':
    case '':
      return 0;
    case 'delta':
      return deltaMs;
    case 'replace':
      return RECOVERY_REPLACE_MS;
  }
  return null;
}

/** DR1/DR4's set: ops with an actor device (the sheet-form cancel has none). */
const usesActor = (inp: DeviceOpInput): boolean =>
  inp.op === 'cancel_recovery_bind' ? inp.rootForm : actorOpName(inp.op);

/** Step 6's malformed_for_op for the recovery ops: B's per-kind positions and the bind_wait pattern. */
async function preCheck(inp: DeviceOpInput): Promise<[RecoveryBind | null, Refusal]> {
  if (!['bind_recovery', 'cancel_recovery_bind', 'recover'].includes(inp.op)) return [null, ''];
  const b = await decodeAs('recovery-bind', inp.bind);
  if (!b) return [null, 'wrong_state'];
  if (recoveryBindForKind(b) !== '') return [b, 'malformed_for_op'];
  if (inp.op === 'bind_recovery' && inp.priorSig === (inp.bindWait !== ''))
    return [b, 'malformed_for_op'];
  return [b, ''];
}

function headGate(inp: DeviceOpInput): Refusal {
  if (inp.op === 'add_device' || inp.op === 'bind_recovery')
    return inp.head.state !== 'active' || inp.head.forceUnverified ? 'wrong_state' : '';
  if (inp.op === 'cancel_recovery_bind' && inp.head.state === 'erased') return 'wrong_state';
  return '';
}

async function dr1(s: DevSet, inp: DeviceOpInput): Promise<Refusal> {
  if (usesActor(inp)) {
    if (activeIdx(s, inp.actor) < 0) return 'device_unknown';
    if (inp.removed.some((id) => id === inp.actor || activeIdx(s, id) < 0)) return 'device_unknown';
  }
  const n = inp.new;
  if (n && (activeIdx(s, n.id) >= 0 || s.pend?.id === n.id || (await deviceId(n.dsk)) !== n.id))
    return 'device_unknown';
  return '';
}

function dr4(s: DevSet, inp: DeviceOpInput, issued: number): Refusal {
  if (!usesActor(inp)) return '';
  const i = activeIdx(s, inp.actor); // dr1 refused an unknown actor; stay fail-closed on its own
  if (i < 0) return 'device_unknown';
  return s.act[i].matureAtMs > issued ? 'device_too_new' : '';
}

async function propose(s: DevSet, inp: DeviceOpInput): Promise<Refusal> {
  if (!inp.new) return 'malformed_for_op'; // #14–#16 are set on every proposing op (§2.5)
  if (inp.op === 'recover') {
    const bd = s.v.recovery_bind_digest;
    if (bd.length === 0 || !equalBytes(await sha384(inp.bind), bd)) return 'recovery_key_unbound';
    if (inp.outcome !== 'P') return 'wrong_state';
  }
  if (inp.outcome === 'P') {
    s.pend = { ...inp.new, matureAtMs: inp.proposingAnbMs };
    if (inp.op === 'recover') clearSlot(s);
  } else if (inp.outcome === 'D') {
    s.pend = null;
  } else {
    return 'wrong_state';
  }
  return '';
}

/** DR9 (a)/(b)'s bind and unbind, in the reference's order of cases. */
async function bind(
  s: DevSet,
  inp: DeviceOpInput,
  b: RecoveryBind,
  issued: number,
  delta: number
): Promise<Refusal> {
  if (b.kind === 'cancel') return 'wrong_state';
  if (b.chain_seq !== inp.head.seq) return 'stale_seq';
  if (!equalBytes(b.chain_entry_digest, inp.head.entryDigest)) return 'stale_head';
  if (!equalBytes(b.binding_root_digest, inp.head.rootDigest)) return 'wrong_state';
  const wait = waitMs(inp.bindWait, delta);
  const nb = wait === null ? null : addMs(issued, wait);
  if (nb === null) return 'wrong_state';
  const h = await sha384(inp.bind);
  const bound = s.v.recovery_key.length > 0;
  const slot = s.v.replacement_bind_digest.length > 0;
  const now = inp.bindWait === 'now';
  const pendingSlot = (key: Uint8Array): void => {
    s.v = { ...s.v, replacement_key: key, replacement_bind_digest: h, replacement_nb_ms: nb };
  };
  if (b.kind === 'unbind') {
    if (!bound) return 'wrong_state';
    if (inp.priorSig) {
      unbindKey(s);
      clearSlot(s);
    } else if (slot) {
      return 'wrong_state';
    } else if (now) {
      unbindKey(s);
    } else {
      pendingSlot(NONE);
    }
    return '';
  }
  if (inp.priorSig) {
    if (!bound) return 'wrong_state';
    s.v = { ...s.v, recovery_key: b.recovery_key, recovery_bind_digest: h };
    clearSlot(s);
  } else if (slot) {
    return 'wrong_state';
  } else if (now) {
    s.v = { ...s.v, recovery_key: b.recovery_key, recovery_bind_digest: h };
  } else {
    pendingSlot(b.recovery_key);
  }
  return '';
}

function cancel(s: DevSet, inp: DeviceOpInput, b: RecoveryBind): Refusal {
  const target = s.v.replacement_bind_digest;
  if (
    b.kind !== 'cancel' ||
    target.length === 0 ||
    (b.target_digest.length > 0 && !equalBytes(b.target_digest, target))
  )
    return 'wrong_state';
  const bound = s.v.recovery_key.length > 0;
  if (inp.rootForm) {
    if (bound || !equalBytes(b.recovery_key, s.v.replacement_key)) return 'wrong_state';
  } else if (!bound || !equalBytes(b.recovery_key, s.v.recovery_key)) {
    return 'recovery_key_unbound';
  }
  clearSlot(s);
  return '';
}

async function body(
  s: DevSet,
  inp: DeviceOpInput,
  b: RecoveryBind | null,
  issued: number,
  delta: number
): Promise<Refusal> {
  switch (inp.op) {
    case 'enroll_new':
      if (!inp.new) return 'malformed_for_op';
      s.act = [{ ...inp.new, matureAtMs: issued }];
      s.pend = null;
      return '';
    case 'enroll_existing':
    case 'replace_root':
    case 'recover':
      return propose(s, inp);
    case 'rotate_root':
    case 'rotate_ek':
      s.act = s.act.filter((e) => !inp.removed.includes(e.id));
      if (inp.op === 'rotate_root') clearSlot(s);
      return '';
    case 'unsuspend':
      return '';
    case 'add_device': {
      const m = addMs(issued, delta);
      if (m === null) return 'wrong_state';
      if (!inp.new) return 'malformed_for_op';
      s.act = [...s.act, { ...inp.new, matureAtMs: m }];
      return '';
    }
    // preCheck decoded B for both recovery ops, so b is set here.
    case 'bind_recovery':
      return b ? bind(s, inp, b, issued, delta) : 'wrong_state';
    case 'cancel_recovery_bind':
      return b ? cancel(s, inp, b) : 'wrong_state';
  }
  return 'wrong_state';
}

/**
 * The shared DR1, DR2, DR4–DR6 and DR9 (a), (b), (e) code (D-270). Returns the
 * set after the op and '', or null and the refusal. set is never empty: the
 * genesis set is emptyDeviceSet. Never throws.
 */
export async function applyDeviceOp(
  set: Uint8Array,
  inp: DeviceOpInput,
  issuedAtMs: number,
  deltaMs: number
): Promise<[Uint8Array | null, Refusal]> {
  try {
    const s = await parseSet(set);
    if (!s) return [null, 'wrong_state'];
    const [b, pr] = await preCheck(inp);
    const r =
      pr ||
      headGate(inp) ||
      (await dr1(s, inp)) ||
      dr4(s, inp, issuedAtMs) ||
      (inp.op === 'add_device' && s.act.length >= MAX_DEVICES ? 'device_limit' : '') ||
      (await body(s, inp, b, issuedAtMs, deltaMs));
    if (r !== '') return [null, r];
    const out = encodeSet(s);
    return out ? [out, ''] : [null, 'wrong_state'];
  } catch {
    return [null, 'wrong_state'];
  }
}

/** NormalizeDeviceSet's entry-less changes. */
export interface Normalize {
  activate?: boolean; // a new-root activation only; a Pe activation never passes it
  burnRecovery?: boolean;
  completeSlot?: boolean;
  clearPending?: boolean;
  emptySlot?: boolean;
}

/**
 * DR8 and DR9 (c): entry-less changes in the fixed order clearPending,
 * emptySlot, completeSlot, activate, burnRecovery (so a slot completes before
 * an activation burns it: C4-4's completion-first order; the caller passes
 * completeSlot false when the activation comes first). Null for a set that
 * does not decode. Never throws.
 */
export async function normalizeDeviceSet(
  set: Uint8Array,
  f: Normalize
): Promise<Uint8Array | null> {
  try {
    const s = await parseSet(set);
    if (!s) return null;
    if (f.clearPending) s.pend = null;
    if (f.emptySlot) clearSlot(s);
    if (f.completeSlot && s.v.replacement_bind_digest.length > 0) {
      if (s.v.replacement_key.length > 0)
        s.v = {
          ...s.v,
          recovery_key: s.v.replacement_key,
          recovery_bind_digest: s.v.replacement_bind_digest,
        };
      else unbindKey(s);
      clearSlot(s);
    }
    if (f.activate) {
      if (s.pend) {
        s.act = [s.pend];
        s.pend = null;
      }
      clearSlot(s);
    }
    if (f.burnRecovery) unbindKey(s);
    return encodeSet(s);
  } catch {
    return null;
  }
}

// Per-message position patterns the codec cannot express alone (design of
// record §2.6, §2.22; V2-04, LD-49, LD-53).

import { equalBytes } from './bytes';
import { decodeAs, type DeviceIntent, type RecoveryBind } from './messages';
import type { Reason } from './reason';

const set = (b: Uint8Array): boolean => b.length > 0;

/**
 * §2.22's per-kind positions of a recovery-bind B: '' or the authority's
 * `malformed_for_op`. A published bundle's B that fails it is malformed.
 *   bind:   expires 0, key set, target "", chain_seq ≥ 1, entry, root and escrow set.
 *   unbind: expires 0, key "", target "", chain_seq ≥ 1, entry and root set, escrow "".
 *   cancel: expires > 0, key set, target any, chain_seq 0, entry, root and escrow "".
 */
export function recoveryBindForKind(b: RecoveryBind): '' | 'malformed_for_op' {
  let ok = false;
  switch (b.kind) {
    case 'bind':
      ok =
        b.expires_at_ms === 0 &&
        set(b.recovery_key) &&
        !set(b.target_digest) &&
        b.chain_seq >= 1 &&
        set(b.chain_entry_digest) &&
        set(b.binding_root_digest) &&
        set(b.escrow_public_key);
      break;
    case 'unbind':
      ok =
        b.expires_at_ms === 0 &&
        !set(b.recovery_key) &&
        !set(b.target_digest) &&
        b.chain_seq >= 1 &&
        set(b.chain_entry_digest) &&
        set(b.binding_root_digest) &&
        !set(b.escrow_public_key);
      break;
    case 'cancel':
      ok =
        b.expires_at_ms > 0 &&
        set(b.recovery_key) &&
        b.chain_seq === 0 &&
        !set(b.chain_entry_digest) &&
        !set(b.binding_root_digest) &&
        !set(b.escrow_public_key);
      break;
  }
  return ok ? '' : 'malformed_for_op';
}

/**
 * §2.6's relay-recover envelope rule beyond the codec's form check: form R's
 * intent op is recover, form C's is cancel_pending, and form B's recovery_bind
 * is a cancel B.
 */
export async function checkRelayRecover(b: Uint8Array): Promise<Reason> {
  const r = await decodeAs('relay-recover', b);
  if (!r) return 'malformed';
  if (!set(r.intent)) {
    const rb = await decodeAs('recovery-bind', r.recovery_bind);
    return rb?.kind === 'cancel' ? 'ok' : 'malformed';
  }
  const inp = await decodeAs('intent', r.intent);
  const want = set(r.recovery_bind) ? 'recover' : 'cancel_pending';
  return inp?.op === want ? 'ok' : 'malformed';
}

/** One row of §2.5's per-op private table: the device-intent positions an op uses. */
interface DevicePart {
  newDevice: boolean; // #14–#16 all set; otherwise all ""
  actor: boolean; // #13 set, #11 ≥ 1 and #12 set; otherwise "", 0 and ""
  removed: boolean; // #17 may hold [0..9]; otherwise []
  bind: boolean; // #18 set; otherwise ""
  bindWait: boolean; // #19 is DR9's per-form rule; otherwise ""
  private: boolean; // a private op: #8 > 0. Attached: #8 = 0
}

const part = (p: Partial<DevicePart>): DevicePart => ({
  newDevice: false,
  actor: false,
  removed: false,
  bind: false,
  bindWait: false,
  private: false,
  ...p,
});

// cancel_recovery_bind is its root form: the sheet form carries no device-intent (LD-43).
const DEVICE_PARTS: Readonly<Record<string, DevicePart>> = Object.freeze({
  enroll_new: part({ newDevice: true }),
  enroll_existing: part({ newDevice: true }),
  replace_root: part({ newDevice: true }),
  recover: part({ newDevice: true }),
  rotate_root: part({ actor: true, removed: true }),
  rotate_ek: part({ actor: true, removed: true }),
  unsuspend: part({ actor: true }),
  add_device: part({ newDevice: true, actor: true, private: true }),
  bind_recovery: part({ actor: true, bind: true, bindWait: true, private: true }),
  cancel_recovery_bind: part({ actor: true, bind: true, private: true }),
});

const partOf = (op: string): DevicePart | undefined =>
  Object.hasOwn(DEVICE_PARTS, op) ? DEVICE_PARTS[op] : undefined;

/** A device op whose device part rides a published intent: every op but the three private ones. */
export const attachedOp = (op: string): boolean => partOf(op)?.private === false;

/** An op with an actor device (device-intent #13 required). */
export const actorOpName = (op: string): boolean => partOf(op)?.actor === true;

function positionsHold(p: DevicePart, di: DeviceIntent): boolean {
  const newAny = di.new_device_id !== '' || set(di.new_device_dsk) || set(di.new_device_dkx);
  const newAll = di.new_device_id !== '' && set(di.new_device_dsk) && set(di.new_device_dkx);
  return (
    newAll === p.newDevice &&
    newAny === newAll &&
    (di.actor_device_id !== '') === p.actor &&
    di.expected_dseq >= 1 === p.actor &&
    (di.expected_dseq === 0) === !set(di.expected_device_head) &&
    (di.removed_device_ids.length === 0 || p.removed) &&
    set(di.recovery_bind_digest) === p.bind &&
    (di.bind_wait === '' || p.bindWait) &&
    (di.expires_at_ms !== 0) === p.private
  );
}

/** §3.2.4 step 4: the new dsk, the new dkx and the candidate root pairwise distinct. */
function keysDistinct(p: DevicePart, di: DeviceIntent, candidateRoot: Uint8Array): boolean {
  if (!p.newDevice) return true;
  if (equalBytes(di.new_device_dsk, di.new_device_dkx)) return false;
  if (set(candidateRoot))
    return (
      !equalBytes(di.new_device_dsk, candidateRoot) && !equalBytes(di.new_device_dkx, candidateRoot)
    );
  return p.private; // every attached new-device op names a candidate root (§2.7)
}

/**
 * §2.5's per-op private table plus the pairwise-distinct keys: '' or
 * `malformed_for_op`. candidateRoot is the published intent's #12 for an
 * attached op and empty for a private one. #14 = DeviceID(#15) is DR1's.
 */
export function deviceIntentForOp(
  di: DeviceIntent,
  candidateRoot: Uint8Array
): '' | 'malformed_for_op' {
  const p = partOf(di.op);
  return p && positionsHold(p, di) && keysDistinct(p, di, candidateRoot) ? '' : 'malformed_for_op';
}

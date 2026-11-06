// Per-message position patterns the codec cannot express alone (design of
// record §2.6, §2.22; V2-04, LD-49, LD-53).

import { decodeAs, type RecoveryBind } from './messages';
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

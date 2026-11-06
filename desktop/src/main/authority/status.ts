// Status verification (design of record §2.12, §2.11 R5, §2.13).
//
// A status is verified in two parts, and only the second needs the caller's
// memory and clock:
//   - authenticStatus: an RSK-signed `status` under the HW delegation (T6) that
//     names this realm and account, keeps valid_until ≤ as_of + V_MAX, names
//     the verified head itself (chain_behind, fork) and passes R5. This is all a
//     retained fix (R4) needs.
//   - verifyStatus adds freshness and §2.13's state verdict on the effective
//     state, where the first-sight pin (D-149) and the accepted pin (LD-28) are
//     compared.
// Past genesis the head's pin is still compared with the first-sight pin in
// every state (RT-2): only that comparison stops a forged row-1 chain of a
// pinned account.
//
// Not ported here: R6's wrap target (`WrapKey`), which comes with the
// verified-recipient handle.

import { equalBytes } from './bytes';
import { EPSILON_MS, sumBelow, V_MAX_MS } from './constants';
import { headPub, segmentOf, type ChainHead } from './heads';
import { decodeAs, type Delegation, type Status } from './messages';
import { activate, type Pub } from './pub';
import type { Reason } from './reason';
import { effectiveOf, effectivePending, fixNames, fixStatus, checkR5 } from './replay';
import type { HighWater, Trust } from './trust';
import { checkT6 } from './trustcheck';

/** §2.12's freshness mode: new-secret requires as_of ≥ now − τ, history now ≤ valid_until. */
export type Use = 'new-secret' | 'history';

/** Exactly the three inputs the verifier reads of the caller's memory (§2.12). */
export interface AccountMemory {
  pin: Uint8Array; // the first-sight pin (D-149); empty for none
  everEnrolled: boolean;
  acceptedPin: Uint8Array; // LD-28: the pin accepted for the conversation being wrapped
}

/** A status's verdict. `pin` is the first-sight value to store (D-149) after an ok verdict. */
export interface VerifiedStatus {
  reason: Reason;
  status: Status | null;
  pin: Uint8Array;
  segment: string; // the effective root's segment assurance; "" with no root
  acceptedPin: boolean; // ok_accepted_pin: flag the member unverified (LD-28)
}

const NONE = new Uint8Array(0);

export const refused = (reason: Reason): VerifiedStatus => ({
  reason,
  status: null,
  pin: NONE,
  segment: '',
  acceptedPin: false,
});

/** A u millisecond instant the caller passed; 0 or anything not a u is the unset clock (Sec-N4). */
export const validNow = (nowMs: number): boolean => Number.isSafeInteger(nowMs) && nowMs > 0;

/** Decodes a signed status and checks T6. Reads nothing of the head. */
export async function signedStatus(
  t: Trust,
  hw: HighWater,
  signed: Uint8Array
): Promise<[Status | null, HighWater, Reason]> {
  const sg = await decodeAs('signed', signed);
  if (sg?.type !== 'status') return [null, hw, 'malformed']; // a device-status here is malformed (P1-e)
  const st = await decodeAs('status', sg.msg);
  if (!st) return [null, hw, 'malformed'];
  const [hw2, r] = await checkT6(
    t,
    hw,
    sg.msg,
    sg.sig_a,
    st.delegation_gen,
    st.delegation_serial,
    st.as_of_ms
  );
  return [st, hw2, r];
}

export interface Authentic {
  st: Status;
  hp: Pub;
  d: Delegation;
  hw: HighWater;
}

/** The part of status verification that needs neither the clock nor the caller's memory. */
export async function authenticStatus(
  t: Trust,
  hw: HighWater,
  head: ChainHead,
  signed: Uint8Array
): Promise<Authentic | Reason> {
  const halt = t.haltReason();
  if (halt !== 'ok') return halt;
  const [st, hw2, r] = await signedStatus(t, hw, signed);
  if (!st || r !== 'ok') return r;
  const d = t.lookup(st.delegation_gen, st.delegation_serial);
  if (!d) return 'delegation_unknown';
  if (st.realm_id !== t.realm || st.realm_id !== head.realm_id || st.account_id !== head.account_id)
    return 'realm_mismatch'; // B-SF1
  if (st.valid_until_ms <= st.as_of_ms || st.valid_until_ms - st.as_of_ms > V_MAX_MS)
    return 'malformed';
  const [hp, hr] = await headPub(head);
  if (hr !== 'ok') return hr;
  if (st.seq > hp.seq) return 'chain_behind';
  if (st.seq < hp.seq || !equalBytes(st.head_entry_digest, hp.entry)) return 'fork';
  const r5 = await checkR5(hp, st);
  return r5 === 'ok' ? { st, hp, d, hw: hw2 } : r5;
}

function freshness(st: Status, d: Delegation, nowMs: number, use: Use): Reason {
  if (st.as_of_ms > nowMs && st.as_of_ms - nowMs > EPSILON_MS) return 'status_future';
  if (use === 'new-secret')
    return sumBelow(st.as_of_ms, d.tau_ms, nowMs) ? 'status_stale_tau' : 'ok';
  if (use === 'history') return nowMs > st.valid_until_ms ? 'status_expired' : 'ok';
  return 'malformed';
}

/** §2.13's absent path: D-149's first-sight pin and LD-28's accepted pin. */
function absentVerdict(st: Status, mem: AccountMemory, d: Delegation, use: Use): Reason {
  const pin = st.legacy_ek_digest;
  if (mem.everEnrolled) return 'absent_after_enrolled';
  if (pin.length === 0) return 'absent_unpinned';
  if (st.legacy_pin_revoked === 1) return 'pin_revoked';
  if (d.cutover_at_ms !== 0 && st.as_of_ms >= d.cutover_at_ms) return 'absent_after_cutover';
  if (mem.pin.length === 0 || equalBytes(mem.pin, pin)) return 'ok';
  if (use === 'new-secret' && equalBytes(mem.acceptedPin, pin)) return 'ok_accepted_pin';
  return 'pin_changed';
}

/** §2.13 on an effective pending head: only a continuity change pending from absent is ok. */
function pendingVerdict(eff: Pub): Reason {
  if (eff.pendRoot.length === 0) return 'pending_erase';
  if (eff.prior === 'active') return 'pending_from_active';
  if (eff.prior === 'suspended') return 'pending_from_suspended';
  if (eff.prior !== 'absent') return 'malformed';
  if (eff.assurance !== 'continuity' || eff.pin.length === 0 || eff.pinRevoked === 1)
    return 'pending_from_absent';
  return 'ok';
}

/** §2.13 on the effective state; a changed pin is reported before held (NEW-2). */
function stateVerdict(eff: Pub, st: Status, mem: AccountMemory, d: Delegation, use: Use): Reason {
  if (eff.state !== 'absent' && mem.pin.length > 0 && !equalBytes(mem.pin, eff.pin))
    return 'pin_changed';
  if (st.held === 1) {
    return eff.state === 'absent' && absentVerdict(st, mem, d, use) === 'pin_changed'
      ? 'pin_changed'
      : 'held';
  }
  switch (eff.state) {
    case 'absent':
      return absentVerdict(st, mem, d, use);
    case 'active':
      return 'ok';
    case 'suspended':
      return eff.rootRevoked === 1 ? 'root_revoked' : 'suspended';
    case 'disputed':
      return 'disputed';
    case 'erased':
      return 'erased';
    case 'pending':
      return pendingVerdict(eff);
  }
  return 'malformed';
}

/** Status verification at a validated nowMs; the HW returned is unchanged on any refusal. */
export async function verifyStatusAt(
  t: Trust,
  hw: HighWater,
  head: ChainHead,
  signed: Uint8Array,
  mem: AccountMemory,
  nowMs: number,
  use: Use
): Promise<[VerifiedStatus, HighWater]> {
  const a = await authenticStatus(t, hw, head, signed);
  if (typeof a === 'string') return [refused(a), hw];
  const { st, hp } = a;
  const fr = freshness(st, a.d, nowMs, use);
  if (fr !== 'ok') return [refused(fr), hw];
  let eff = effectiveOf(hp, st);
  // R4 on a status (N-2): once the retained fix shows the raw pending head
  // activated, a status that shows it pending again (not held) does not undo it.
  const fix = await fixStatus(head.fix);
  if (
    fix !== 'malformed' &&
    fixNames(fix, hp) &&
    !effectivePending(hp, fix) &&
    st.held === 0 &&
    effectivePending(hp, st)
  )
    eff = activate(hp);
  let segment = await segmentOf(head, eff.root);
  if (segment === '' && hp.state === 'pending' && eff.state !== 'pending') segment = hp.assurance; // recorded only by the next result
  const reason = stateVerdict(eff, st, mem, a.d, use);
  return [
    {
      reason,
      status: st,
      pin: st.legacy_ek_digest,
      segment,
      acceptedPin: reason === 'ok_accepted_pin',
    },
    a.hw,
  ];
}

/**
 * Verifies a signed status against a verified head (§2.12): head must come
 * from parseChainHead or an earlier verification. nowMs is the caller's clock
 * in ms; 0 or anything not a u is malformed (Sec-N4). Never throws.
 */
export async function verifyStatus(
  t: Trust,
  hw: HighWater,
  head: ChainHead,
  signed: Uint8Array,
  mem: AccountMemory,
  nowMs: number,
  use: Use
): Promise<[VerifiedStatus, HighWater]> {
  if (!validNow(nowMs)) return [refused('malformed'), hw];
  try {
    return await verifyStatusAt(t, hw, head, signed, mem, nowMs, use);
  } catch {
    return [refused('malformed'), hw];
  }
}

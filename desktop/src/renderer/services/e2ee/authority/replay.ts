// The replay rules R1–R5 (design of record §2.11).
//
// R1 and R2 read only the result, its intent, its cp-authz and its delegation,
// so they run once, before R3. R3 never lets a result choose between "the
// pending change has not activated" (H_pend) and "it activated" (H_act): it
// must match exactly one. R4 only removes a hypothesis, never adds one. R5 pins
// every derivable field of a status to the verified head, so an RSK chooses only
// as_of, valid_until, held and the extension part of anb.

import { equalBytes } from './bytes';
import { addMs, ANB_NEVER, CANCEL_SLACK_MS, EPSILON_MS, INTENT_WINDOW_MS, sumBelow } from './constants';
import {
  decodeAs,
  digestOrEmpty,
  encodeAs,
  type CpAuthz,
  type Delegation,
  type Intent,
  type Result,
  type Status,
} from './messages';
import { activate, type Pub } from './pub';
import type { Reason } from './reason';

/**
 * R1 (client): asserted_at − ε ≤ issued_at, the op's upper bound, and issued
 * never decreasing along the chain. gMs is the g_ms of the result's delegation.
 */
export function checkIssued(
  prevIssued: number,
  r: Result,
  inp: Intent,
  a: CpAuthz,
  gMs: number
): Reason {
  if (r.issued_at_ms < prevIssued || sumBelow(r.issued_at_ms, EPSILON_MS, a.asserted_at_ms))
    return 'issued_bounds';
  if (r.op === 'cancel_pending') {
    const hi = addMs(a.asserted_at_ms, gMs, CANCEL_SLACK_MS);
    if (hi === null || r.issued_at_ms >= hi || inp.expires_at_ms <= a.asserted_at_ms)
      return 'issued_bounds';
    return 'ok';
  }
  const hi = addMs(a.asserted_at_ms, INTENT_WINDOW_MS) ?? Number.MAX_SAFE_INTEGER;
  return r.issued_at_ms >= Math.min(inp.expires_at_ms, hi) ? 'issued_bounds' : 'ok';
}

/**
 * R2: a pending result carries exactly asserted_at + delta_ms + g_ms of its
 * delegation; any other result carries 0. A sum above 2^53 − 1 is anb_mismatch.
 */
export function checkANB(r: Result, a: CpAuthz, d: Delegation): Reason {
  if (r.state !== 'pending') return r.activation_not_before_ms === 0 ? 'ok' : 'anb_mismatch';
  const want = addMs(a.asserted_at_ms, d.delta_ms, d.g_ms);
  return want !== null && r.activation_not_before_ms === want ? 'ok' : 'anb_mismatch';
}

/** One R3 hypothesis for the from-state of the next result. */
export interface Hyp {
  p: Pub;
  act: boolean; // H_act: the derived activation of a pending prev
}

/** R3: {prev}, unless prev is raw pending and issued ≥ its anb: then {H_pend, H_act}. */
export function hypotheses(prev: Pub, issued: number): Hyp[] {
  if (prev.state !== 'pending' || issued < prev.anb) return [{ p: prev, act: false }];
  return [
    { p: prev, act: false },
    { p: activate(prev), act: true },
  ];
}

/**
 * R3's "exactly one": one hypothesis reports its own Reason; of two, exactly
 * one ok selects it, and zero or two are hypothesis_conflict. The index is −1
 * whenever the Reason is not ok.
 */
export function pickMatch(rs: Reason[]): [number, Reason] {
  if (rs.length === 1) return rs[0] === 'ok' ? [0, 'ok'] : [-1, rs[0]];
  const oks = rs.flatMap((r, i) => (r === 'ok' ? [i] : []));
  return oks.length === 1 ? [oks[0], 'ok'] : [-1, 'hypothesis_conflict'];
}

/** R5's: raw pending ∧ (held ∨ as_of < status.anb). */
export const effectivePending = (head: Pub, s: Status): boolean =>
  head.state === 'pending' && (s.held === 1 || s.as_of_ms < s.activation_not_before_ms);

/** The effective state a status describes. */
export const effectiveOf = (head: Pub, s: Status): Pub =>
  head.state === 'pending' && !effectivePending(head, s) ? activate(head) : head;

/** A retained fix names p: same seq and head entry, p raw pending (R4). */
export const fixNames = (fix: Status | null, p: Pub): fix is Status =>
  fix !== null && p.state === 'pending' && fix.seq === p.seq && equalBytes(fix.head_entry_digest, p.entry);

/**
 * R4: a fix showing prev pending at T admits only H_pend for issued ≤ T; one
 * showing it activated at T admits only H_act for issued ≥ T. A fix for
 * another head, or for a head that is not raw pending, constrains nothing.
 */
export function fixAllows(fix: Status | null, prev: Pub, issued: number, act: boolean): boolean {
  if (!fixNames(fix, prev)) return true;
  const pending = effectivePending(prev, fix);
  if (pending && issued <= fix.as_of_ms) return !act;
  if (!pending && issued >= fix.as_of_ms) return act;
  return true;
}

/** A retained fix's status; null for none ("") and for one that does not decode. */
export async function fixStatus(b: Uint8Array): Promise<Status | null | 'malformed'> {
  if (b.length === 0) return null;
  const sg = await decodeAs('signed', b);
  if (sg?.type !== 'status') return 'malformed';
  return (await decodeAs('status', sg.msg)) ?? 'malformed';
}

/** Derive(H, s) over the R5-compared fields; s supplies the exempt ones. */
async function derivedFields(p: Pub, s: Status): Promise<Status> {
  return {
    realm_id: s.realm_id,
    account_id: s.account_id,
    seq: p.seq,
    head_entry_digest: p.entry,
    state: p.state,
    prior_state: p.prior,
    suspended_by: p.susp,
    active_root_digest: await digestOrEmpty(p.root),
    root_revoked: p.rootRevoked,
    ek_binding_digest: p.ek,
    pending_root_digest: await digestOrEmpty(p.pendRoot),
    pending_ek_binding_digest: p.pendEK,
    legacy_ek_digest: p.seq === 0 ? s.legacy_ek_digest : p.pin, // D-149: the seq-0 pin is set or ""
    legacy_pin_revoked: p.pinRevoked,
    activation_not_before_ms: s.activation_not_before_ms,
    held: s.held,
    as_of_ms: s.as_of_ms,
    valid_until_ms: s.valid_until_ms,
    delegation_gen: s.delegation_gen,
    delegation_serial: s.delegation_serial,
  };
}

/**
 * R5's anb rules and equality for a status naming head. Equality is over the
 * canonical encodings, so a status that does not encode is field_mismatch.
 */
export async function checkR5(head: Pub, s: Status): Promise<Reason> {
  if (head.state === 'pending') {
    if (effectivePending(head, s)) {
      if (
        (s.held === 1) !== (s.activation_not_before_ms === ANB_NEVER) ||
        s.activation_not_before_ms < head.anb
      ) {
        return 'anb_mismatch';
      }
    } else if (s.activation_not_before_ms !== 0 || s.as_of_ms < head.anb) {
      return 'anb_mismatch';
    }
  } else if (s.activation_not_before_ms !== 0) {
    return 'anb_mismatch';
  }
  const want = encodeAs('status', await derivedFields(effectiveOf(head, s), s));
  const got = encodeAs('status', s);
  return want !== null && got !== null && equalBytes(want, got) ? 'ok' : 'field_mismatch';
}

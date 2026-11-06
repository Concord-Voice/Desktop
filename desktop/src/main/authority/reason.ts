// §2.12 verification outcomes and their §2.13 verdicts. The Reason strings are
// contract: the vectors carry them and every implementation returns them.

/** §2.12's per-member outcome class. */
export type Verdict = 'ok' | 'transient' | 'withhold' | 'refuse-op' | 'halt';

interface ReasonClass {
  readonly verdict: Verdict;
  readonly notice: boolean;
}

const c = (verdict: Verdict, notice = false): ReasonClass => Object.freeze({ verdict, notice });

/** Every Reason with its verdict and §2.12 notice column. */
export const REASONS = Object.freeze({
  ok: c('ok'),
  ok_accepted_pin: c('ok'), // LD-28: ok, flagged unverified
  network: c('transient'), // the caller's; the verifier never returns it
  status_stale_tau: c('transient'),
  superseded_uncovered: c('transient'),
  status_expired: c('transient'),
  chain_behind: c('transient'),
  delegation_unknown: c('transient'),
  // The paused family: withhold, no notice, clears itself.
  suspended: c('withhold'),
  disputed: c('withhold'),
  held: c('withhold'),
  erased: c('withhold'),
  pending_erase: c('withhold'),
  root_revoked: c('withhold'),
  pending_from_active: c('withhold'),
  pending_from_suspended: c('withhold'),
  pending_from_absent: c('withhold'),
  pin_revoked: c('withhold'),
  // Withhold with a notice.
  fork: c('withhold', true),
  hypothesis_conflict: c('withhold', true),
  field_mismatch: c('withhold', true),
  anb_mismatch: c('withhold', true),
  issued_bounds: c('withhold', true),
  pin_changed: c('withhold', true),
  // Withhold, no notice, needs attention.
  malformed: c('withhold'),
  bad_signature: c('withhold'),
  cak_unlisted: c('withhold'),
  transition_invalid: c('withhold'),
  chain_gap: c('withhold'),
  head_mismatch: c('withhold'),
  status_future: c('withhold'),
  absent_unpinned: c('withhold'),
  absent_after_cutover: c('withhold'),
  absent_after_enrolled: c('withhold'),
  delegation_window: c('withhold'),
  out_of_scope: c('withhold'),
  status_superseded: c('withhold'),
  realm_mismatch: c('withhold'),
  trust_halt: c('halt', true), // T4: realm-wide refuse-op
  sender_side: c('refuse-op'), // the caller's own key or state; never returned by the verifier
  // Own-device reasons (LD-32): the private-ledger verifiers only.
  device_behind: c('transient'),
  device_status_stale: c('transient'),
  device_status_mismatch: c('withhold'),
  device_gap: c('withhold', true),
  device_fork: c('withhold', true),
  device_rule: c('withhold', true),
  wrap_invalid: c('withhold'),
} satisfies Record<string, ReasonClass>);

export type Reason = keyof typeof REASONS;

const isReason = (r: string): r is Reason => Object.hasOwn(REASONS, r);

/** §2.12's verdict for a Reason. An unknown Reason fails closed as withhold. */
export const verdictOf = (r: string): Verdict => (isReason(r) ? REASONS[r].verdict : 'withhold');

/** §2.12's notice column: the member glyph plus a local diagnostics event. */
export const noticeOf = (r: string): boolean => isReason(r) && REASONS[r].notice;

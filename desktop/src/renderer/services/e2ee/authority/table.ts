// §2.9's transition table, rows 1–22: the client-checkable columns only. The
// authority-only columns (floors, held, force_unverified, N_cancel) are not
// ported; `popNotIn` is the one population fact a co-member checks (row 1).

import type { FromCode } from './pub';

/** A From-column predicate a code alone does not express. */
export type Guard =
  | 'none'
  | 'userNotInSet' // row 7
  | 'userInSetUnrevoked' // row 9
  | 'opInSetUnrevoked' // row 10
  | 'priorAbsent' // row 4
  | 'priorActiveOrSusp' // row 12
  | 'rootUnrevoked' // row 13: a root exists and root_revoked = 0
  | 'livePinPriorAbsent' // row 14
  | 'priorNotAbsent' // row 16
  | 'absentPrior'; // row 17: Ap, or P/D with prior absent

/** The Required-signatures column as flags. */
export const SIG = Object.freeze({
  candidate: 1 << 0, // sig_candidate under intent candidate_root
  ekByCandidate: 1 << 1, // ek_binding signed by the candidate
  ekByCurrent: 1 << 2, // ek_binding signed by the head's active root
  pop: 1 << 3, // legacy_pop_sig and legacy_spki
  current: 1 << 4, // sig_current_root under the head's active root
  operator: 1 << 5, // sig_operator under T12
  recovery: 1 << 6, // sig_recovery under B.recovery_key (recover)
  bindProof: 1 << 7, // recovery_bind and recovery_bind_sig (§2.22)
  pendingRecovery: 1 << 8, // sig_recovery under the chain-head pending_recovery_key (row 21)
  heldStatus: 1 << 9, // held_status (row 22)
});

/** The To column. */
export type ToRule =
  | 'enrollActive' // row 1
  | 'pendOrDisp' // rows 2, 3, 11: P(from) or D(from)
  | 'dispBurn' // rows 4, 12: D(x), the competitor's candidate burned
  | 'rotateRoot' // row 5
  | 'rotateEK' // row 6
  | 'suspendAdd' // rows 7, 8
  | 'unsuspend' // rows 9, 10
  | 'restore' // rows 13, 21, 22: exactly x
  | 'ap' // row 14
  | 'sor' // rows 15, 16
  | 'apr' // row 17
  | 'pendErase' // row 18
  | 'erased' // row 19
  | 'pr'; // row 20

/** The Allowed-assurance column. */
export type AssureRule = 'initial' | 'row2' | 'row3' | 'segment' | 'empty' | 'row11' | 'row20';

export interface Row {
  readonly n: number;
  readonly op: string;
  readonly actor: string;
  readonly from: readonly FromCode[];
  readonly guard: Guard;
  readonly sigs: number;
  readonly optSigs: number;
  readonly to: ToRule;
  readonly deltaRG: number;
  readonly assure: AssureRule;
  readonly popNotIn: boolean;
}

const ANY_BUT_PE_PR_E: FromCode[] = ['A0', 'Ap', 'Apr', 'Ac', 'Su', 'So', 'Sor', 'P', 'D'];
const ANY_BUT_PR_E: FromCode[] = [...ANY_BUT_PE_PR_E, 'Pe'];
const ANY_BUT_E: FromCode[] = ['Ac', 'Su', 'So', 'Sor', 'P', 'D', 'Pe', 'Pr'];

const S = SIG;

function row(
  n: number,
  op: string,
  actor: string,
  from: FromCode[],
  sigs: number,
  to: ToRule,
  deltaRG: number,
  assure: AssureRule,
  extra: Partial<Pick<Row, 'guard' | 'optSigs' | 'popNotIn'>> = {}
): Row {
  return Object.freeze({
    n,
    op,
    actor,
    from: Object.freeze(from),
    guard: extra.guard ?? 'none',
    sigs,
    optSigs: extra.optSigs ?? 0,
    to,
    deltaRG,
    assure,
    popNotIn: extra.popNotIn ?? false,
  });
}

/** Rows 1–22 in order. */
export const ROWS: readonly Row[] = Object.freeze([
  row(1, 'enroll_new', 'user', ['A0'], S.candidate | S.ekByCandidate, 'enrollActive', 0, 'initial', {
    popNotIn: true,
  }),
  row(2, 'enroll_existing', 'user', ['Ap'], S.candidate | S.ekByCandidate | S.pop, 'pendOrDisp', 1, 'row2'),
  row(3, 'enroll_existing', 'user', ['Ap', 'Apr'], S.candidate | S.ekByCandidate, 'pendOrDisp', 1, 'row3'),
  row(4, 'enroll_existing', 'user', ['P', 'D'], S.candidate | S.ekByCandidate, 'dispBurn', 1, 'empty', {
    guard: 'priorAbsent',
    optSigs: S.pop,
  }),
  row(5, 'rotate_root', 'user', ['Ac'], S.candidate | S.ekByCandidate | S.current, 'rotateRoot', 0, 'segment'),
  row(6, 'rotate_ek', 'user', ['Ac'], S.current | S.ekByCurrent, 'rotateEK', 0, 'empty'),
  row(7, 'suspend', 'user', ['Ac', 'So', 'Sor'], 0, 'suspendAdd', 0, 'empty', { guard: 'userNotInSet' }),
  row(8, 'suspend', 'operator', ['Ac', 'Su'], S.operator, 'suspendAdd', 0, 'empty'),
  row(9, 'unsuspend', 'user', ['Su', 'So'], S.current, 'unsuspend', 0, 'empty', {
    guard: 'userInSetUnrevoked',
  }),
  row(10, 'unsuspend', 'operator', ['So'], S.operator, 'unsuspend', 0, 'empty', {
    guard: 'opInSetUnrevoked',
  }),
  row(11, 'replace_root', 'user', ['Ac', 'Su', 'Sor'], S.candidate | S.ekByCandidate, 'pendOrDisp', 1, 'row11'),
  row(12, 'replace_root', 'user', ['P', 'D'], S.candidate | S.ekByCandidate, 'dispBurn', 1, 'empty', {
    guard: 'priorActiveOrSusp',
  }),
  row(13, 'cancel_pending', 'user', ['P', 'D', 'Pe'], S.current, 'restore', 1, 'empty', {
    guard: 'rootUnrevoked',
  }),
  row(14, 'cancel_pending', 'user', ['P', 'D', 'Pe'], S.pop, 'ap', 1, 'empty', {
    guard: 'livePinPriorAbsent',
  }),
  row(15, 'revoke_root', 'operator', ['Ac', 'Su', 'So'], S.operator, 'sor', 1, 'empty'),
  row(16, 'revoke_root', 'operator', ['P', 'D'], S.operator, 'sor', 1, 'empty', { guard: 'priorNotAbsent' }),
  row(17, 'revoke_root', 'operator', ['Ap', 'P', 'D'], S.operator, 'apr', 1, 'empty', { guard: 'absentPrior' }),
  row(18, 'erase', 'user', ANY_BUT_PE_PR_E, 0, 'pendErase', 1, 'empty'),
  row(19, 'erase', 'operator', ANY_BUT_PR_E, S.operator, 'erased', 0, 'empty'),
  row(
    20,
    'recover',
    'user',
    ANY_BUT_E,
    S.candidate | S.ekByCandidate | S.recovery | S.bindProof,
    'pr',
    1,
    'row20'
  ),
  row(21, 'cancel_pending', 'user', ['Pr'], S.pendingRecovery, 'restore', 1, 'empty'),
  row(22, 'cancel_pending', 'restore', ['P', 'D', 'Pr'], S.heldStatus, 'restore', 1, 'empty'),
]);

/** Row n, or null outside 1–22. */
export const rowByN = (n: number): Row | null =>
  Number.isInteger(n) && n >= 1 && n <= ROWS.length ? ROWS[n - 1] : null;

/** Every row of one (op, actor), in table order. */
export const rowsFor = (op: string, actor: string): Row[] =>
  ROWS.filter((r) => r.op === op && r.actor === actor);

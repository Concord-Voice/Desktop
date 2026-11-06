// The row interpreter: §2.7's intent positions and §2.9's client-checkable
// columns, which is everything a co-member checks about a transition.
//
// A co-member accepts result n+1 from hypothesis f only when exactly the rows
// of (intent op, cp-authz actor) are considered and one admits f's code, guard
// and the bundle's signature positions (required ⊆ present ⊆ required ∪
// optional, a half-present two-part position never admitted); every intent
// position the op does not use is ""; the head-bound positions equal f; and the
// result's post-state, recovery_gen, pin and assurance are the row's.

import { equalBytes } from './bytes';
import { capAt, knownSegment, rank, segmentRule } from './assurance';
import { digestOrEmpty, type Bundle, type Intent, type Result } from './messages';
import { classify, sameSet, withoutSet, withSet, xOf, type FromCode, type Pub } from './pub';
import type { Reason } from './reason';
import { rowsFor, SIG, type Guard, type Row } from './table';

/** Which signature-bearing bundle positions are non-empty. */
export const P = Object.freeze({
  candidate: 1 << 0,
  current: 1 << 1,
  operator: 1 << 2,
  recovery: 1 << 3,
  pop: 1 << 4,
  ek: 1 << 5,
  bindProof: 1 << 6,
  held: 1 << 7,
  half: 1 << 8, // a two-part position with one part missing: no row admits it
});

const pair = (a: Uint8Array, b: Uint8Array, full: number): number => {
  if (a.length > 0 && b.length > 0) return full;
  return a.length > 0 || b.length > 0 ? P.half : 0;
};

export function presenceOf(b: Bundle): number {
  let p = 0;
  if (b.sig_candidate.length > 0) p |= P.candidate;
  if (b.sig_current_root.length > 0) p |= P.current;
  if (b.sig_operator.length > 0) p |= P.operator;
  if (b.sig_recovery.length > 0) p |= P.recovery;
  if (b.held_status.length > 0) p |= P.held;
  return (
    p |
    pair(b.legacy_pop_sig, b.legacy_spki, P.pop) |
    pair(b.ek_binding, b.ek_binding_sig, P.ek) |
    pair(b.recovery_bind, b.recovery_bind_sig, P.bindProof)
  );
}

const REQUIRED: readonly (readonly [number, number])[] = Object.freeze([
  [SIG.candidate, P.candidate],
  [SIG.current, P.current],
  [SIG.operator, P.operator],
  [SIG.recovery, P.recovery],
  [SIG.pendingRecovery, P.recovery],
  [SIG.pop, P.pop],
  [SIG.ekByCandidate, P.ek],
  [SIG.ekByCurrent, P.ek],
  [SIG.bindProof, P.bindProof],
  [SIG.heldStatus, P.held],
] as const);

/** A row's signature column mapped onto bundle positions. */
const required = (s: number): number =>
  REQUIRED.reduce((p, [sig, pos]) => ((s & sig) !== 0 ? p | pos : p), 0);

/** The From-column guard g over f. A guard the table does not define holds nowhere. */
function guardHolds(g: Guard, f: Pub): boolean {
  switch (g) {
    case 'none':
      return true;
    case 'userNotInSet':
      return !f.susp.includes('user');
    case 'userInSetUnrevoked':
      return f.susp.includes('user') && f.rootRevoked === 0;
    case 'opInSetUnrevoked':
      return f.susp.includes('operator') && f.rootRevoked === 0;
    case 'priorAbsent':
      return f.prior === 'absent';
    case 'priorActiveOrSusp':
      return f.prior === 'active' || f.prior === 'suspended';
    case 'rootUnrevoked':
      return f.root.length > 0 && f.rootRevoked === 0;
    case 'livePinPriorAbsent':
      return f.prior === 'absent' && f.pin.length > 0 && f.pinRevoked === 0;
    case 'priorNotAbsent':
      return f.prior !== 'absent';
    case 'absentPrior':
      return f.state === 'absent' || f.prior === 'absent';
  }
  return false;
}

function rowAdmits(r: Row, code: FromCode, f: Pub, p: number): boolean {
  if (!r.from.includes(code) || !guardHolds(r.guard, f)) return false;
  const req = required(r.sigs);
  const opt = required(r.optSigs);
  return (p & req) === req && (p & ~(req | opt)) === 0;
}

/**
 * The unique row whose From, guard and signature pattern admit the bundle. No
 * row, or two (a table defect, refused rather than settled by order), is
 * transition_invalid.
 */
export function selectRow(f: Pub, op: string, actor: string, p: number): Row | null {
  const code = classify(f);
  const found = rowsFor(op, actor).filter((r) => rowAdmits(r, code, f, p));
  return found.length === 1 ? found[0] : null;
}

type Need = 'empty' | 'req' | 'iff';

function posOK(n: Need, b: Uint8Array, flag: boolean): boolean {
  if (n === 'req') return b.length > 0;
  if (n === 'iff') return b.length > 0 === flag;
  return b.length === 0;
}

// §2.7's table: candidate_root, ek_binding_digest, legacy_ek_digest,
// predecessor_root_digest, device_intent_digest, recovery_bind_digest.
type Needs = readonly [Need, Need, Need, Need, Need, Need];

function intentNeeds(op: string, actor: string): Needs | null {
  switch (op) {
    case 'enroll_new':
      return ['req', 'req', 'empty', 'empty', 'req', 'empty'];
    case 'enroll_existing':
      return ['req', 'req', 'iff', 'empty', 'req', 'empty'];
    case 'rotate_root':
    case 'replace_root':
      return ['req', 'req', 'empty', 'req', 'req', 'empty'];
    case 'rotate_ek':
      return ['empty', 'req', 'empty', 'req', 'req', 'empty'];
    case 'unsuspend':
      return ['empty', 'empty', 'empty', 'req', actor === 'user' ? 'req' : 'empty', 'empty'];
    case 'recover':
      return ['req', 'req', 'empty', 'req', 'req', 'req'];
    case 'cancel_pending':
      return ['empty', 'empty', 'iff', 'iff', 'empty', 'empty'];
    case 'suspend':
    case 'revoke_root':
    case 'erase':
      return ['empty', 'empty', 'empty', 'empty', 'empty', 'empty'];
  }
  return null;
}

/**
 * §2.7's position pattern (V-18): '' when the intent's positions fit its op,
 * else the authority's refusal `malformed_for_op` (a co-member reports
 * transition_invalid). pop: a PoP accompanies the op; rootCancels: a
 * cancel_pending the root signs.
 */
export function intentForOp(
  inp: Intent,
  actor: string,
  pop: boolean,
  rootCancels: boolean
): '' | 'malformed_for_op' {
  const n = intentNeeds(inp.op, actor);
  const ok =
    n !== null &&
    posOK(n[0], inp.candidate_root, false) &&
    posOK(n[1], inp.ek_binding_digest, false) &&
    posOK(n[2], inp.legacy_ek_digest, pop) &&
    posOK(n[3], inp.predecessor_root_digest, rootCancels) &&
    posOK(n[4], inp.device_intent_digest, false) &&
    posOK(n[5], inp.recovery_bind_digest, false);
  return ok ? '' : 'malformed_for_op';
}

/** The intent's head-bound positions against hypothesis f (§2.7, decision A4, "= pin iff PoP"). */
export async function checkIntentValues(row: Row, f: Pub, inp: Intent): Promise<Reason> {
  if (row.op !== inp.op) return 'transition_invalid';
  if (
    inp.expected_seq !== f.seq ||
    inp.expected_recovery_gen !== f.rg ||
    !equalBytes(inp.expected_head_digest, f.entry)
  ) {
    return 'transition_invalid';
  }
  if (
    inp.predecessor_root_digest.length > 0 &&
    !equalBytes(inp.predecessor_root_digest, await digestOrEmpty(f.root))
  ) {
    return 'transition_invalid';
  }
  if (inp.legacy_ek_digest.length > 0 && !equalBytes(inp.legacy_ek_digest, f.pin))
    return 'transition_invalid';
  return 'ok';
}

/** One bundle as the interpreter sees it. */
export interface RowCtx {
  inp: Intent;
  res: Result;
  outcomeP: boolean; // the P (not the D) outcome of rows 2, 3, 11
  segment: string; // the current segment's assurance (root_index record of f.root)
  bindingSegment: string; // row 20: the binding segment's (§2.22 check 5)
}

interface Want {
  state: string;
  prior: string;
  susp: readonly string[];
  root: Uint8Array;
  ek: Uint8Array;
  rootRevoked: number;
  pendRoot: Uint8Array;
  pendEK: Uint8Array;
  pinRevoked: number;
}

const NONE = new Uint8Array(0);

const setOfX = (f: Pub): string[] => (xOf(f) === 'suspended' ? f.susp : []);

/** The post-state a row's To rule permits. */
function expected(row: Row, f: Pub, c: RowCtx): Want {
  const base: Want = {
    state: f.state,
    prior: '',
    susp: f.susp,
    root: f.root,
    ek: f.ek,
    rootRevoked: f.rootRevoked,
    pendRoot: NONE,
    pendEK: NONE,
    pinRevoked: f.pinRevoked,
  };
  const fresh = (root: Uint8Array, ek: Uint8Array): Want => ({
    ...base,
    state: 'active',
    susp: [],
    root,
    ek,
    rootRevoked: 0,
  });
  switch (row.to) {
    case 'enrollActive':
    case 'rotateRoot':
      return fresh(c.inp.candidate_root, c.inp.ek_binding_digest);
    case 'rotateEK':
      return fresh(f.root, c.inp.ek_binding_digest);
    case 'pendOrDisp':
      return c.outcomeP
        ? {
            ...base,
            state: 'pending',
            prior: f.state,
            susp: setOfX(f),
            pendRoot: c.inp.candidate_root,
            pendEK: c.inp.ek_binding_digest,
          }
        : { ...base, state: 'disputed', prior: f.state, susp: setOfX(f) };
    case 'dispBurn':
      return { ...base, state: 'disputed', prior: f.prior, susp: setOfX(f) };
    case 'suspendAdd':
      return { ...base, state: 'suspended', susp: withSet(f.susp, row.actor) };
    case 'unsuspend': {
      const susp = withoutSet(f.susp, row.actor);
      return { ...base, susp, state: susp.length === 0 ? 'active' : 'suspended' };
    }
    case 'restore':
      return { ...base, state: f.prior, susp: f.prior === 'suspended' ? f.susp : [] };
    case 'ap':
      return {
        ...base,
        state: 'absent',
        susp: [],
        root: NONE,
        ek: NONE,
        rootRevoked: 0,
        pinRevoked: 0,
      };
    case 'apr':
      return {
        ...base,
        state: 'absent',
        susp: [],
        root: NONE,
        ek: NONE,
        rootRevoked: 0,
        pinRevoked: 1,
      };
    case 'sor':
      return { ...base, state: 'suspended', susp: withSet(setOfX(f), 'operator'), rootRevoked: 1 };
    case 'pendErase':
      return { ...base, state: 'pending', prior: xOf(f), susp: setOfX(f) };
    case 'erased':
      return { ...base, state: 'erased', susp: [] };
    case 'pr':
      return {
        ...base,
        state: 'pending',
        prior: xOf(f),
        susp: setOfX(f),
        pendRoot: c.inp.candidate_root,
        pendEK: c.inp.ek_binding_digest,
      };
  }
  return { ...base, state: '' }; // a To rule the table does not define admits nothing
}

const capped = (vals: string[], limit: string): string[] =>
  vals.filter((v) => rank(v) <= rank(limit));

/** The Allowed-assurance column for this outcome; every segment read passes through knownSegment. */
function allowedAssurance(row: Row, f: Pub, c: RowCtx): string[] {
  if (!c.outcomeP && row.to === 'pendOrDisp') return [''];
  switch (row.assure) {
    case 'initial':
      return ['initial'];
    case 'row2':
      return ['continuity'];
    case 'row3':
      return f.pinRevoked === 1 ? ['unverified'] : ['recovery', 'unverified'];
    case 'segment':
      return [segmentRule(knownSegment(c.segment))];
    case 'row11':
      if (classify(f) === 'Sor') return ['unverified'];
      return capped(['recovery', 'unverified'], knownSegment(c.segment));
    case 'row20':
      return capped(['recovery', 'unverified'], capAt('recovery', knownSegment(c.bindingSegment)));
  }
  return [''];
}

/**
 * The result's post-state, Δrg, pin and assurance against the row (§2.9
 * client-checkable columns). R2 and the signatures are the caller's.
 */
export function checkPost(row: Row, f: Pub, c: RowCtx): Reason {
  const w = expected(row, f, c);
  const r = c.res;
  const prior = w.state === 'pending' || w.state === 'disputed' ? w.prior : '';
  let ok =
    r.state === w.state &&
    r.prior_state === prior &&
    sameSet(r.suspended_by, w.susp) &&
    equalBytes(r.active_root, w.root) &&
    r.root_revoked === w.rootRevoked &&
    equalBytes(r.ek_binding_digest, w.ek) &&
    equalBytes(r.pending_root, w.pendRoot) &&
    equalBytes(r.pending_ek_binding_digest, w.pendEK) &&
    r.legacy_pin_revoked === w.pinRevoked &&
    r.recovery_gen === f.rg + row.deltaRG &&
    allowedAssurance(row, f, c).includes(r.assurance) &&
    equalBytes(r.legacy_ek_digest, f.pin); // the pin never changes, "" included
  // Row 1 admits only an account outside the population, so its result carries no pin.
  if (row.popNotIn) ok = ok && r.legacy_ek_digest.length === 0;
  return ok ? 'ok' : 'transition_invalid';
}

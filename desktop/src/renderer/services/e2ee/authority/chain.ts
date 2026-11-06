// Bundle and chain verification (design of record §2.12, §2.11 R1–R4, §2.9,
// §2.10 T7/T8/T12).
//
// A bundle extends the persisted head only when, in this order: every part
// passes EN5 and the restore positions are consistent (malformed); it names the
// head's realm and account (realm_mismatch); its intent, cp-authz and result
// agree on request and digests (transition_invalid); its seq is the head's + 1
// (chain_gap) and it links to the head's entry (head_mismatch); its RSK
// signature verifies under a retained delegation at the (gen, serial) it names
// whose window covers issued_at and whose scope holds its op (T7); and then,
// under at least one such delegation, R1, T8, R2 and the hypothesis-independent
// signatures pass, and exactly one R3 hypothesis that R4's fix leaves standing
// admits it through one §2.9 row, its intent positions, its current-root
// signature, its ek-binding, a candidate root that hypothesis's root_index does
// not already record (A-B1), and its post-state. Only then does the head move.
//
// The seq-0 hypothesis carries a pin only where AccountMemory is an input
// (V3-05): verifyChain takes AccountMemory's first-sight pin, or the pin of the
// status it sees for the first time (D-149). verifyBundle has none, so its
// genesis hypothesis is A0 and a pinned account's first result verifies only
// through verifyChain.

import { equalBytes } from './bytes';
import { checkBindingProof, checkPendingRecoveryKey } from './bindproof';
import { appendResult, formHypothesis } from './headmove';
import {
  canonicalHead,
  chainHeadBytes,
  ekIndexHas,
  headPub,
  rootRecordOf,
  segmentOf,
  type ChainHead,
} from './heads';
import {
  decodeAs,
  digestOrEmpty,
  encodeAs,
  sigMsg,
  verifyOver,
  type Bundle,
  type CpAuthz,
  type Delegation,
  type EkBinding,
  type Intent,
  type RecoveryBind,
  type Result,
  type Signed,
  type Status,
} from './messages';
import { checkPost, checkIntentValues, intentForOp, P, presenceOf, selectRow } from './post';
import { sha384, verifyLegacyPSS } from './primitives';
import type { Pub } from './pub';
import type { Reason } from './reason';
import { recoveryBindForKind } from './patterns';
import {
  checkANB,
  checkIssued,
  effectivePending,
  fixAllows,
  fixStatus,
  hypotheses,
  pickMatch,
} from './replay';
import { checkRestoreCancel } from './restore';
import {
  authenticStatus,
  refused,
  signedStatus,
  validNow,
  verifyStatusAt,
  type AccountMemory,
  type Use,
  type VerifiedStatus,
} from './status';
import { SIG, type Row } from './table';
import type { HighWater, Trust } from './trust';
import { checkT12, checkT7, checkT8, rskRule } from './trustcheck';

/** One published bundle with every nested message decoded. */
export interface ParsedBundle {
  raw: Bundle;
  intent: Intent;
  authz: CpAuthz;
  res: Result;
  intentDigest: Uint8Array;
  authzDigest: Uint8Array;
  resBytes: Uint8Array;
  entry: Uint8Array;
  ekb: EkBinding | null;
  ekbDigest: Uint8Array;
  bind: RecoveryBind | null;
  bindDigest: Uint8Array;
  held: Status | null;
  heldSigned: Signed | null;
}

/** One bundle checked against one hypothesis. */
export interface BundleCtx {
  t: Trust;
  head: ChainHead; // the persisted head with this hypothesis's activation recorded
  pb: ParsedBundle;
  f: Pub;
  act: boolean;
  row: Row | null;
  del: Delegation;
  bindingSegment: string;
  fix: Status | null; // R4's retained status for the from-head (row 22 check 4)
}

const NONE = new Uint8Array(0);

/** EN5 over every part, the recovery-bind per-kind rule (V2-04) and the restore positions (LD-46). */
export async function parseBundle(b: Uint8Array): Promise<ParsedBundle | null> {
  const raw = await decodeAs('bundle', b);
  if (!raw) return null;
  const intent = await decodeAs('intent', raw.intent);
  const authz = await decodeAs('cp-authz', raw.cp_authz);
  const res = await decodeAs('result', raw.result);
  if (!intent || !authz || !res) return null;
  const pb: ParsedBundle = {
    raw,
    intent,
    authz,
    res,
    intentDigest: await sha384(raw.intent),
    authzDigest: await sha384(raw.cp_authz),
    resBytes: raw.result,
    entry: await sha384(raw.result),
    ekb: null,
    ekbDigest: NONE,
    bind: null,
    bindDigest: NONE,
    held: null,
    heldSigned: null,
  };
  if (raw.ek_binding.length > 0) {
    pb.ekb = await decodeAs('ek-binding', raw.ek_binding);
    if (!pb.ekb) return null;
    pb.ekbDigest = await sha384(raw.ek_binding);
  }
  if (raw.recovery_bind.length > 0) {
    pb.bind = await decodeAs('recovery-bind', raw.recovery_bind);
    if (!pb.bind || recoveryBindForKind(pb.bind) !== '') return null;
    pb.bindDigest = await sha384(raw.recovery_bind);
  }
  const restore = authz.actor === 'restore';
  if (restore !== (raw.cp_authz_sig.length === 0) || restore !== raw.held_status.length > 0)
    return null;
  if (!restore) return pb;
  pb.heldSigned = await decodeAs('signed', raw.held_status);
  if (pb.heldSigned?.type !== 'status') return null;
  pb.held = await decodeAs('status', pb.heldSigned.msg);
  return pb.held ? pb : null;
}

/** Realm/account and request/digest identity: the part of the link check that reads no head. */
function identityCheck(
  pb: ParsedBundle,
  realm: string,
  account: string,
  trustRealm: string
): Reason {
  const parts = [pb.intent, pb.authz, pb.res];
  if (realm !== trustRealm || parts.some((x) => x.realm_id !== realm || x.account_id !== account))
    return 'realm_mismatch';
  const { intent: inp, authz: a, res: r } = pb;
  const consistent =
    r.request_id === inp.request_id &&
    a.request_id === inp.request_id &&
    r.op === inp.op &&
    equalBytes(r.intent_digest, pb.intentDigest) &&
    equalBytes(r.cp_authz_digest, pb.authzDigest) &&
    equalBytes(a.intent_digest, pb.intentDigest);
  return consistent ? 'ok' : 'transition_invalid';
}

/** The PoP (D-243): its SPKI's digest is the intent's legacy_ek_digest, then the PSS signature. */
async function popCheck(pb: ParsedBundle): Promise<Reason> {
  const { raw: b, intent: inp } = pb;
  if (b.legacy_pop_sig.length === 0) return 'ok';
  if (!equalBytes(await sha384(b.legacy_spki), inp.legacy_ek_digest)) return 'transition_invalid';
  const pop = encodeAs('legacy-ek-pop', {
    realm_id: inp.realm_id,
    account_id: inp.account_id,
    intent_digest: pb.intentDigest,
    legacy_ek_digest: inp.legacy_ek_digest,
  });
  return pop !== null && (await verifyLegacyPSS(b.legacy_spki, pop, b.legacy_pop_sig))
    ? 'ok'
    : 'bad_signature';
}

/** The signatures no hypothesis changes (decision A3). */
async function independentSigs(t: Trust, pb: ParsedBundle): Promise<Reason> {
  const { raw: b, intent: inp } = pb;
  if (
    b.sig_candidate.length > 0 &&
    inp.candidate_root.length > 0 &&
    !(await verifyOver(inp.candidate_root, sigMsg('candidate', pb.intentDigest), b.sig_candidate))
  ) {
    return 'bad_signature';
  }
  const pop = await popCheck(pb);
  if (pop !== 'ok') return pop;
  if (b.sig_operator.length > 0) {
    const r = await checkT12(
      t,
      pb.intentDigest,
      b.sig_operator,
      pb.res.delegation_gen,
      pb.res.delegation_serial,
      pb.authz.asserted_at_ms
    );
    if (r !== 'ok') return r;
  }
  if (
    inp.op === 'recover' &&
    pb.bind?.kind === 'bind' &&
    b.sig_recovery.length > 0 &&
    !(await verifyOver(
      pb.bind.recovery_key,
      sigMsg('recovery-key', pb.intentDigest),
      b.sig_recovery
    ))
  ) {
    return 'bad_signature';
  }
  return 'ok';
}

/** The binding's signer, generation and digest; the EK never bound earlier and never the pin (D-243). */
async function ekChecks(c: BundleCtx, row: Row): Promise<Reason> {
  const e = c.pb.ekb;
  if (!e) return 'ok';
  const signer = (row.sigs & SIG.ekByCurrent) !== 0 ? c.f.root : c.pb.intent.candidate_root;
  if (e.realm_id !== c.head.realm_id || e.account_id !== c.head.account_id) return 'realm_mismatch';
  if (
    !equalBytes(e.root_digest, await digestOrEmpty(signer)) ||
    e.ek_generation !== c.f.ekGen + 1 ||
    !equalBytes(c.pb.ekbDigest, c.pb.intent.ek_binding_digest)
  ) {
    return 'transition_invalid';
  }
  if (!(await verifyOver(signer, c.pb.raw.ek_binding, c.pb.raw.ek_binding_sig)))
    return 'bad_signature';
  const spki = await sha384(e.ek_public_key);
  if (
    equalBytes(spki, c.f.pin) ||
    equalBytes(spki, c.pb.res.legacy_ek_digest) ||
    ekIndexHas(c.head, spki)
  )
    return 'transition_invalid';
  return 'ok';
}

/** Rows 1, 2, 3, 5, 11 and 20 install the intent's candidate root. */
const installsCandidate = (row: Row): boolean =>
  row.to === 'enrollActive' ||
  row.to === 'pendOrDisp' ||
  row.to === 'rotateRoot' ||
  row.to === 'pr';

/** The row-specific client checks: §2.22's binding proof (20), the pending recovery key (21), restore-cancel (22). */
const ROW_CHECKS: Readonly<Record<number, (c: BundleCtx) => Promise<Reason>>> = Object.freeze({
  20: checkBindingProof,
  21: checkPendingRecoveryKey,
  22: checkRestoreCancel,
});

/** The bundle against this hypothesis; ok is a match. */
async function match(c: BundleCtx): Promise<Reason> {
  const p = presenceOf(c.pb.raw);
  const row = selectRow(c.f, c.pb.intent.op, c.pb.authz.actor, p);
  if (!row) return 'transition_invalid';
  c.row = row;
  if (intentForOp(c.pb.intent, c.pb.authz.actor, (p & P.pop) !== 0, (p & P.current) !== 0) !== '')
    return 'transition_invalid';
  const iv = await checkIntentValues(row, c.f, c.pb.intent);
  if (iv !== 'ok') return iv;
  if (
    (row.sigs & SIG.current) !== 0 &&
    !(await verifyOver(
      c.f.root,
      sigMsg('current-root', c.pb.intentDigest),
      c.pb.raw.sig_current_root
    ))
  ) {
    return 'bad_signature';
  }
  const ek = await ekChecks(c, row);
  if (ek !== 'ok') return ek;
  if (row.n === 20 || row.n === 21 || row.n === 22) {
    const rc = await ROW_CHECKS[row.n](c);
    if (rc !== 'ok') return rc;
  }
  // A-B1: a row that installs its candidate may not name a root root_index already records.
  if (
    installsCandidate(row) &&
    c.pb.intent.candidate_root.length > 0 &&
    rootRecordOf(c.head, await sha384(c.pb.intent.candidate_root)) !== null
  ) {
    return 'transition_invalid';
  }
  return checkPost(row, c.f, {
    inp: c.pb.intent,
    res: c.pb.res,
    outcomeP: c.pb.res.state === 'pending',
    segment: await segmentOf(c.head, c.f.root),
    bindingSegment: c.bindingSegment,
  });
}

/** R1, T8, R2 and the hypothesis-independent signatures. */
async function pre(t: Trust, pb: ParsedBundle, pp: Pub, d: Delegation): Promise<Reason> {
  const r1 = checkIssued(pp.issued, pb.res, pb.intent, pb.authz, d.g_ms);
  if (r1 !== 'ok') return r1;
  if (pb.authz.actor !== 'restore') {
    const t8 = await checkT8(
      t,
      pb.raw.cp_authz,
      pb.raw.cp_authz_sig,
      pb.res.delegation_gen,
      pb.res.delegation_serial,
      pb.authz.asserted_at_ms
    );
    if (t8 !== 'ok') return t8;
  }
  const r2 = checkANB(pb.res, pb.authz, d);
  return r2 === 'ok' ? independentSigs(t, pb) : r2;
}

/**
 * R3 under R4: every hypothesis the fix leaves standing is matched, and
 * exactly one must match. Returns the head after the step.
 */
async function pickHypothesis(
  t: Trust,
  prev: ChainHead,
  pp: Pub,
  pb: ParsedBundle,
  del: Delegation
): Promise<ChainHead | Reason> {
  const fix = await fixStatus(prev.fix);
  if (fix === 'malformed') return 'malformed';
  let prevRes: Result | null = null;
  if (pp.seq > 0) {
    prevRes = await decodeAs('result', prev.head_result);
    if (!prevRes) return 'malformed';
  }
  const hs = hypotheses(pp, pb.res.issued_at_ms);
  const rs: Reason[] = [];
  const cs: (BundleCtx | null)[] = [];
  const bad: boolean[] = [];
  for (const h of hs) {
    if (!fixAllows(fix, pp, pb.res.issued_at_ms, h.act)) {
      rs.push('hypothesis_conflict');
      cs.push(null);
      bad.push(false);
      continue;
    }
    const moved = await formHypothesis(prev, prevRes, h);
    const c: BundleCtx = {
      t,
      head: moved.head,
      pb,
      f: h.p,
      act: h.act,
      row: null,
      del,
      bindingSegment: '',
      fix,
    };
    cs.push(c);
    bad.push(moved.bad);
    rs.push(await match(c));
  }
  const [i, r] = pickMatch(rs);
  const c = cs[i];
  if (r !== 'ok' || !c) return r === 'ok' ? 'malformed' : r;
  const after = await appendResult(c.head, pb, await segmentOf(c.head, c.f.root));
  if (bad[i] || chainHeadBytes(after) === null) return 'malformed'; // E3-08: never produce a head parse refuses
  return after;
}

/**
 * R1–R4 and the row checks under each retained delegation at the result's
 * (gen, serial) whose RSK signed it (T7 and T8 are existential), accepting the
 * first under which the bundle verifies. The Reason reported when none does is
 * that of the first such delegation in msg-byte order.
 */
async function underSigningDelegation(
  t: Trust,
  prev: ChainHead,
  pp: Pub,
  pb: ParsedBundle
): Promise<ChainHead | Reason> {
  let first: Reason | null = null;
  const res = pb.res;
  for (const d of t.delegations(res.delegation_gen, res.delegation_serial)) {
    if ((await rskRule(d, pb.resBytes, pb.raw.result_sig, res.issued_at_ms, res.op)) !== 'ok')
      continue;
    let r: ChainHead | Reason = await pre(t, pb, pp, d);
    if (r === 'ok') r = await pickHypothesis(t, prev, pp, pb, d);
    if (typeof r !== 'string') return r;
    first ??= r;
  }
  return first ?? 'delegation_unknown';
}

interface Step {
  after: ChainHead | null;
  superseded: boolean;
  reason: Reason;
}

/** One bundle against prev. seq0Pin is the seq-0 hypothesis's pin, read only at genesis. */
async function verifyBundleStep(
  t: Trust,
  hw: HighWater,
  prev: ChainHead,
  raw: Uint8Array,
  seq0Pin: Uint8Array
): Promise<Step> {
  const fail = (reason: Reason): Step => ({ after: null, superseded: false, reason });
  const pb = await parseBundle(raw);
  if (!pb) return fail('malformed');
  const [pp0, hr] = await headPub(prev);
  if (hr !== 'ok') return fail(hr);
  const pp = pp0.seq === 0 ? { ...pp0, pin: seq0Pin } : pp0;
  const id = identityCheck(pb, prev.realm_id, prev.account_id, t.realm);
  if (id !== 'ok') return fail(id);
  if (pb.res.seq !== pp.seq + 1) return fail('chain_gap');
  if (!equalBytes(pb.res.prev_entry_digest, pp.entry)) return fail('head_mismatch');
  const res = pb.res;
  const [sup, r7] = await checkT7(
    t,
    hw,
    res.delegation_gen,
    res.delegation_serial,
    res.issued_at_ms,
    res.op,
    pb.resBytes,
    pb.raw.result_sig
  );
  if (r7 !== 'ok') return fail(r7);
  const after = await underSigningDelegation(t, prev, pp, pb);
  if (typeof after === 'string') return fail(after);
  return { after, superseded: sup, reason: 'ok' };
}

/**
 * R4's retention rule (RT-1): whether the retained fix `old` stays when st, a
 * verified status naming the raw pending head hp, arrives. An activation fix
 * is replaced only by an earlier activation; an activation replaces a pending
 * fix; of two pending fixes the newer stays.
 */
async function keepsFix(old: Uint8Array, st: Status, hp: Pub): Promise<boolean> {
  if (hp.state !== 'pending') return false;
  const o = await fixStatus(old);
  if (
    o === null ||
    o === 'malformed' ||
    o.seq !== hp.seq ||
    !equalBytes(o.head_entry_digest, hp.entry)
  )
    return false;
  const oldAct = !effectivePending(hp, o);
  const newAct = !effectivePending(hp, st);
  if (oldAct) return !newAct || st.as_of_ms >= o.as_of_ms;
  if (newAct) return false;
  return o.as_of_ms >= st.as_of_ms;
}

/** R4's retained status: kept only for a raw pending head, replaced only where keepsFix allows. */
async function retainFix(h: ChainHead, signed: Uint8Array, st: Status): Promise<ChainHead> {
  const [hp, r] = await headPub(h);
  if (r !== 'ok' || hp.state !== 'pending') return { ...h, fix: NONE };
  return (await keepsFix(h.fix, st, hp)) ? h : { ...h, fix: signed.slice() };
}

/** The outcome of verifyBundle: the head to persist (prev on every refusal) and the Reason. */
export interface BundleOutcome {
  head: ChainHead;
  reason: Reason;
}

/**
 * Verifies one bundle against the persisted head (§2.12). prev must come from
 * parseChainHead or an earlier verification. A fix (a `signed` status) is
 * offered to prev's stored fix once it passes authenticStatus, and replaces it
 * only where R4's retention rule lets it. A superseded entry is
 * superseded_uncovered here: only verifyChain, with a covering status, accepts
 * one. On every refusal it returns prev unchanged, fix included. Never throws.
 */
export async function verifyBundle(
  t: Trust,
  hw: HighWater,
  prev: ChainHead,
  bundle: Uint8Array,
  fix?: Uint8Array
): Promise<BundleOutcome> {
  try {
    const halt = t.haltReason();
    if (halt !== 'ok') return { head: prev, reason: halt };
    if (!canonicalHead(prev)) return { head: prev, reason: 'malformed' };
    let input = prev;
    if (fix !== undefined) {
      const a = await authenticStatus(t, hw, prev, fix);
      if (typeof a === 'string') return { head: prev, reason: a };
      if (!(await keepsFix(prev.fix, a.st, a.hp))) input = { ...prev, fix: fix.slice() };
    }
    const st = await verifyBundleStep(t, hw, input, bundle, NONE);
    if (st.reason !== 'ok' || !st.after) return { head: prev, reason: st.reason };
    if (st.superseded) return { head: prev, reason: 'superseded_uncovered' };
    return { head: st.after, reason: 'ok' };
  } catch {
    return { head: prev, reason: 'malformed' };
  }
}

/** What the server serves for one verifyChain call: the bundles after `from`, then the status naming the result. */
export interface ChainInput {
  bundles: Uint8Array[];
  status: Uint8Array;
}

/** The outcome of verifyChain: the head to persist (`from` on a refusal), the status verdict and the HW. */
export interface ChainOutcome {
  head: ChainHead;
  status: VerifiedStatus;
  hw: HighWater;
  reason: Reason;
}

/** The verdicts of a status that verified: the chain they describe may be persisted. */
const STATE_REASONS: ReadonlySet<Reason> = new Set<Reason>([
  'ok',
  'ok_accepted_pin',
  'suspended',
  'disputed',
  'held',
  'erased',
  'pending_erase',
  'root_revoked',
  'pending_from_active',
  'pending_from_suspended',
  'pending_from_absent',
  'pin_revoked',
  'pin_changed',
  'absent_unpinned',
  'absent_after_cutover',
  'absent_after_enrolled',
]);

/**
 * Verifies input.bundles from `from`, then input.status naming the resulting
 * head (§2.12), in T7's order: the status's T6 first, then every bundle, then
 * head equality, R5, freshness and the state verdict. On any Reason outside the
 * state verdicts it returns `from` unchanged. nowMs is the caller's clock in ms;
 * 0 or anything not a u is malformed. Never throws.
 */
export async function verifyChain(
  t: Trust,
  hw: HighWater,
  from: ChainHead,
  input: ChainInput,
  mem: AccountMemory,
  nowMs: number,
  use: Use
): Promise<ChainOutcome> {
  const fail = (reason: Reason): ChainOutcome => ({
    head: from,
    status: refused(reason),
    hw,
    reason,
  });
  try {
    const halt = t.haltReason();
    if (halt !== 'ok') return fail(halt);
    if (!validNow(nowMs)) return fail('malformed');
    const [seen, , sr] = await signedStatus(t, hw, input.status);
    if (!seen || sr !== 'ok') return fail(sr);
    // chainSeq0Pin: AccountMemory's first-sight pin, or the pin of the status seen for the first time.
    const seq0Pin =
      input.bundles.length === 0 || from.head_result.length !== 0 || mem.pin.length > 0
        ? mem.pin
        : seen.legacy_ek_digest;
    if (!canonicalHead(from)) return fail('malformed');
    let head = from;
    let superseded = false;
    for (const b of input.bundles) {
      const st = await verifyBundleStep(t, hw, head, b, seq0Pin);
      if (st.reason !== 'ok' || !st.after) return fail(st.reason);
      superseded ||= st.superseded;
      head = st.after;
    }
    const [vs, hw2] = await verifyStatusAt(t, hw, head, input.status, mem, nowMs, use);
    if (!STATE_REASONS.has(vs.reason) || !vs.status) return fail(vs.reason);
    if (superseded && nowMs > vs.status.valid_until_ms) return fail('superseded_uncovered'); // T7
    head = await retainFix(head, input.status, vs.status);
    if (chainHeadBytes(head) === null) return fail('malformed');
    return { head, status: vs, hw: hw2, reason: vs.reason };
  } catch {
    return fail('malformed');
  }
}

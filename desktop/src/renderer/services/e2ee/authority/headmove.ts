// §2.12 "When the index moves" (V3-10, E3-06): everything one verified result
// changes in the persisted chain-head. Every move returns a new head and never
// writes the one it was given.
//
// After result n+1 is verified against hypothesis h: if h is H_act of a pending
// result n, n's activation is recorded first (recordActivation); then n+1 is
// appended (appendResult). The pending EK slot mirrors result #17: it is emptied
// exactly when the new head's pending_ek_binding_digest is "".

import { b64e } from './bytes';
import {
  insertSorted,
  lowerBound,
  recoverRecord, rootRecord, rootRecordOf, seqRecord, type ChainHead } from './heads';
import type { EkBinding, RecoveryBind, Result } from './messages';
import { sha384 } from './primitives';
import type { Pub } from './pub';
import type { Hyp } from './replay';

const NONE = new Uint8Array(0);

/** What appendResult reads of a verified bundle. */
export interface Appended {
  res: Result;
  resBytes: Uint8Array;
  entry: Uint8Array;
  ekb: EkBinding | null;
  bind: RecoveryBind | null;
}

/** A head and whether a record it was given could not be read (the step is then malformed). */
export interface Moved {
  head: ChainHead;
  bad: boolean;
}

/** A root the chain made active, recorded once (root_index is an a<s>). */
async function addRoot(h: ChainHead, root: Uint8Array, seg: string): Promise<ChainHead> {
  const d = await sha384(root);
  if (rootRecordOf(h, d) !== null) return h;
  return { ...h, root_index: insertSorted(h.root_index, rootRecord(d, root, seg)) };
}

/** seq_index record n gains its bind root; a missing or unreadable record marks the move bad. */
async function bindRecord(h: ChainHead, n: number, root: Uint8Array): Promise<Moved> {
  if (n === 0 || n > h.seq_index.length) return { head: h, bad: true };
  const rec = h.seq_index[n - 1];
  const dot = rec.indexOf('.');
  if (dot < 0) return { head: h, bad: true };
  const seq = [...h.seq_index];
  seq[n - 1] = `${rec.slice(0, dot)}.${b64e(await sha384(root))}`;
  return { head: { ...h, seq_index: seq }, bad: false };
}

/**
 * A pending result n whose successor matched H_act: record n gains its bind
 * root when the activation yields active, root_index gains #16 with n's
 * assurance (A9), the pending EK becomes active, and a recover's key enters
 * recover_index. A Pe(x) activation installs nothing.
 */
export async function recordActivation(h0: ChainHead, prev: Result, act: Pub): Promise<Moved> {
  let h = h0;
  let bad = false;
  if (prev.pending_root.length > 0) {
    if (act.state === 'active') ({ head: h, bad } = await bindRecord(h, prev.seq, prev.pending_root));
    h = await addRoot(h, prev.pending_root, prev.assurance);
    h = { ...h, active_ek_spki: h.pending_ek_spki, active_ek_generation: h.pending_ek_generation };
    if (prev.op === 'recover') {
      const rec = recoverRecord(prev.seq, await sha384(h.pending_recovery_key));
      h = { ...h, recover_index: insertSorted(h.recover_index, rec) };
    }
  }
  return {
    head: { ...h, pending_ek_spki: NONE, pending_ek_generation: 0, pending_recovery_key: NONE },
    bad,
  };
}

/** The head hypothesis h reads: prev itself, or for H_act prev with prevRes's activation recorded. */
export async function formHypothesis(
  prev: ChainHead,
  prevRes: Result | null,
  hyp: Hyp
): Promise<Moved> {
  if (!hyp.act) return { head: prev, bad: false };
  if (!prevRes) return { head: prev, bad: true };
  return recordActivation(prev, prevRes, hyp.p);
}

/**
 * Appends a verified result: its seq_index record (bind root when active), its
 * root in root_index when active (a rotated root takes the current segment's
 * assurance, A9), its EK in ek_index and the active or pending slot, a pending
 * recover's recovery key, and the head result. The fix is dropped.
 */
export async function appendResult(h0: ChainHead, pb: Appended, seg: string): Promise<ChainHead> {
  const r = pb.res;
  let h = h0;
  let bindRoot: Uint8Array = NONE;
  if (r.state === 'active') {
    bindRoot = await sha384(r.active_root);
    h = await addRoot(h, r.active_root, r.op === 'enroll_new' ? 'initial' : seg);
  }
  h = { ...h, seq_index: [...h.seq_index, seqRecord(pb.entry, bindRoot)] };
  if (pb.ekb) {
    const spki = pb.ekb.ek_public_key;
    const d = await sha384(spki);
    const texts = h.ek_index.map(b64e);
    const i = lowerBound(texts, b64e(d));
    if (texts[i] !== b64e(d))
      h = { ...h, ek_index: [...h.ek_index.slice(0, i), d, ...h.ek_index.slice(i)] };
    if (r.state === 'active')
      h = { ...h, active_ek_spki: spki, active_ek_generation: pb.ekb.ek_generation };
    if (r.state === 'pending')
      h = { ...h, pending_ek_spki: spki, pending_ek_generation: pb.ekb.ek_generation };
  }
  if (r.pending_ek_binding_digest.length === 0)
    h = { ...h, pending_ek_spki: NONE, pending_ek_generation: 0 };
  const pendingKey =
    r.op === 'recover' && r.state === 'pending' && pb.bind ? pb.bind.recovery_key : NONE;
  return { ...h, pending_recovery_key: pendingKey, head_result: pb.resBytes, fix: NONE };
}

// §2.22's binding proof (row 20) and the pending recovery key (row 21).
//
// A co-member admits a `recover` only when its B (1) is a bind and is the B
// intent #16 names; (6, realm clause) names the intent's realm and account; (2)
// names a position n below the recover whose seq_index record carries
// B.chain_entry_digest; (3) names as its root the bind root that record holds,
// which root_index resolves to a point; (4) carries that root's signature over
// H(B); and (6) sits at or after every activated recover's position with a key
// none of them burned. Check 5 feeds the binding root's segment to the row's
// post-state rule. Checks 3 and 6 read the hypothesis head.

import { b64e, equalBytes } from './bytes';
import type { BundleCtx } from './chain';
import { rootByDigest, segmentOf, type ChainHead } from './heads';
import { sigMsg, verifyOver, type RecoveryBind } from './messages';
import { parseU, sha384 } from './primitives';
import type { Reason } from './reason';

/** Checks 2 and 3: the root point of the effective state after result n = B.chain_seq. */
function bindingRoot(c: BundleCtx, b: RecoveryBind): Uint8Array | null {
  const n = b.chain_seq;
  if (n === 0 || n >= c.pb.res.seq || n > c.head.seq_index.length) return null; // 2, position
  const rec = c.head.seq_index[n - 1];
  const dot = rec.indexOf('.');
  const entry = dot < 0 ? rec : rec.slice(0, dot);
  const bindRoot = dot < 0 ? '' : rec.slice(dot + 1);
  if (entry !== b64e(b.chain_entry_digest)) return null; // 2, entry digest
  if (bindRoot === '' || bindRoot !== b64e(b.binding_root_digest)) return null; // 3
  return rootByDigest(c.head, b.binding_root_digest); // 3: a recorded bind root is in root_index
}

/** Check 6's position and key clauses against every activated recover the hypothesis head records. */
async function checkRecoverIndex(h: ChainHead, b: RecoveryBind): Promise<Reason> {
  const key = b64e(await sha384(b.recovery_key));
  for (const rec of h.recover_index) {
    const dot = rec.indexOf('.');
    let s: number;
    if (dot < 0) return 'transition_invalid'; // a canonical record always has one
    try {
      s = parseU(rec.slice(0, dot));
    } catch {
      return 'transition_invalid';
    }
    if (b.chain_seq < s || rec.slice(dot + 1) === key) return 'transition_invalid';
  }
  return 'ok';
}

/**
 * §2.22's checks 1–4 and 6 (check 4's sig_recovery half runs with the
 * hypothesis-independent signatures); sets check 5's binding segment.
 */
export async function checkBindingProof(c: BundleCtx): Promise<Reason> {
  const b = c.pb.bind;
  if (!b || c.pb.raw.recovery_bind_sig.length === 0) return 'transition_invalid';
  if (b.kind !== 'bind' || !equalBytes(c.pb.bindDigest, c.pb.intent.recovery_bind_digest))
    return 'transition_invalid'; // 1
  if (b.realm_id !== c.pb.intent.realm_id || b.account_id !== c.pb.intent.account_id)
    return 'realm_mismatch'; // 6, realm clause
  const root = bindingRoot(c, b);
  if (!root) return 'transition_invalid';
  if (
    !(await verifyOver(root, sigMsg('current-root', c.pb.bindDigest), c.pb.raw.recovery_bind_sig))
  )
    return 'bad_signature'; // 4
  const r6 = await checkRecoverIndex(c.head, b); // 6
  if (r6 !== 'ok') return r6;
  c.bindingSegment = await segmentOf(c.head, root); // 5
  return 'ok';
}

/** Row 21: the cancel's sig_recovery verifies under the persisted pending_recovery_key. */
export async function checkPendingRecoveryKey(c: BundleCtx): Promise<Reason> {
  const k = c.head.pending_recovery_key;
  if (k.length === 0) return 'transition_invalid';
  const ok = await verifyOver(k, sigMsg('recovery-key', c.pb.intentDigest), c.pb.raw.sig_recovery);
  return ok ? 'ok' : 'bad_signature';
}

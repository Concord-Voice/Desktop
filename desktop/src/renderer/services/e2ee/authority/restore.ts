// §2.9's restore-cancel checks (row 22; LD-46, D-268, E3-09).
//
// A row-22 result, which no root, PoP, recovery-key or CAK signature
// authorises, is admitted only on the RSK-signed status the bundle carries,
// and only when (1) cp-authz binds that exact held_status by its SHA-384; (2)
// held_status names the result's delegation, is as of the result's issued_at,
// and one delegation retained there passes the RSK rule for it under scope
// `status`; (3) it names the result's realm, account and from-head, passes R5
// against that head and shows it held; and (4) the client holds no fix that
// names the from-head and shows it activated, at any issued_at. Every failure
// is transition_invalid except check 4, which is hypothesis_conflict.

import { equalBytes } from './bytes';
import type { BundleCtx, ParsedBundle } from './chain';
import type { Status } from './messages';
import { sha384 } from './primitives';
import type { Pub } from './pub';
import type { Reason } from './reason';
import { checkR5, effectivePending } from './replay';
import type { Trust } from './trust';
import { rskRule } from './trustcheck';

async function heldSignedUnderResultDelegation(
  t: Trust,
  pb: ParsedBundle,
  st: Status
): Promise<boolean> {
  const res = pb.res;
  if (
    st.delegation_gen !== res.delegation_gen ||
    st.delegation_serial !== res.delegation_serial ||
    st.as_of_ms !== res.issued_at_ms ||
    !pb.heldSigned
  ) {
    return false;
  }
  for (const d of t.delegations(res.delegation_gen, res.delegation_serial)) {
    const r = await rskRule(d, pb.heldSigned.msg, pb.heldSigned.sig_a, res.issued_at_ms, 'status');
    if (r === 'ok') return true;
  }
  return false;
}

async function heldNamesFromHead(f: Pub, pb: ParsedBundle, st: Status): Promise<boolean> {
  const res = pb.res;
  if (st.realm_id !== res.realm_id || st.account_id !== res.account_id) return false;
  if (st.seq + 1 !== res.seq || !equalBytes(st.head_entry_digest, res.prev_entry_digest))
    return false;
  return st.held === 1 && (await checkR5(f, st)) === 'ok';
}

/** Check 4's condition: the retained fix names the from-head f and shows it activated. */
function fixShowsActivated(fix: Status | null, f: Pub): boolean {
  if (!fix || fix.seq !== f.seq || !equalBytes(fix.head_entry_digest, f.entry)) return false;
  return f.state === 'pending' && !effectivePending(f, fix);
}

/** §2.9's restore-cancel checks 1–4. */
export async function checkRestoreCancel(c: BundleCtx): Promise<Reason> {
  const pb = c.pb;
  const st = pb.held;
  if (!st || !pb.heldSigned) return 'transition_invalid';
  if (!equalBytes(pb.authz.evidence_digest, await sha384(pb.raw.held_status)))
    return 'transition_invalid'; // 1
  if (!(await heldSignedUnderResultDelegation(c.t, pb, st))) return 'transition_invalid'; // 2
  if (!(await heldNamesFromHead(c.f, pb, st))) return 'transition_invalid'; // 3
  if (fixShowsActivated(c.fix, c.f)) return 'hypothesis_conflict'; // 4
  return 'ok';
}

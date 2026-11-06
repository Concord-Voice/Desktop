// The client-visible published state and §2.9's from-state codes (design of
// record §2.9). `Pub` is derived, never persisted: the persisted form is the
// chain-head (D-269).

import { sha384 } from './primitives';
import type { Result } from './messages';

/** A §2.9 from-state code. In the From column P excludes Pr and Pe unless a row names them. */
export type FromCode = 'A0' | 'Ap' | 'Apr' | 'Ac' | 'Su' | 'So' | 'Sor' | 'P' | 'D' | 'Pr' | 'Pe' | 'E';

const EMPTY = new Uint8Array(0);

/** The published state after a verified result, or at genesis. Empty bytes are "". */
export interface Pub {
  seq: number;
  entry: Uint8Array; // entry_digest of the head result; empty at seq 0
  state: string;
  prior: string;
  susp: string[];
  root: Uint8Array; // the 97-byte active root; empty when there is none
  rootRevoked: number;
  ek: Uint8Array; // ek_binding_digest
  pendRoot: Uint8Array;
  pendEK: Uint8Array;
  pin: Uint8Array; // legacy_ek_digest
  pinRevoked: number;
  rg: number;
  anb: number;
  assurance: string;
  issued: number;
  op: string;
  ekGen: number; // chain-head: the active binding's generation
  pendEKGen: number;
}

export const genesisPub = (): Pub => ({
  seq: 0,
  entry: EMPTY,
  state: 'absent',
  prior: '',
  susp: [],
  root: EMPTY,
  rootRevoked: 0,
  ek: EMPTY,
  pendRoot: EMPTY,
  pendEK: EMPTY,
  pin: EMPTY,
  pinRevoked: 0,
  rg: 0,
  anb: 0,
  assurance: '',
  issued: 0,
  op: '',
  ekGen: 0,
  pendEKGen: 0,
});

export async function pubOfResult(
  r: Result,
  resultBytes: Uint8Array,
  ekGen: number,
  pendEKGen: number
): Promise<Pub> {
  return {
    seq: r.seq,
    entry: await sha384(resultBytes),
    state: r.state,
    prior: r.prior_state,
    susp: r.suspended_by,
    root: r.active_root,
    rootRevoked: r.root_revoked,
    ek: r.ek_binding_digest,
    pendRoot: r.pending_root,
    pendEK: r.pending_ek_binding_digest,
    pin: r.legacy_ek_digest,
    pinRevoked: r.legacy_pin_revoked,
    rg: r.recovery_gen,
    anb: r.activation_not_before_ms,
    assurance: r.assurance,
    issued: r.issued_at_ms,
    op: r.op,
    ekGen,
    pendEKGen,
  };
}

/** §2.9's from-state code. A state outside the six result states falls to E, which no row admits. */
export function classify(p: Pub): FromCode {
  switch (p.state) {
    case 'absent':
      if (p.pin.length === 0) return 'A0';
      return p.pinRevoked === 1 ? 'Apr' : 'Ap';
    case 'active':
      return 'Ac';
    case 'suspended':
      if (p.rootRevoked === 1) return 'Sor';
      return p.susp.includes('operator') ? 'So' : 'Su';
    case 'pending':
      if (p.op === 'recover') return 'Pr';
      return p.pendRoot.length === 0 ? 'Pe' : 'P';
    case 'disputed':
      return 'D';
  }
  return 'E';
}

/** The "x" of P(x), D(x), Pe(x) and Pr(x); for any other state, the state. */
export const xOf = (p: Pub): string =>
  p.state === 'pending' || p.state === 'disputed' ? p.prior : p.state;

/** set ∪ {v}, sorted as the codec's a arrays are; the input is not modified. */
export function withSet(set: readonly string[], v: string): string[] {
  return set.includes(v) ? [...set] : [...set, v].sort();
}

/** set \ {v}. */
export const withoutSet = (set: readonly string[], v: string): string[] => set.filter((s) => s !== v);

/** Two sorted sets are equal. */
export const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * §2.9's derived activation (no event, no seq bump). Only a pending head
 * activates; any other state is returned unchanged.
 */
export function activate(p: Pub): Pub {
  if (p.state !== 'pending') return p;
  const q: Pub = { ...p, prior: '', anb: 0, pendRoot: EMPTY, pendEK: EMPTY };
  if (p.pendRoot.length === 0) return { ...q, state: 'erased', susp: [] }; // Pe(x) → E, the root kept
  Object.assign(q, {
    root: p.pendRoot,
    ek: p.pendEK,
    ekGen: p.pendEKGen,
    pendEKGen: 0,
    rootRevoked: 0,
    state: 'active',
    susp: [],
  });
  if (p.prior === 'suspended') {
    // operator is removed only when it came from Sor; user is never removed
    const set = p.rootRevoked === 1 ? withoutSet(p.susp, 'operator') : [...p.susp];
    if (set.length > 0) Object.assign(q, { state: 'suspended', susp: set });
  }
  return q;
}

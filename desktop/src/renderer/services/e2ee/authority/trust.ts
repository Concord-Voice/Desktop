// A client's realm trust, T1–T5 (design of record §2.10, LD-3, D-222, D-223).
//
// Dual control is positional: a delegation is retained only when sig_a verifies
// under primary A and sig_b under primary B of its generation, a succession only
// when sig_a verifies under recovery A′ and sig_b under recovery B′ of
// prev_root_gen. Retention depends only on the object and the keys of
// generations 0 through its own, and the T4 halt is recomputed from the retained
// set after every admission, so neither depends on arrival order.

import { b64e, equalBytes, toHex } from './bytes';
import {
  DELEGATION_LIFETIME_MAX_MS,
  DELTA_MAX_MS,
  EPSILON_MS,
  INTENT_WINDOW_MS,
  V_MAX_MS,
} from './constants';
import {
  decodeAs,
  encodeAs,
  verifyOver,
  type Delegation,
  type Signed,
  type TrustEnvelope,
} from './messages';
import { sha384, tlsPin } from './primitives';
import type { Reason } from './reason';

type Gen = readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array]; // primary A, B, recovery A′, B′

/** T5's never-decreasing mark, persisted by the caller as (gen, serial, min_valid). */
export interface HighWater {
  gen: number;
  serial: number;
  minValid: number;
}

export const ZERO_HW: HighWater = Object.freeze({ gen: 0, serial: 0, minValid: 0 });

const hwLess = (a: HighWater, b: HighWater): boolean =>
  a.gen < b.gen || (a.gen === b.gen && a.serial < b.serial);

/** The higher (gen, serial); on a tie the larger min_valid, so HW never decreases (T5). */
export function maxHW(a: HighWater, b: HighWater): HighWater {
  if (hwLess(a, b)) return b;
  if (!hwLess(b, a) && b.minValid > a.minValid) return b;
  return a;
}

/** What one trust object did: admitted, ignored (T2/T3 or a repeat), malformed, or admitted into a halt. */
export type Admission = 'admitted' | 'ignored' | 'malformed' | 'halt';

interface DelRec {
  d: Delegation;
  msg: Uint8Array;
}

const key = (gen: number, serial: number): string => `${gen}:${serial}`;

function pairwiseDistinct(keys: readonly Uint8Array[]): boolean {
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) if (equalBytes(keys[i], keys[j])) return false;
  }
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** T3's §2.5 bounds, the 400-day lifetime and delta_ms bounds included. */
function delegationBoundsOK(d: Delegation): boolean {
  return (
    d.min_valid_serial >= 1 &&
    d.min_valid_serial <= d.serial &&
    d.not_before_ms < d.not_after_ms &&
    d.not_after_ms - d.not_before_ms <= DELEGATION_LIFETIME_MAX_MS &&
    d.tau_ms >= 1 &&
    d.tau_ms <= V_MAX_MS &&
    d.delta_ms > INTENT_WINDOW_MS + EPSILON_MS &&
    d.delta_ms <= DELTA_MAX_MS &&
    d.g_ms >= 1 &&
    d.g_ms <= d.delta_ms &&
    d.accepted_versions.includes('1')
  );
}

/** The points of arrs, or null when one point appears twice. */
function disjointKeys(arrs: readonly Uint8Array[][]): Map<string, Uint8Array> | null {
  const seen = new Map<string, Uint8Array>();
  for (const arr of arrs) {
    for (const k of arr) {
      const s = b64e(k);
      if (seen.has(s)) return null;
      seen.set(s, k);
    }
  }
  return seen;
}

/**
 * A client's realm trust. Build it with `newTrust`, then `addSigned` or
 * `addTrust`. Not safe for concurrent mutation: await each call before the next.
 */
export class Trust {
  readonly realm: string;
  readonly #gens: Gen[];
  readonly #succ = new Map<number, Uint8Array[]>(); // prev_root_gen → distinct valid msgs
  readonly #dels = new Map<string, DelRec[]>(); // "gen:serial" → valid delegations
  readonly #seen = new Set<string>(); // SHA-384(msg) of every accepted object (D-222)
  #halt: string | null = null;

  private constructor(realm: string, anchors: Gen) {
    this.realm = realm;
    this.#gens = [anchors];
  }

  /** T1, the only constructor: the anchors' four keys must be pairwise distinct (LD-3). */
  static async fromAnchors(anchors: Uint8Array): Promise<Trust | null> {
    const a = await decodeAs('anchors', anchors);
    if (!a || !encodeAs('anchors', a)) return null;
    const g: Gen = [a.primary_a, a.primary_b, a.recovery_a, a.recovery_b];
    if (!pairwiseDistinct(g)) return null;
    return new Trust(a.realm_id, [g[0].slice(), g[1].slice(), g[2].slice(), g[3].slice()]);
  }

  /** The top of the contiguous succession chain (T2). */
  currentGen(): number {
    return this.#gens.length - 1;
  }

  /** The anchor and succession keys of generations 0..last, or null past the known top. */
  #keysThrough(last: number): Uint8Array[] | null {
    if (last >= this.#gens.length) return null;
    return this.#gens.slice(0, last + 1).flatMap((g) => [...g]);
  }

  /**
   * Admits one `signed` succession or delegation (T2, T3) and recomputes T4.
   * Returns `halt` when the retained set halts after the object is admitted.
   */
  async addSigned(b: Uint8Array): Promise<Admission> {
    const s = await decodeAs('signed', b);
    if (!s) return 'malformed';
    if (s.type !== 'succession' && s.type !== 'delegation') return 'malformed';
    const seenKey = toHex(await sha384(s.msg));
    if (this.#seen.has(seenKey)) return 'ignored';
    const r = s.type === 'succession' ? await this.#addSuccession(s) : await this.#addDelegation(s);
    if (r !== 'admitted') return r;
    this.#seen.add(seenKey);
    this.#evalHalt();
    return this.#halt === null ? 'admitted' : 'halt';
  }

  async #addSuccession(s: Signed): Promise<Admission> {
    const m = await decodeAs('succession', s.msg);
    if (!m) return 'malformed';
    if (
      m.realm_id !== this.realm ||
      m.prev_root_gen >= this.#gens.length ||
      m.new_root_gen !== m.prev_root_gen + 1
    ) {
      return 'ignored';
    }
    const g = this.#gens[m.prev_root_gen];
    if (!(await verifyOver(g[2], s.msg, s.sig_a)) || !(await verifyOver(g[3], s.msg, s.sig_b)))
      return 'ignored';
    const next: Gen = [m.new_primary_a, m.new_primary_b, m.new_recovery_a, m.new_recovery_b];
    if (!this.#freshSuccessor(next, m.prev_root_gen)) return 'ignored';
    const list = this.#succ.get(m.prev_root_gen) ?? [];
    list.push(s.msg);
    this.#succ.set(m.prev_root_gen, list);
    if (m.prev_root_gen === this.currentGen() && list.length === 1) this.#gens.push(next);
    return 'admitted';
  }

  /** T2's key rule, judged against generations 0..prev only (arrival-order independent). */
  #freshSuccessor(next: Gen, prev: number): boolean {
    if (!pairwiseDistinct(next)) return false;
    const earlier = this.#keysThrough(prev);
    if (!earlier) return false;
    return !earlier.some((old) => next.some((k) => equalBytes(k, old)));
  }

  async #addDelegation(s: Signed): Promise<Admission> {
    const d = await decodeAs('delegation', s.msg);
    if (!d) return 'malformed';
    const gen = d.product_root_gen;
    if (d.realm_id !== this.realm || gen >= this.#gens.length) return 'ignored';
    const g = this.#gens[gen];
    if (!(await verifyOver(g[0], s.msg, s.sig_a)) || !(await verifyOver(g[1], s.msg, s.sig_b)))
      return 'ignored';
    if (!delegationBoundsOK(d) || !(await this.#keySeparationOK(d))) return 'ignored';
    const k = key(gen, d.serial);
    this.#dels.set(k, [...(this.#dels.get(k) ?? []), { d, msg: s.msg }]);
    return 'admitted';
  }

  /** §2.4's key separation for this delegation alone (D-223, A14). */
  async #keySeparationOK(d: Delegation): Promise<boolean> {
    const keys = disjointKeys([
      d.rsk_public_keys,
      d.cak_public_keys,
      d.operator_public_keys,
      d.authority_tls_keys,
    ]);
    const anchored = this.#keysThrough(d.product_root_gen);
    if (!keys || !anchored) return false;
    if (anchored.some((k) => keys.has(b64e(k)))) return false;
    const listed = new Set(d.cp_tls_pins.map(b64e));
    for (const point of keys.values()) {
      try {
        if (listed.has(b64e(await tlsPin(point)))) return false;
      } catch {
        return false; // a point whose pin cannot be computed fails closed
      }
    }
    return true;
  }

  /** T4 over the retained set, recomputed from scratch after every admission. */
  #evalHalt(): void {
    this.#halt = null;
    for (const [prev, msgs] of this.#succ) {
      if (msgs.length > 1) this.#halt = `T4: two successions for generation ${prev}`;
    }
    if (this.#halt === null) this.#halt = this.#delegationHalt();
  }

  /** current_gen only: two different msgs at one (gen, serial), or a higher serial lowering a cutover. */
  #delegationHalt(): string | null {
    const cg = this.currentGen();
    const serials = this.#serialsOf(cg).sort((a, b) => a - b);
    const cur: Delegation[] = [];
    for (const serial of serials) {
      const ds = this.delegations(cg, serial);
      if (ds.length > 1) return `T4: two delegations for (${cg}, ${serial})`;
      cur.push(...ds);
    }
    for (let i = 0; i < cur.length; i++) {
      if (cur[i].cutover_at_ms === 0) continue;
      if (cur.slice(i + 1).some((hi) => hi.cutover_at_ms < cur[i].cutover_at_ms))
        return 'T4: a higher serial lowers the cutover';
    }
    return null;
  }

  #serialsOf(gen: number): number[] {
    const out: number[] = [];
    for (const recs of this.#dels.values()) {
      if (recs[0].d.product_root_gen === gen) out.push(recs[0].d.serial);
    }
    return out;
  }

  /**
   * Every distinct valid delegation retained at (gen, serial), ordered by msg
   * bytes so no caller depends on arrival order. More than one exists only in a
   * retired generation.
   */
  delegations(gen: number, serial: number): Delegation[] {
    const recs = [...(this.#dels.get(key(gen, serial)) ?? [])].sort((a, b) =>
      compareBytes(a.msg, b.msg)
    );
    return recs.filter((r, i) => i === 0 || !equalBytes(r.msg, recs[i - 1].msg)).map((r) => r.d);
  }

  /** The delegation at (gen, serial) only when exactly one is retained. */
  lookup(gen: number, serial: number): Delegation | null {
    const ds = this.delegations(gen, serial);
    return ds.length === 1 ? ds[0] : null;
  }

  /** The retained (gen, serial) keys, highest first. */
  sortedKeys(): [number, number][] {
    const ks = [...this.#dels.values()].map((recs): [number, number] => [
      recs[0].d.product_root_gen,
      recs[0].d.serial,
    ]);
    return ks.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  }

  /** T5 over the valid delegations this trust holds. */
  highWater(): HighWater {
    let hw = ZERO_HW;
    for (const recs of this.#dels.values()) {
      const d = recs[0].d;
      hw = maxHW(hw, { gen: d.product_root_gen, serial: d.serial, minValid: d.min_valid_serial });
    }
    return hw;
  }

  /** T4's state, including "no valid delegation for current_gen" (evaluated now, never stored). */
  haltReason(): Reason {
    if (this.#halt !== null) return 'trust_halt';
    return this.#serialsOf(this.currentGen()).length > 0 ? 'ok' : 'trust_halt';
  }

  /** The halt rule in force, or null when this trust is not halted. */
  halted(): string | null {
    if (this.#halt !== null) return this.#halt;
    return this.haltReason() === 'ok' ? null : 'T4: no valid delegation for the current generation';
  }

  /**
   * Checks a `trust` envelope (§2.6 order) and admits every item. Ignored items
   * are expected; an intermediate halt does not stop admission.
   */
  async addTrust(envelope: Uint8Array): Promise<Admission> {
    const env = await checkTrustEnvelope(envelope);
    if (!env) return 'malformed';
    for (const it of env.items) {
      if ((await this.addSigned(it)) === 'malformed') return 'malformed';
    }
    return this.#halt === null ? 'admitted' : 'halt';
  }
}

/** T1: a trust over the anchors (`anchors` bytes), or null when they are malformed. */
export const newTrust = (anchors: Uint8Array): Promise<Trust | null> => Trust.fromAnchors(anchors);

/**
 * §2.6's `trust` rule: successions by new_root_gen strictly ascending, then
 * delegations by (gen, serial) strictly ascending. Null when malformed.
 */
export async function checkTrustEnvelope(b: Uint8Array): Promise<TrustEnvelope | null> {
  const env = await decodeAs('trust', b);
  if (!env) return null;
  let lastSucc = -1;
  let lastDel: [number, number] | null = null;
  for (const it of env.items) {
    const s = await decodeAs('signed', it);
    if (!s) return null;
    if (s.type === 'succession') {
      const m = await decodeAs('succession', s.msg);
      if (!m || lastDel !== null || m.new_root_gen <= lastSucc) return null;
      lastSucc = m.new_root_gen;
    } else if (s.type === 'delegation') {
      const d = await decodeAs('delegation', s.msg);
      if (!d) return null;
      const k: [number, number] = [d.product_root_gen, d.serial];
      if (lastDel !== null && cmpPair(k, lastDel) <= 0) return null;
      lastDel = k;
    } else {
      return null;
    }
  }
  return env;
}

const cmpPair = (a: [number, number], b: [number, number]): number => a[0] - b[0] || a[1] - b[1];

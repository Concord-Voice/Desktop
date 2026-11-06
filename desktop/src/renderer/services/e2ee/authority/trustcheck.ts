// The client forms of T6, T7, T8 and T12 (design of record §2.10). Each is
// existential over every valid delegation retained at a (gen, serial): two can
// share a key only in a retired generation, and reading "the D named" as "any
// retained D under that name" keeps the authority's own delegation accepted
// without depending on arrival order.

import { MAX_RSKS } from './constants';
import { sigMsg, verifyOver, type Delegation } from './messages';
import type { Reason } from './reason';
import { maxHW, type HighWater, type Trust } from './trust';

/** §2.10's window: not_before_ms ≤ x < not_after_ms. */
export const covers = (d: Delegation, x: number): boolean =>
  d.not_before_ms <= x && x < d.not_after_ms;

async function anyVerifies(
  keys: Uint8Array[],
  msg: Uint8Array | null,
  sig: Uint8Array
): Promise<boolean> {
  for (const k of keys) if (await verifyOver(k, msg, sig)) return true;
  return false;
}

/**
 * The furthest Reason any of ds reaches under rule, ranked by order (first =
 * least far, last = ok), so a search over several delegations reports one
 * Reason whatever order they arrived in.
 */
async function bestOf(
  ds: Delegation[],
  order: readonly Reason[],
  rule: (d: Delegation) => Promise<Reason>
): Promise<Reason> {
  let best = 0;
  for (const d of ds) best = Math.max(best, order.indexOf(await rule(d)));
  return order[best];
}

const RSK_ORDER: readonly Reason[] = Object.freeze([
  'bad_signature',
  'delegation_window',
  'out_of_scope',
  'ok',
] as const);

/** T6/T7's per-delegation part: an RSK of d (at most MAX_RSKS tried) signed msg, d covers x, scope ∈ d.scope. */
export async function rskRule(
  d: Delegation,
  msg: Uint8Array,
  sig: Uint8Array,
  x: number,
  scope: string
): Promise<Reason> {
  if (!(await anyVerifies(d.rsk_public_keys.slice(0, MAX_RSKS), msg, sig))) return 'bad_signature';
  if (!covers(d, x)) return 'delegation_window';
  if (!d.scope.includes(scope)) return 'out_of_scope';
  return 'ok';
}

/**
 * T6: a status or device-status signature under the HW delegation itself
 * (gen = current_gen, serial ≥ HW.min_valid, not below HW). Returns the
 * effective, never-decreasing HW.
 */
export async function checkT6(
  t: Trust,
  hw: HighWater,
  msg: Uint8Array,
  sig: Uint8Array,
  gen: number,
  serial: number,
  asOf: number
): Promise<[HighWater, Reason]> {
  const halt = t.haltReason();
  if (halt !== 'ok') return [hw, halt];
  const ds = t.delegations(gen, serial);
  if (ds.length === 0) return [hw, 'delegation_unknown'];
  const r = await bestOf(ds, RSK_ORDER, (d) => rskRule(d, msg, sig, asOf, 'status'));
  if (r === 'bad_signature') return [hw, r];
  const eff = maxHW(hw, t.highWater());
  if (gen !== t.currentGen() || serial < eff.minValid || gen !== eff.gen || serial !== eff.serial)
    return [hw, 'status_superseded'];
  if (r !== 'ok') return [hw, r];
  return [eff, 'ok'];
}

/** The fields of a result that T7 reads. */
export interface ResultScope {
  readonly delegation_gen: number;
  readonly delegation_serial: number;
  readonly issued_at_ms: number;
  readonly op: string;
}

/**
 * T7: a result's RSK signature, window and scope (= its op). Returns whether
 * the entry is superseded, which needs a covering status (verifyChain).
 * Callers check the halt first.
 */
export async function checkT7(
  t: Trust,
  hw: HighWater,
  res: ResultScope,
  msg: Uint8Array,
  sig: Uint8Array
): Promise<[boolean, Reason]> {
  const { delegation_gen: gen, delegation_serial: serial, issued_at_ms: issued, op } = res;
  const ds = t.delegations(gen, serial);
  if (ds.length === 0) return [false, 'delegation_unknown'];
  const r = await bestOf(ds, RSK_ORDER, (d) => rskRule(d, msg, sig, issued, op));
  if (r !== 'ok') return [false, r];
  const eff = maxHW(hw, t.highWater());
  const superseded =
    gen < Math.max(t.currentGen(), eff.gen) || (gen === eff.gen && serial < eff.minValid);
  return [superseded, 'ok'];
}

const CAK_ORDER: readonly Reason[] = Object.freeze([
  'cak_unlisted',
  'delegation_window',
  'ok',
] as const);

async function cakRule(
  d: Delegation,
  cpAuthz: Uint8Array,
  sig: Uint8Array,
  assertedAt: number
): Promise<Reason> {
  if (!(await anyVerifies(d.cak_public_keys, cpAuthz, sig))) return 'cak_unlisted';
  return covers(d, assertedAt) ? 'ok' : 'delegation_window';
}

/**
 * T8, the CAK's client form: some retained D′ of gen at a serial ≤ serial
 * admits the CAK signature; else delegation_window when a CAK verified outside
 * its window, else cak_unlisted. Callers check the halt first.
 */
export async function checkT8(
  t: Trust,
  cpAuthz: Uint8Array,
  sig: Uint8Array,
  gen: number,
  serial: number,
  assertedAt: number
): Promise<Reason> {
  let r: Reason = 'cak_unlisted';
  for (const [g, s] of t.sortedKeys()) {
    if (g !== gen || s > serial) continue;
    const got = await bestOf(t.delegations(g, s), CAK_ORDER, (d) =>
      cakRule(d, cpAuthz, sig, assertedAt)
    );
    if (got === 'ok') return 'ok';
    if (got === 'delegation_window') r = got;
  }
  return r;
}

const OPERATOR_ORDER: readonly Reason[] = Object.freeze([
  'bad_signature',
  'delegation_window',
  'ok',
] as const);

/**
 * T12's client form over the delegation the result names, with no lookback
 * to an earlier serial (D-231). Callers check the halt first.
 */
export async function checkT12(
  t: Trust,
  intentDigest: Uint8Array,
  sig: Uint8Array,
  gen: number,
  serial: number,
  assertedAt: number
): Promise<Reason> {
  const ds = t.delegations(gen, serial);
  if (ds.length === 0) return 'delegation_unknown';
  const msg = sigMsg('operator', intentDigest);
  return bestOf(ds, OPERATOR_ORDER, async (d) => {
    if (!(await anyVerifies(d.operator_public_keys, msg, sig))) return 'bad_signature';
    return covers(d, assertedAt) ? 'ok' : 'delegation_window';
  });
}

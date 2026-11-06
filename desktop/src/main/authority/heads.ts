// The persisted chain-head (design of record §2.12, D-269) and the reads a
// verifier makes of it. A head reaches a verifier only from `parseChainHead` or
// an earlier verification; `canonicalHead` refuses any other before a record is
// read, so every index lookup below may assume EN3 order.

import { b64d, b64e } from './bytes';
import { capOf, itemLen } from './codec';
import { decodeAs, encodeAs, type ChainHead } from './messages';
import { sha384 } from './primitives';
import { genesisPub, pubOfResult, type Pub } from './pub';
import type { Reason } from './reason';

export type { ChainHead };

/** The persisted head as bytes; null when it is not a valid chain-head or exceeds HEAD_BLOB_MAX. */
export const chainHeadBytes = (h: ChainHead): Uint8Array | null => encodeAs('chain-head', h);

/** EN5 over a persisted chain-head; null when malformed. */
export const parseChainHead = (b: Uint8Array): Promise<ChainHead | null> =>
  decodeAs('chain-head', b);

/** The head of an account with no event. It carries no pin: the seq-0 pin is AccountMemory's (V3-05). */
export function genesisHead(realm: string, account: string): ChainHead {
  const none = new Uint8Array(0);
  return {
    realm_id: realm,
    account_id: account,
    head_result: none,
    fix: none,
    active_ek_spki: none,
    active_ek_generation: 0,
    pending_ek_spki: none,
    pending_ek_generation: 0,
    pending_recovery_key: none,
    seq_index: [],
    root_index: [],
    ek_index: [],
    recover_index: [],
  };
}

export const seqRecord = (entry: Uint8Array, bindRootDigest: Uint8Array): string =>
  `${b64e(entry)}.${b64e(bindRootDigest)}`;
export const rootRecord = (rootDigest: Uint8Array, root: Uint8Array, seg: string): string =>
  `${b64e(rootDigest)}.${b64e(root)}.${seg}`;
export const recoverRecord = (seq: number, keyDigest: Uint8Array): string =>
  `${seq}.${b64e(keyDigest)}`;

const ascending = (xs: readonly string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1] < x);

/**
 * Whether h is canonical: every a<…> index strictly ascending in EN3 order and
 * the whole head encodable. A parsed or verified head always is.
 */
export function canonicalHead(h: ChainHead): boolean {
  try {
    return (
      ascending(h.root_index) &&
      ascending(h.recover_index) &&
      ascending(h.ek_index.map(b64e)) &&
      chainHeadBytes(h) !== null
    );
  } catch {
    return false;
  }
}

/** The first index of a sorted array whose key is at or above s. key runs only at the probes. */
export function lowerBound<T>(xs: readonly T[], s: string, key: (x: T) => string = String): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(xs[mid]) < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** s inserted into a sorted a<s>; a duplicate returns xs itself. Never writes xs. */
export function insertSorted(xs: readonly string[], s: string): string[] {
  const i = lowerBound(xs, s);
  if (xs[i] === s) return xs as string[];
  return [...xs.slice(0, i), s, ...xs.slice(i)];
}

// ── Sizing the head without re-encoding it (E3-08, linear in the chain) ─────
//
// A step must never produce a head over HEAD_BLOB_MAX. Re-encoding the whole
// head after every step makes first contact with a long chain quadratic, so,
// like the reference's headMove.fits, the four index positions are sized
// incrementally: every index array a move builds records its encoded length,
// derived from its source array's length plus the bytes the move adds. The
// positions outside the indexes are bounded and are re-encoded each step.
// Correct only while every index edit goes through the helpers below and every
// head starts canonical (canonicalHead), as the verifiers require.

type IndexName = 'seq_index' | 'root_index' | 'ek_index' | 'recover_index';
const INDEXES: readonly IndexName[] = ['seq_index', 'root_index', 'ek_index', 'recover_index'];

/** Encoded length of an index array (`[…]`), by array identity; -1 when the codec refuses a record. */
const posLens = new WeakMap<readonly unknown[], number>();

const recLen = (name: IndexName, it: string | Uint8Array): number =>
  itemLen('chain-head', name, it);

function posLen(name: IndexName, xs: readonly (string | Uint8Array)[]): number {
  const known = posLens.get(xs);
  if (known !== undefined) return known;
  let n = 2;
  for (let i = 0; i < xs.length && n >= 0; i++) {
    const l = recLen(name, xs[i]);
    n = l < 0 ? -1 : n + l + (i > 0 ? 1 : 0);
  }
  posLens.set(xs, n);
  return n;
}

function derive<T extends string | Uint8Array>(
  name: IndexName,
  from: readonly T[],
  to: T[],
  delta: number
): T[] {
  const p = posLen(name, from);
  posLens.set(to, p < 0 || delta < 0 ? -1 : p + delta);
  return to;
}

/** One record added to a position that held n records: the record and, after the first, a separator. */
function added(name: IndexName, it: string | Uint8Array, n: number): number {
  const l = recLen(name, it);
  return l < 0 ? -1 : l + (n > 0 ? 1 : 0);
}

/** A record inserted into a sorted a<s> position, sized. Never writes xs. */
export function insertRecord(
  name: 'root_index' | 'recover_index',
  xs: readonly string[],
  s: string
): string[] {
  const out = insertSorted(xs, s);
  return out === xs ? out : derive(name, xs, out, added(name, s, xs.length));
}

/** A digest inserted into ek_index (ascending over its base64 text, EN3), sized. Never writes xs. */
export function insertEkDigest(xs: readonly Uint8Array[], d: Uint8Array): Uint8Array[] {
  const s = b64e(d);
  const i = lowerBound(xs, s, b64e);
  if (i < xs.length && b64e(xs[i]) === s) return xs as Uint8Array[];
  return derive(
    'ek_index',
    xs,
    [...xs.slice(0, i), d, ...xs.slice(i)],
    added('ek_index', d, xs.length)
  );
}

/** seq_index record i replaced by rec, sized. Never writes xs. */
export function replaceSeqRecord(xs: readonly string[], i: number, rec: string): string[] {
  const out = [...xs];
  out[i] = rec;
  const was = recLen('seq_index', xs[i]);
  const now = recLen('seq_index', rec);
  return derive('seq_index', xs, out, was < 0 || now < 0 ? -1 : now - was);
}

/**
 * rec appended to seq_index IN PLACE, sized. xs must belong to the running
 * verification (ownedHead), never to a head a caller passed in. Returns the
 * undo: the pop that restores xs and its size.
 */
export function pushSeqRecord(xs: string[], rec: string): () => void {
  const p = posLen('seq_index', xs);
  const d = added('seq_index', rec, xs.length);
  xs.push(rec);
  posLens.set(xs, p < 0 || d < 0 ? -1 : p + d);
  return () => {
    xs.pop();
    posLens.set(xs, p);
  };
}

/** A head whose seq_index the running verification may extend in place; h is not written. */
export const ownedHead = (h: ChainHead): ChainHead => ({ ...h, seq_index: [...h.seq_index] });

/** Whether h encodes within HEAD_BLOB_MAX: chainHeadBytes(h) !== null for a canonical head, without re-encoding its indexes. */
export function headFits(h: ChainHead): boolean {
  let idx = 0;
  for (const name of INDEXES) {
    const l = posLen(name, h[name]);
    if (l < 0) return false;
    idx += l;
  }
  const rest = chainHeadBytes({
    ...h,
    seq_index: [],
    root_index: [],
    ek_index: [],
    recover_index: [],
  });
  return rest !== null && rest.length - INDEXES.length * 2 + idx <= capOf('chain-head');
}

/**
 * The root_index record of digest d with its "<d b64>." prefix cut, or null.
 * The first record at or above the prefix is the first record of d.
 */
export function rootRecordOf(h: ChainHead, d: Uint8Array): string | null {
  const prefix = `${b64e(d)}.`;
  const rec = h.root_index[lowerBound(h.root_index, prefix)];
  return rec?.startsWith(prefix) ? rec.slice(prefix.length) : null;
}

/** The 97-byte root point root_index records for digest d, or null. */
export function rootByDigest(h: ChainHead, d: Uint8Array): Uint8Array | null {
  const rest = rootRecordOf(h, d);
  if (rest === null) return null;
  try {
    return b64d(rest.slice(0, rest.indexOf('.')));
  } catch {
    return null;
  }
}

/** d ∈ ek_index, by binary search over the base64 text (EN3). */
export function ekIndexHas(h: ChainHead, d: Uint8Array): boolean {
  const s = b64e(d);
  const i = lowerBound(h.ek_index, s, b64e);
  return i < h.ek_index.length && b64e(h.ek_index[i]) === s;
}

/** The root_index assurance of a root (D-182, §2.22 check 5); "" when the root is not recorded. */
export async function segmentOf(h: ChainHead, root: Uint8Array): Promise<string> {
  if (root.length === 0) return '';
  const rest = rootRecordOf(h, await sha384(root));
  return rest === null ? '' : rest.slice(rest.lastIndexOf('.') + 1);
}

/**
 * The head's published state. The genesis head is absent with no pin; a head
 * whose seq_index length is not its result's seq is malformed.
 */
export async function headPub(h: ChainHead): Promise<[Pub, Reason]> {
  if (h.head_result.length === 0) {
    return h.seq_index.length === 0 ? [genesisPub(), 'ok'] : [genesisPub(), 'malformed'];
  }
  const r = await decodeAs('result', h.head_result);
  if (r?.seq !== h.seq_index.length) return [genesisPub(), 'malformed'];
  return [
    await pubOfResult(r, h.head_result, h.active_ek_generation, h.pending_ek_generation),
    'ok',
  ];
}

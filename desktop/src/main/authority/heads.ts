// The persisted chain-head (design of record §2.12, D-269) and the reads a
// verifier makes of it. A head reaches a verifier only from `parseChainHead` or
// an earlier verification; `canonicalHead` refuses any other before a record is
// read, so every index lookup below may assume EN3 order.

import { b64d, b64e } from './bytes';
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

/** The first index of a sorted array at or above s. */
export function lowerBound(xs: readonly string[], s: string): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** s inserted into a sorted a<s>; a duplicate is a no-op. Never writes xs. */
export function insertSorted(xs: readonly string[], s: string): string[] {
  const i = lowerBound(xs, s);
  if (xs[i] === s) return [...xs];
  return [...xs.slice(0, i), s, ...xs.slice(i)];
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
  const xs = h.ek_index.map(b64e);
  const s = b64e(d);
  return xs[lowerBound(xs, s)] === s;
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

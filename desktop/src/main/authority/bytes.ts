// Byte helpers for the account-key authority contract (design of record §2.3).
// Runtime-neutral: no Buffer. Base64 is the strict RFC 4648 §3.5 form plus the
// EN5 rule that a value must re-encode to the identical string.

import { Malformed } from './errors';

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CHUNK = 0x8000;

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function b64e(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += CHUNK) s += String.fromCodePoint(...b.subarray(i, i + CHUNK));
  return btoa(s);
}

export function b64d(s: string): Uint8Array {
  if (!B64_RE.test(s)) throw new Malformed('base64 form');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.codePointAt(i) ?? 0;
  if (b64e(out) !== s) throw new Malformed('base64 canonical');
  return out;
}

/** Early-exit compare: public data only, never secrets or MACs. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Code-unit order, the order of the reference's `<` comparisons. */
export function cmp(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Malformed('hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Web Crypto wants a BufferSource backed by an ArrayBuffer; copy views onto one. */
export const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer;

// Protocol constants (design of record §2.3). Frozen in protocol v1.

export const EPSILON_MS = 120_000;
export const V_MAX_MS = 259_200_000;
export const DELEGATION_LIFETIME_MAX_MS = 34_560_000_000;
export const DELTA_MAX_MS = 2_592_000_000;
export const INTENT_WINDOW_MS = 660_000;
export const CANCEL_SLACK_MS = 60_000;
export const ANB_NEVER = Number.MAX_SAFE_INTEGER;
export const MAX_RSKS = 4;

/** Sums u values exactly, or null above 2^53 − 1 (R1, R2). */
export function addMs(...xs: number[]): number | null {
  let s = 0;
  for (const x of xs) {
    if (!Number.isSafeInteger(x) || x < 0 || x > Number.MAX_SAFE_INTEGER - s) return null;
    s += x;
  }
  return s;
}

/** a + b < c over u values, exact above 2^53 (no rounded sum is compared). */
export const sumBelow = (a: number, b: number, c: number): boolean =>
  BigInt(a) + BigInt(b) < BigInt(c);

export const MAX_DEVICES = 10;
export const RECOVERY_REPLACE_MS = 2_592_000_000;

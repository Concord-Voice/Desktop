/**
 * A token bucket over capture-move CEREMONIES SHOWN (#87 §3.3), separate from the
 * self-hosted approval budget so neither kind can starve the other.
 *
 * Capacity 3, refilled one token per 20 s: a user moving voice between connections
 * answers one dialog per move, while a renderer raising the dialog in a loop gets at
 * most one every 20 s once the first three are spent.
 *
 * Same API shape as `selfHostedCeremonyBudget.ts` and in-memory for the same reason:
 * it bounds a burst within one app session, not across a relaunch.
 */
export const CAPTURE_CEREMONY_CAPACITY = 3;
export const CAPTURE_CEREMONY_REFILL_MS = 20_000;

let tokens = CAPTURE_CEREMONY_CAPACITY;
// The instant the next refill is counted from. Advanced by whole refill periods only,
// so a partial period is never lost, and pinned to `now` while the bucket is full, so
// a full bucket accrues nothing towards later spends.
let refilledAt = Number.NEGATIVE_INFINITY;

function refill(now: number): void {
  if (tokens >= CAPTURE_CEREMONY_CAPACITY) {
    refilledAt = Math.max(refilledAt, now);
    return;
  }
  // A clock that moved backwards earns nothing.
  if (now <= refilledAt) return;
  const earned = Math.floor((now - refilledAt) / CAPTURE_CEREMONY_REFILL_MS);
  if (earned === 0) return;
  tokens = Math.min(CAPTURE_CEREMONY_CAPACITY, tokens + earned);
  refilledAt =
    tokens === CAPTURE_CEREMONY_CAPACITY ? now : refilledAt + earned * CAPTURE_CEREMONY_REFILL_MS;
}

/** Spends one token and returns true, or returns false without spending. */
export function consumeCaptureCeremonyToken(now: number = Date.now()): boolean {
  if (!Number.isFinite(now)) return false;
  refill(now);
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

export function _resetCaptureCeremonyBudgetForTesting(): void {
  tokens = CAPTURE_CEREMONY_CAPACITY;
  refilledAt = Number.NEGATIVE_INFINITY;
}

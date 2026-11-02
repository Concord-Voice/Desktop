/** Whole-reason parsing for the event-budget 1013 close contract. */
function validRetryAfterMs(reason: string): number | null {
  const match = /^retry_after_ms=([1-9]\d{2,4})$/.exec(reason);
  // JavaScript's $ also matches before a final newline; require the whole input.
  if (match?.[0].length !== reason.length) return null;
  const delay = Number(match[1]);
  return delay >= 100 && delay <= 30000 ? delay : null;
}

export function parseWsRetryAfterMs(reason: string): number {
  return validRetryAfterMs(reason) ?? 1000;
}

export function summarizeWsClose(
  code: number,
  reason: string
): {
  code: number;
  reason: 'retry_after_valid' | 'retry_after_fallback' | 'unspecified';
  retryAfterMs?: number;
} {
  if (code !== 1013) return { code, reason: 'unspecified' };
  const delay = validRetryAfterMs(reason);
  return {
    code,
    reason: delay === null ? 'retry_after_fallback' : 'retry_after_valid',
    retryAfterMs: delay ?? 1000,
  };
}

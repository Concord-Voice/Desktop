import { describe, expect, it } from 'vitest';
import { parseWsRetryAfterMs, summarizeWsClose } from '@/renderer/services/messaging/wsEventBudget';

describe('whole ASCII 1013 retry reason', () => {
  it.each([
    [100, '100'],
    [1000, '1000'],
    [5000, '5000'],
    [30000, '30000'],
  ])('retains %i', (expected, digits) => {
    expect(parseWsRetryAfterMs(`retry_after_ms=${digits}`)).toBe(expected);
  });
  it.each([
    '',
    'unknown',
    'retry_after_ms=0',
    'retry_after_ms=99',
    'retry_after_ms=30001',
    'retry_after_ms=99999',
    'retry_after_ms=100000',
    'retry_after_ms=01000',
    'retry_after_ms=+1000',
    'retry_after_ms=-1000',
    'retry_after_ms= 1000',
    ' retry_after_ms=1000',
    'retry_after_ms=1000 ',
    'retry_after_ms=1000.0',
    'retry_after_ms=1e3',
    'retry_after_ms=1000;other=1',
    'retry_after_ms=1000\n',
    'retry_after_ms=1000\r',
    'retry_after_ms=1000\r\n',
    'retry_after_ms=1000\u2028',
    'retry_after_ms=1000\u2029',
    'retry_after_ms=１０００',
    'retry_after_ms=١٠٠٠',
  ])('falls back for %j', (reason) => {
    expect(parseWsRetryAfterMs(reason)).toBe(1000);
  });
  it('classifies accepted reasons without retaining raw text', () => {
    expect(summarizeWsClose(1013, 'retry_after_ms=30000')).toEqual({
      code: 1013,
      reason: 'retry_after_valid',
      retryAfterMs: 30000,
    });
  });
  it('bounds invalid reason classification', () => {
    expect(summarizeWsClose(1013, 'private-SENTINEL')).toEqual({
      code: 1013,
      reason: 'retry_after_fallback',
      retryAfterMs: 1000,
    });
    expect(summarizeWsClose(1006, 'retry_after_ms=30000')).toEqual({
      code: 1006,
      reason: 'unspecified',
    });
  });
});

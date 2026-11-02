import { describe, expect, it } from 'vitest';
import {
  summarizeWsDiagnostic,
  summarizeWsServerError,
} from '@/renderer/utils/runtime/wsDiagnostics';

describe('summarizeWsDiagnostic', () => {
  it('summarizes CloseEvent metadata without logging the raw event', () => {
    expect(
      summarizeWsDiagnostic(new CloseEvent('close', { code: 1006, reason: 'abnormal' }))
    ).toEqual({
      type: 'CloseEvent',
      event: 'close',
      code: 1006,
      reason: 'unspecified',
    });
  });

  it('classifies blank CloseEvent reasons', () => {
    expect(summarizeWsDiagnostic(new CloseEvent('close', { code: 1005 }))).toEqual({
      type: 'CloseEvent',
      event: 'close',
      code: 1005,
      reason: 'unspecified',
    });
  });

  it('summarizes Error instances with the redacted message helper', () => {
    expect(summarizeWsDiagnostic(new TypeError('socket failed'))).toEqual({
      type: 'TypeError',
      message: 'socket failed',
    });
  });

  it('summarizes generic Event instances by constructor and event type', () => {
    expect(summarizeWsDiagnostic(new Event('error'))).toEqual({
      type: 'Event',
      event: 'error',
    });
  });

  it('falls back to the value type for non-event values', () => {
    expect(summarizeWsDiagnostic(undefined)).toEqual({ type: 'undefined' });
    expect(summarizeWsDiagnostic('error')).toEqual({ type: 'string' });
  });
});

describe('summarizeWsServerError', () => {
  it('summarizes whitelisted server error fields', () => {
    expect(
      summarizeWsServerError({
        code: 'stale_epoch',
        channel_id: 'channel-1',
        current_epoch: 12,
      })
    ).toEqual({
      type: 'server_error',
      code: 'stale_epoch',
      channelId: 'channel-1',
      currentEpoch: 12,
    });
  });

  it('uses unknown for missing or non-string server codes', () => {
    expect(summarizeWsServerError({})).toEqual({
      type: 'server_error',
      code: 'unknown',
    });
    expect(summarizeWsServerError({ code: 401 })).toEqual({
      type: 'server_error',
      code: 'unknown',
    });
  });
});

describe('bounded event-budget diagnostics at direct boundary', () => {
  it('retains only validated class and retry for the special advisory', () => {
    const data = {
      code: 'ws_rate_limited',
      event_class: 'profile',
      retry_after_ms: 5000,
      channel_id: 'private-channel',
      current_epoch: 8,
      payload: 'private-payload',
    };
    expect(summarizeWsServerError(data)).toEqual({
      type: 'server_error',
      code: 'ws_rate_limited',
      eventClass: 'profile',
      retryAfterMs: 5000,
    });
  });
  it.each([
    { event_class: 'attacker-SENTINEL', retry_after_ms: 5000 },
    { event_class: 'profile', retry_after_ms: '5000' },
    { event_class: 'profile', retry_after_ms: 99 },
    { event_class: 'profile', retry_after_ms: 30001 },
    { event_class: 'profile', retry_after_ms: 100.5 },
    { event_class: 'profile', retry_after_ms: NaN },
    { event_class: 'profile', retry_after_ms: Infinity },
    { event_class: 'profile' },
    { retry_after_ms: 5000 },
    {},
  ])('drops unvalidated advisory values %j', (fields) => {
    const data = { code: 'ws_rate_limited', channel_id: 'private-SENTINEL', ...fields };
    expect(summarizeWsServerError(data)).toEqual({ type: 'server_error', code: 'ws_rate_limited' });
  });
  it('never emits an attacker close reason', () => {
    expect(
      summarizeWsDiagnostic(new CloseEvent('close', { code: 1013, reason: 'secret-SENTINEL' }))
    ).toEqual({
      type: 'CloseEvent',
      event: 'close',
      code: 1013,
      reason: 'retry_after_fallback',
      retryAfterMs: 1000,
    });
  });
});

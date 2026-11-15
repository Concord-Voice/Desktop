import { describe, expect, it } from 'vitest';
import {
  CAPTURE_ACQUIRE,
  CAPTURE_LEASE_PUSH,
  CAPTURE_LEASE_REVOKED_PUSH,
  CAPTURE_RELEASE,
  isCaptureAcquireInput,
  isCaptureAcquireResult,
  isCaptureIntent,
  isCaptureLeaseRevoked,
  isCaptureLeaseState,
} from '../../../src/shared/captureLease';

describe('capture lease channel constants', () => {
  it('equal their literal channel strings', () => {
    expect(CAPTURE_ACQUIRE).toBe('capture:acquire');
    expect(CAPTURE_RELEASE).toBe('capture:release');
    expect(CAPTURE_LEASE_PUSH).toBe('capture:lease');
    expect(CAPTURE_LEASE_REVOKED_PUSH).toBe('capture:leaseRevoked');
  });
});

describe('isCaptureIntent', () => {
  it('accepts both intents', () => {
    expect(isCaptureIntent('voice-join')).toBe(true);
    expect(isCaptureIntent('device-test')).toBe(true);
  });
  it.each(['screen', '', 1, null, undefined, {}])('rejects %j', (v) => {
    expect(isCaptureIntent(v)).toBe(false);
  });
});

describe('isCaptureAcquireInput', () => {
  it('accepts exactly { intent }', () => {
    expect(isCaptureAcquireInput({ intent: 'voice-join' })).toBe(true);
    expect(isCaptureAcquireInput({ intent: 'device-test' })).toBe(true);
  });
  it('rejects an extra key, a missing key, a bad intent and non-objects', () => {
    expect(isCaptureAcquireInput({ intent: 'voice-join', leaseId: 'x' })).toBe(false);
    expect(isCaptureAcquireInput({})).toBe(false);
    expect(isCaptureAcquireInput({ intent: 'screen' })).toBe(false);
    expect(isCaptureAcquireInput(null)).toBe(false);
    expect(isCaptureAcquireInput('voice-join')).toBe(false);
    expect(isCaptureAcquireInput(['voice-join'])).toBe(false);
  });
});

describe('isCaptureAcquireResult', () => {
  it.each([
    { status: 'granted' },
    { status: 'held' },
    { status: 'declined' },
    { status: 'rejected', reason: 'untrusted-sender' },
    { status: 'rejected', reason: 'not-foreground' },
    { status: 'rejected', reason: 'busy' },
    { status: 'rejected', reason: 'superseded' },
    { status: 'rejected', reason: 'unavailable' },
  ])('accepts %j', (v) => {
    expect(isCaptureAcquireResult(v)).toBe(true);
  });
  it.each([
    { status: 'rejected' },
    { status: 'granted', extra: 1 },
    { status: 'held', reason: 'busy' },
    { status: 'rejected', reason: 'nope' },
    { status: 'rejected', reason: 'busy', extra: 1 },
    { status: 'other' },
    {},
    null,
    'granted',
  ])('rejects %j', (v) => {
    expect(isCaptureAcquireResult(v)).toBe(false);
  });
});

describe('isCaptureLeaseState', () => {
  it('accepts exactly two booleans', () => {
    expect(isCaptureLeaseState({ held: true, mine: false })).toBe(true);
    expect(isCaptureLeaseState({ held: false, mine: false })).toBe(true);
  });
  it('rejects non-booleans, missing and extra keys', () => {
    expect(isCaptureLeaseState({ held: 1, mine: false })).toBe(false);
    expect(isCaptureLeaseState({ held: true })).toBe(false);
    expect(isCaptureLeaseState({ held: true, mine: false, extra: 1 })).toBe(false);
    expect(isCaptureLeaseState(null)).toBe(false);
  });
});

describe('isCaptureLeaseRevoked', () => {
  it('accepts exactly { reason } with a known reason', () => {
    expect(isCaptureLeaseRevoked({ reason: 'moved' })).toBe(true);
    expect(isCaptureLeaseRevoked({ reason: 'backgrounded' })).toBe(true);
  });
  it('rejects an extra key, an unknown reason and non-objects', () => {
    expect(isCaptureLeaseRevoked({ reason: 'moved', id: 'x' })).toBe(false);
    expect(isCaptureLeaseRevoked({ reason: 'other' })).toBe(false);
    expect(isCaptureLeaseRevoked({})).toBe(false);
    expect(isCaptureLeaseRevoked(undefined)).toBe(false);
  });
});

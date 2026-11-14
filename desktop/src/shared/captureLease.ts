/**
 * Capture lease (#87) — channel names, payload types and exact-key guards.
 *
 * Pure TypeScript with no imports: the sandboxed preload and the renderer both
 * load this module. Every guard checks the exact key set, so a payload with an
 * extra or missing key is dropped rather than copied through.
 */

export const CAPTURE_ACQUIRE = 'capture:acquire';
export const CAPTURE_RELEASE = 'capture:release';
export const CAPTURE_LEASE_PUSH = 'capture:lease';
export const CAPTURE_LEASE_REVOKED_PUSH = 'capture:leaseRevoked';

export type CaptureIntent = 'voice-join' | 'device-test';
export type CaptureRejectReason =
  'untrusted-sender' | 'not-foreground' | 'busy' | 'superseded' | 'unavailable';

export type CaptureAcquireResult =
  | { status: 'granted' }
  | { status: 'held' }
  | { status: 'declined' }
  | { status: 'rejected'; reason: CaptureRejectReason };

export interface CaptureAcquireInput {
  intent: CaptureIntent;
}
export interface CaptureLeaseState {
  held: boolean;
  mine: boolean;
}
export interface CaptureLeaseRevoked {
  reason: 'moved' | 'backgrounded';
}

const INTENTS: readonly string[] = ['voice-join', 'device-test'];
const REJECT_REASONS: readonly string[] = [
  'untrusted-sender',
  'not-foreground',
  'busy',
  'superseded',
  'unavailable',
];
const REVOKE_REASONS: readonly string[] = ['moved', 'backgrounded'];

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

export function isCaptureIntent(v: unknown): v is CaptureIntent {
  return typeof v === 'string' && INTENTS.includes(v);
}

export function isCaptureAcquireInput(v: unknown): v is CaptureAcquireInput {
  return isPlainRecord(v) && hasExactKeys(v, ['intent']) && isCaptureIntent(v.intent);
}

export function isCaptureAcquireResult(v: unknown): v is CaptureAcquireResult {
  if (!isPlainRecord(v)) return false;
  if (v.status === 'rejected') {
    return (
      hasExactKeys(v, ['status', 'reason']) &&
      typeof v.reason === 'string' &&
      REJECT_REASONS.includes(v.reason)
    );
  }
  return (
    (v.status === 'granted' || v.status === 'held' || v.status === 'declined') &&
    hasExactKeys(v, ['status'])
  );
}

export function isCaptureLeaseState(v: unknown): v is CaptureLeaseState {
  return (
    isPlainRecord(v) &&
    hasExactKeys(v, ['held', 'mine']) &&
    typeof v.held === 'boolean' &&
    typeof v.mine === 'boolean'
  );
}

export function isCaptureLeaseRevoked(v: unknown): v is CaptureLeaseRevoked {
  return (
    isPlainRecord(v) &&
    hasExactKeys(v, ['reason']) &&
    typeof v.reason === 'string' &&
    REVOKE_REASONS.includes(v.reason)
  );
}

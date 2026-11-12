/**
 * Capture lease client (#87 §3.8) — a service, not a store.
 *
 * Wraps the preload bridge `globalThis.electron.capture` (contract 35). A shell below
 * 35 has no `capture` key: `acquire` then answers `granted` and `release` is a no-op,
 * which is today's behaviour. Main authorises everything; this module only forwards an
 * intent and maps the answers for the renderer.
 */
import {
  isCaptureAcquireResult,
  type CaptureAcquireInput,
  type CaptureAcquireResult,
  type CaptureIntent,
  type CaptureLeaseRevoked,
  type CaptureLeaseState,
  type CaptureRejectReason,
} from '../../../shared/captureLease';

export type CaptureLeaseView = 'none' | 'mine' | 'other';
export type CaptureFailureReason = CaptureRejectReason | 'held' | 'ipc-error';
export type CaptureRevokedReason = CaptureLeaseRevoked['reason'];

/** Event name on `captureRevokedEvents`; `detail` is the revocation reason. */
export const CAPTURE_REVOKED_EVENT = 'capture-revoked';

/**
 * Renderer copy (§3.8, verbatim). Never names a service: "call", "connection",
 * "microphone" only (D5). When #88 renames "connection", every string changes together.
 */
export const CAPTURE_LEASE_COPY = {
  hint: 'Your microphone is in a call on another connection. Joining here will ask before ending that call.',
  deviceTestHeld:
    'Your microphone is in a call on another connection. Leave that call to test it here.',
  deviceTestBackgrounded:
    'Your test stopped when you switched to another connection. Start it again to keep testing.',
  pending: 'Joining voice…',
  declined: 'Staying on your current call.',
  banner: 'Your call ended because your microphone moved to another connection.',
  dismiss: 'Dismiss',
} as const;

const RESTART_COPY = "Couldn't start voice. Restart Concord Voice and try again.";

/**
 * The join-failure line for a non-grant. `held` only ever answers a device test, so it
 * maps to the device-test held line; `untrusted-sender`, an IPC throw and anything
 * unrecognised share the restart line.
 */
export function captureLeaseMessage(reason: CaptureFailureReason | 'unknown'): string {
  switch (reason) {
    case 'busy':
      return "You've asked to switch a few times quickly. Wait a moment, then try again.";
    case 'not-foreground':
      return "Voice can start only on the connection you're viewing. Join again from here.";
    case 'unavailable':
      return "This connection doesn't offer voice.";
    case 'superseded':
      return 'Your connection restarted before voice could start. Join again.';
    case 'held':
      return CAPTURE_LEASE_COPY.deviceTestHeld;
    default:
      return RESTART_COPY;
  }
}

/** Thrown by `joinChannel` for a non-grant other than `declined`; message is the copy. */
export class CaptureLeaseError extends Error {
  readonly reason: CaptureFailureReason;

  constructor(reason: CaptureFailureReason) {
    super(captureLeaseMessage(reason));
    this.name = 'CaptureLeaseError';
    this.reason = reason;
  }
}

interface CaptureBridge {
  acquire: (input: CaptureAcquireInput) => Promise<CaptureAcquireResult>;
  release: (input: CaptureAcquireInput) => Promise<boolean>;
  onLeaseChanged: (callback: (state: CaptureLeaseState) => void) => () => void;
  onLeaseRevoked: (callback: (revoked: CaptureLeaseRevoked) => void) => () => void;
}

// Typed Partial: a shell below contract 35 lacks the key, whatever the static type says.
function bridge(): Partial<CaptureBridge> | undefined {
  return globalThis.electron?.capture as Partial<CaptureBridge> | undefined;
}

const IPC_ERROR = { status: 'rejected', reason: 'ipc-error' } as const;

// Pending voice-join acquires: the controls and the announcer read this through
// useSyncExternalStore, from the click until main answers (the ceremony can be long).
let pendingJoins = 0;
const pendingListeners = new Set<() => void>();

function setPendingJoins(next: number): void {
  const was = pendingJoins > 0;
  pendingJoins = next;
  if (was !== pendingJoins > 0) for (const cb of pendingListeners) cb();
}

export function isAcquirePending(): boolean {
  return pendingJoins > 0;
}

export function subscribeAcquirePending(cb: () => void): () => void {
  pendingListeners.add(cb);
  return () => {
    pendingListeners.delete(cb);
  };
}

export async function acquire(
  intent: CaptureIntent
): Promise<CaptureAcquireResult | { status: 'rejected'; reason: 'ipc-error' }> {
  const invoke = bridge()?.acquire;
  if (typeof invoke !== 'function') return { status: 'granted' };
  const tracked = intent === 'voice-join';
  if (tracked) setPendingJoins(pendingJoins + 1);
  try {
    const result: unknown = await invoke({ intent });
    // The invoke reply is not guarded by the preload; fail closed on any other shape.
    if (!isCaptureAcquireResult(result)) return IPC_ERROR;
    if (intent === 'device-test' && result.status === 'granted') deviceTestHolds += 1;
    return result;
  } catch {
    return IPC_ERROR;
  } finally {
    if (tracked) setPendingJoins(pendingJoins - 1);
  }
}

/**
 * Main keeps one `device-test` claim, but a mic test, a camera test and the webcam probe
 * can overlap on one page. The claim is released only when the last of them lets go,
 * otherwise a finished probe would free the lease under a running mic test.
 */
let deviceTestHolds = 0;

/** Never rejects, so cleanup paths can fire it with `void`. */
export async function release(intent: CaptureIntent): Promise<boolean> {
  const invoke = bridge()?.release;
  if (typeof invoke !== 'function') return false;
  if (intent === 'device-test' && deviceTestHolds > 1) {
    deviceTestHolds -= 1;
    return true;
  }
  if (intent === 'device-test') deviceTestHolds = 0;
  try {
    return (await invoke({ intent })) === true;
  } catch {
    return false;
  }
}

export function leaseViewOf(s: CaptureLeaseState): CaptureLeaseView {
  if (s.mine) return 'mine';
  return s.held ? 'other' : 'none';
}

/** The preload replays the last push to a new subscriber (Review Focus 1). */
export function subscribeLeaseState(cb: (v: CaptureLeaseView) => void): () => void {
  const subscribe = bridge()?.onLeaseChanged;
  if (typeof subscribe !== 'function') return () => undefined;
  return subscribe((s) => cb(leaseViewOf(s)));
}

export function subscribeLeaseRevoked(cb: (r: CaptureLeaseRevoked) => void): () => void {
  const subscribe = bridge()?.onLeaseRevoked;
  if (typeof subscribe !== 'function') return () => undefined;
  return subscribe(cb);
}

/**
 * Device-test hooks and the webcam capability probe listen here and stop their streams.
 * Dispatches `CustomEvent<CaptureRevokedReason>(CAPTURE_REVOKED_EVENT)`.
 */
export const captureRevokedEvents: EventTarget = new EventTarget();

export function dispatchCaptureRevoked(reason: CaptureRevokedReason): void {
  // Main has already ended the claim; the stopping tests' own releases must not be held back.
  deviceTestHolds = 0;
  captureRevokedEvents.dispatchEvent(
    new CustomEvent<CaptureRevokedReason>(CAPTURE_REVOKED_EVENT, { detail: reason })
  );
}

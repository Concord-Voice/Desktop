/**
 * `capture:acquire` and `capture:release` (#87 spec §3.9, IPC contract 35).
 *
 * Both are `connection-bound`: the registry admits a bound PRIMARY main frame whose URL is
 * permitted for its connection's kind, and hands the lease the `ConnectionSender` it took
 * in the same tick. Everything past admission (foreground-only fresh acquire, holder
 * re-acquire from anywhere, claims, the consent handoff, `requireOwner` on release) is
 * `captureLease.ts`'s.
 *
 * THE REFUSAL MAPPING (RC-13). `registerIpc`'s default refusal is
 * `{ status: 'rejected', reason: SenderRefusal }`, and `SenderRefusal` includes
 * `wrong-owner`, `not-saas` and `not-primary`, which are not `CaptureRejectReason`s: the
 * preload's exact-key guard would drop such a reply and the renderer would read nothing.
 * So the acquire refusal is explicit: `not-foreground` stays, and every other value, an
 * unknown one included, becomes `untrusted-sender`. A refused release is `false`. What
 * breaks it: a refusal that returns a reason outside `CaptureRejectReason`.
 */
import type { IpcMainInvokeEvent } from 'electron';

import {
  CAPTURE_ACQUIRE,
  CAPTURE_RELEASE,
  type CaptureAcquireResult,
} from '../../shared/captureLease';
import { acquire, release } from '../captureLease';
import type { ConnectionSender, SenderRefusal } from './connectionSender';
import { registerIpc } from './registry';

/** The admission refusal of `capture:acquire`, inside `CaptureRejectReason` (RC-13). */
export function captureAcquireRefusal(reason: SenderRefusal): CaptureAcquireResult {
  return {
    status: 'rejected',
    reason: reason === 'not-foreground' ? 'not-foreground' : 'untrusted-sender',
  };
}

/** Registers both capture-lease invokes. Once per process: `registerIpc` refuses a repeat. */
export function registerCaptureIpc(): void {
  registerIpc(
    CAPTURE_ACQUIRE,
    'connection-bound',
    (sender: ConnectionSender, _event: IpcMainInvokeEvent, input: unknown) =>
      acquire(sender, input),
    { refusal: (reason: SenderRefusal) => Promise.resolve(captureAcquireRefusal(reason)) }
  );
  registerIpc(
    CAPTURE_RELEASE,
    'connection-bound',
    (sender: ConnectionSender, event: IpcMainInvokeEvent, input: unknown): boolean =>
      release(sender, event, input),
    { refusal: () => false }
  );
}

// The capture arbiter (#87 spec §3.5, plan Task 4). It replaces #86's default
// arbiter for the two capture permissions and delegates every other permission to it.
//
// INVARIANT: a capture REQUEST is granted only to a document that is (a) bound, (b) a
// connection's primary, (c) asking from its main frame, (d) the current generation of
// a live record, and (e) the capture-lease holder, or able to take the §5.2 legacy
// implicit lease right now. (a)-(d) are checked here, in that order, BEFORE any lease
// question: `legacyAcquire` GRANTS as a side effect and its contract is "the caller has
// proven a primary main frame", so asking it first would hand a PiP or a subframe of a
// free foreground connection the lease. Breaks if a lease call moves above the frame
// checks, or if a missing `ctx` is read as permissive.
//
// A CHECK is a status query and never takes a lease. Under 'bound-primary-main-frame'
// it answers (a)-(d); under 'holder' it also requires (e) without the legacy branch.
//
// Off-document checks (`wc === null`) never reach this arbiter: connectionSession.ts
// denies capture there itself (RC-5). No `setDisplayMediaRequestHandler` is installed:
// T0 measured that `getDisplayMedia` and `chromeMediaSource: 'desktop'` both reach the
// permission REQUEST handler as `display-capture`, so this gate already covers them.

import type { ConnectionRef } from '../shared/connectionIdentity';
import { isHolder, legacyAcquire } from './captureLease';
import { recordFor } from './connectionRegistry';
import {
  defaultCaptureArbiter,
  setCaptureArbiter,
  type ArbiterContext,
  type CaptureArbiter,
} from './connectionSession';

export type CaptureCheckPolicy = 'bound-primary-main-frame' | 'holder';

/**
 * Task 0, row 1 (desktop/spikes/capture-gate/results/macos-arm64.md § Decisions): the
 * check answer only affects `enumerateDevices` labels and `permissions.query`, and a
 * request still fires when the check says `false`, so the check may answer for any
 * current bound primary main frame. On the T0-FAIL branch this would be 'holder'.
 */
export const CAPTURE_CHECK_POLICY: CaptureCheckPolicy = 'bound-primary-main-frame';

export const CAPTURE_PERMISSIONS = ['media', 'display-capture'] as const;

const CAPTURE_SET: ReadonlySet<string> = new Set(CAPTURE_PERMISSIONS);

/** The ref names the live record's current generation. */
function isCurrent(ref: ConnectionRef): boolean {
  const record = recordFor(ref.connectionId);
  return (
    record !== undefined && record.state !== 'disposed' && record.generation === ref.generation
  );
}

/** (a)-(d) of the module invariant. */
function isCurrentPrimaryMainFrame(
  ref: ConnectionRef | null,
  ctx: ArbiterContext | undefined
): ref is ConnectionRef {
  if (ref === null || ctx === undefined) return false;
  if (ctx.role !== 'primary' || ctx.isMainFrame !== true) return false;
  return isCurrent(ref);
}

/**
 * `policy` defaults to {@link CAPTURE_CHECK_POLICY}; the parameter exists so both
 * branches are testable (a module-local const cannot be stubbed from outside).
 */
export function captureLeaseArbiter(
  fallback: CaptureArbiter,
  policy: CaptureCheckPolicy = CAPTURE_CHECK_POLICY
): CaptureArbiter {
  return Object.freeze({
    decide(
      ref: ConnectionRef | null,
      permission: string,
      details: unknown,
      ctx?: ArbiterContext
    ): boolean {
      if (!CAPTURE_SET.has(permission)) return fallback.decide(ref, permission, details, ctx);
      if (!isCurrentPrimaryMainFrame(ref, ctx)) return false;
      if (ctx?.phase === 'check') {
        return policy === 'bound-primary-main-frame' || isHolder(ref);
      }
      if (ctx?.phase !== 'request') return false;
      if (isHolder(ref)) return true;
      // §5.2: the legacy gate exists only on the T0-PASS branch.
      return policy === 'bound-primary-main-frame' && legacyAcquire(ref);
    },
  });
}

/** Install once, in `app.whenReady`. Returns the uninstall (restores the default). */
export function installCaptureLeaseArbiter(): () => void {
  return setCaptureArbiter(captureLeaseArbiter(defaultCaptureArbiter));
}

/**
 * Capture-lease revocation handler (#87 §3.8). Installed once at boot by `App`.
 *
 * `moved`: another connection was granted the microphone, so this call is over. The
 * notice is set FIRST, so `emergencyCleanup()` → `voiceStore.reset()` (which preserves
 * it) cannot be observed without it; the rejoin generation is advanced and the pending
 * rejoin cleared before the cleanup, so no queued rejoin can start capture again. There
 * is no automatic rejoin.
 *
 * `backgrounded`: only a device test held the lease. The call, if any, is untouched.
 */
import { advanceVoiceActionGeneration } from './voiceActionGeneration';
import {
  dispatchCaptureRevoked,
  release,
  noteDeviceTestRevoked,
  settleDeviceCaptures,
  withholdReleases,
  subscribeLeaseRevoked,
  subscribeLeaseState,
} from './captureLeaseClient';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import { useConnectionStore } from '../../stores/ui/connectionStore';

/** Well inside main's 5 s acknowledgement window. */
const DEVICE_CAPTURE_SETTLE_MS = 1500;

function releaseAll(): void {
  void release('voice-join');
  void release('device-test');
  useVoiceStore.getState().setCaptureLease('none');
}

/** True from the revocation until its call and device-test teardown have both finished. */
let revokeInFlight = false;
/**
 * Set when the teardown failed or a device capture never settled. The 5 s crash is meant to
 * replace this document, so a later lease push (the user switching back to this connection
 * pushes one) must not lift the withhold and let a Leave or a recovery release pass as the ack.
 */
let holdUntilReload = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
/** Above main's 5 s acknowledgement timeout plus the reload: a document still here is not crashing. */
const HOLD_BOUND_MS = 8000;

function holdAcknowledgement(): void {
  holdUntilReload = true;
  withholdReleases(true);
  clearTimeout(holdTimer);
  // If main never crashed this document (the handoff was cancelled), releases must work again.
  holdTimer = setTimeout(() => {
    holdUntilReload = false;
    if (!revokeInFlight) withholdReleases(false);
  }, HOLD_BOUND_MS);
}

async function handleMoved(): Promise<void> {
  // Any release from this document is the ack main reads, so none may leave before the call
  // and the device tests have stopped. Withheld from the first line: the dynamic import
  // below is a real gap in which a stopping mic test or a finished webcam probe would
  // otherwise release on its own. The lease push that follows the revocation must not lift
  // it either (see the subscriber).
  revokeInFlight = true;
  withholdReleases(true);
  try {
    useVoiceStore.getState().setCaptureMovedNotice(true);
    advanceVoiceActionGeneration();
    useConnectionStore.getState().setPendingVoiceRejoin(null);
    let tornDown = true;
    try {
      // Lazy, like the other voice consumers: the voice chunk stays out of the boot graph.
      const { voiceService } = await import('./voiceService');
      // Keep the lease: a camera test running beside the call is stopped by the dispatch
      // below, and the release must follow that, not precede it.
      voiceService.emergencyCleanup({ keepCaptureLease: true });
    } catch {
      tornDown = false;
      // Message-only: an error object can carry ids or tokens.
      console.warn('[capture] call teardown after a moved revocation failed');
    }
    dispatchCaptureRevoked('moved');
    // A webcam probe or test still opening the camera must settle (its own continuation stops
    // the stream) before the acknowledgement lets main grant the next holder.
    const settled = tornDown && (await settleDeviceCaptures(DEVICE_CAPTURE_SETTLE_MS));
    // Without a clean teardown nothing is released, so main's 5 s crash ends this document.
    if (settled) withholdReleases(false);
    else holdAcknowledgement();
    releaseAll();
  } finally {
    revokeInFlight = false;
  }
}

async function handleBackgrounded(): Promise<void> {
  // Only a device test held the lease; its release is the ack, so it waits for any capture
  // still opening just like the moved path.
  revokeInFlight = true;
  withholdReleases(true);
  try {
    dispatchCaptureRevoked('backgrounded');
    if (await settleDeviceCaptures(DEVICE_CAPTURE_SETTLE_MS)) {
      withholdReleases(false);
      void release('device-test');
    } else {
      holdAcknowledgement();
    }
    useVoiceStore.getState().setCaptureLease('none');
  } finally {
    revokeInFlight = false;
  }
}

export function installCaptureRevocationHandler(): () => void {
  revokeInFlight = false;
  holdUntilReload = false;
  clearTimeout(holdTimer);
  // A previous install may have been torn down mid-withhold; nothing else would lift it.
  withholdReleases(false);
  const stopLease = subscribeLeaseState((view) => {
    // The push that follows a moved revocation arrives while its teardown is still running.
    if (!revokeInFlight && !holdUntilReload) withholdReleases(false);
    useVoiceStore.getState().setCaptureLease(view);
  });
  const stopRevoked = subscribeLeaseRevoked(({ reason }) => {
    // Synchronously, before any await below: main already ended the device-test claim, so a
    // test granted from here on must read the new epoch.
    noteDeviceTestRevoked();
    if (reason === 'moved') void handleMoved();
    else void handleBackgrounded();
  });
  return () => {
    stopLease();
    stopRevoked();
    clearTimeout(holdTimer);
    revokeInFlight = false;
    holdUntilReload = false;
    withholdReleases(false);
  };
}

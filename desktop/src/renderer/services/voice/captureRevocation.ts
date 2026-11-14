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
  withholdReleases,
  subscribeLeaseRevoked,
  subscribeLeaseState,
} from './captureLeaseClient';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import { useConnectionStore } from '../../stores/ui/connectionStore';

function releaseAll(): void {
  void release('voice-join');
  void release('device-test');
  useVoiceStore.getState().setCaptureLease('none');
}

/** True from the revocation until its call and device-test teardown have both finished. */
let movedInFlight = false;

async function handleMoved(): Promise<void> {
  // Any release from this document is the ack main reads, so none may leave before the call
  // and the device tests have stopped. Withheld from the first line: the dynamic import
  // below is a real gap in which a stopping mic test or a finished webcam probe would
  // otherwise release on its own. The lease push that follows the revocation must not lift
  // it either (see the subscriber).
  movedInFlight = true;
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
    // After a failed teardown the withhold stays, so the releases below go nowhere and the
    // 5 s crash ends this document.
    if (tornDown) withholdReleases(false);
    releaseAll();
  } finally {
    movedInFlight = false;
  }
}

function handleBackgrounded(): void {
  dispatchCaptureRevoked('backgrounded');
  void release('device-test');
  useVoiceStore.getState().setCaptureLease('none');
}

export function installCaptureRevocationHandler(): () => void {
  const stopLease = subscribeLeaseState((view) => {
    // The push that follows a moved revocation arrives while its teardown is still running.
    if (!movedInFlight) withholdReleases(false);
    useVoiceStore.getState().setCaptureLease(view);
  });
  const stopRevoked = subscribeLeaseRevoked(({ reason }) => {
    if (reason === 'moved') void handleMoved();
    else handleBackgrounded();
  });
  return () => {
    stopLease();
    stopRevoked();
  };
}

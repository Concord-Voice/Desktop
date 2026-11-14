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

async function handleMoved(): Promise<void> {
  useVoiceStore.getState().setCaptureMovedNotice(true);
  advanceVoiceActionGeneration();
  useConnectionStore.getState().setPendingVoiceRejoin(null);
  let tornDown = true;
  try {
    // Lazy, like the other voice consumers: the voice chunk stays out of the boot graph.
    const { voiceService } = await import('./voiceService');
    voiceService.emergencyCleanup();
  } catch {
    tornDown = false;
    // Message-only: an error object can carry ids or tokens.
    console.warn('[capture] call teardown after a moved revocation failed');
  }
  // After a failed teardown no release may leave (main reads any as the ack), including the
  // stopping device tests': the 5 s crash then ends this document instead.
  if (!tornDown) withholdReleases(true);
  dispatchCaptureRevoked('moved');
  releaseAll();
}

function handleBackgrounded(): void {
  dispatchCaptureRevoked('backgrounded');
  void release('device-test');
  useVoiceStore.getState().setCaptureLease('none');
}

export function installCaptureRevocationHandler(): () => void {
  const stopLease = subscribeLeaseState((view) => {
    withholdReleases(false);
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

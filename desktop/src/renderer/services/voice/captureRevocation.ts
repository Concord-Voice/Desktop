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
  subscribeLeaseRevoked,
  subscribeLeaseState,
} from './captureLeaseClient';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import { useConnectionStore } from '../../stores/ui/connectionStore';

/**
 * `keepVoiceJoin` holds back the `voice-join` release after a failed teardown: main reads
 * that release as the ack, so sending it would grant the lease while this call's tracks may
 * still be live. Without the ack, the 5 s timeout crashes this renderer instead.
 */
function releaseAll(keepVoiceJoin: boolean): void {
  if (!keepVoiceJoin) void release('voice-join');
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
  dispatchCaptureRevoked('moved');
  releaseAll(!tornDown);
}

function handleBackgrounded(): void {
  dispatchCaptureRevoked('backgrounded');
  void release('device-test');
  useVoiceStore.getState().setCaptureLease('none');
}

export function installCaptureRevocationHandler(): () => void {
  const stopLease = subscribeLeaseState((view) => {
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

import { useState, useRef, useCallback, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import {
  acquire,
  currentDeviceTestEpoch,
  release,
  captureLeaseMessage,
  captureRevokedEvents,
  CAPTURE_REVOKED_EVENT,
} from '../../services/voice/captureLeaseClient';
import type { DeviceTestStoppedReason } from './useMicTest';

const VOICE_CALL_CONNECTION_STATES = new Set(['connected', 'connecting', 'reconnecting']);

function isInVoiceCall(connectionState: string): boolean {
  return VOICE_CALL_CONNECTION_STATES.has(connectionState);
}

interface UseCameraTestReturn {
  isTesting: boolean;
  error: string | null;
  stoppedReason: DeviceTestStoppedReason;
  stream: MediaStream | null;
  toggleTest: () => Promise<void>;
  stopTest: () => void;
}

/**
 * Toggles a live camera preview for the Settings device panel. Acquires a
 * MediaStream from the currently-selected video input via getUserMedia and
 * exposes it for inline <video> rendering. Guarantees all tracks are stopped
 * on toggle-off and on unmount so no MediaStreamTracks leak.
 *
 * #87: the `device-test` capture lease is acquired before getUserMedia and
 * released when the preview stops; a revoked lease stops the preview.
 */
export function useCameraTest(): UseCameraTestReturn {
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stoppedReason, setStoppedReason] = useState<DeviceTestStoppedReason>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  const leaseHeldRef = useRef(false);
  // The revocation epoch read just before the held claim was asked for (see release()).
  const leaseEpochRef = useRef(0);

  const releaseLease = useCallback(() => {
    if (!leaseHeldRef.current) return;
    leaseHeldRef.current = false;
    void release('device-test', leaseEpochRef.current);
  }, []);

  const stopTest = useCallback(() => {
    generationRef.current++;
    pendingRef.current = false;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    releaseLease();
    setStream(null);
    setIsTesting(false);
    setStoppedReason(null);
  }, [releaseLease]);

  const startTest = useCallback(
    async (generation: number) => {
      setError(null);
      setStoppedReason(null);
      const leaseEpoch = currentDeviceTestEpoch();
      const lease = await acquire('device-test');
      if (generation !== generationRef.current) {
        // Stopped while main answered. This grant owns nothing: give its count back. A
        // successor's own acquire is already counted, so the claim survives for it.
        if (lease.status === 'granted') void release('device-test', leaseEpoch);
        return;
      }
      if (lease.status !== 'granted') {
        pendingRef.current = false;
        if (lease.status === 'held') setStoppedReason('held');
        else setError(captureLeaseMessage(lease.status === 'rejected' ? lease.reason : 'unknown'));
        return;
      }
      leaseHeldRef.current = true;
      leaseEpochRef.current = leaseEpoch;
      try {
        const deviceId = useVoiceStore.getState().videoDeviceId;
        const next = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (generation !== generationRef.current) {
          for (const track of next.getTracks()) track.stop();
          return;
        }
        streamRef.current = next;
        setStream(next);
        setIsTesting(true);
      } catch (err) {
        if (generation !== generationRef.current) return;
        releaseLease();
        const msg =
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access denied'
            : 'Failed to access camera';
        setError(msg);
        setIsTesting(false);
      } finally {
        if (generation === generationRef.current) pendingRef.current = false;
      }
    },
    [releaseLease]
  );

  const toggleTest = useCallback(async () => {
    if (streamRef.current || pendingRef.current) {
      stopTest();
      return;
    }
    const generation = ++generationRef.current;
    pendingRef.current = true;
    await startTest(generation);
  }, [startTest, stopTest]);

  useEffect(() => {
    const unsubscribe = useVoiceStore.subscribe((state, prev) => {
      const callStarted =
        !isInVoiceCall(prev.connectionState) && isInVoiceCall(state.connectionState);
      if (state.videoDeviceId !== prev.videoDeviceId || callStarted) stopTest();
    });
    const onCaptureRevoked = (event: Event) => {
      if (!streamRef.current && !pendingRef.current) return;
      const reason: unknown = event instanceof CustomEvent ? event.detail : undefined;
      stopTest();
      if (reason === 'backgrounded') setStoppedReason('backgrounded');
    };
    captureRevokedEvents.addEventListener(CAPTURE_REVOKED_EVENT, onCaptureRevoked);
    return () => {
      unsubscribe();
      captureRevokedEvents.removeEventListener(CAPTURE_REVOKED_EVENT, onCaptureRevoked);
      stopTest();
    };
  }, [stopTest]);

  return { isTesting, error, stoppedReason, stream, toggleTest, stopTest };
}
